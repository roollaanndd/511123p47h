// b2bBulk.ts — B2B bulk fleet TLO import (multifinance block business).
//
// A B2B client (e.g. a multifinance company) uploads a spreadsheet of
// financed vehicles that all need TLO cover. The browser parses the file
// and rates every row locally (services/b2bFleetRating.ts) so the review
// screen can show instant feedback, but none of that is trusted here:
// b2b_bulk_create_batch recomputes every premium from the classification
// inputs (vehicleClass/zone/commercialBody/financingValue/otr/tenor) with
// the Deno mirror of the same engine before anything is persisted. Money
// numbers never come from the client; only the categorical judgment calls
// (zone/vehicle class/commercial body — things a human can see and
// override in the review grid) do.
import type { GatewayContext, ActionResult } from './types.ts';
import {
  calcBulkPremium, calcBulkTotals, isValidIsoDate, addMonthsToIsoDate,
  MULTI_YEAR_DEPRECIATION_RATE, MULTI_YEAR_MAX_TENOR_MONTHS,
  type VehicleClass, type Zone, type BulkPremiumResult, type FleetCoverage,
  type FleetAddOns,
} from '../../_shared/b2bFleetRating.ts';
import { safeError } from '../../_shared/errorMap.ts';
import { loadActiveBulkRateConfig } from './b2bSettings.ts';
import { logB2BActivity } from '../../_shared/b2bActivityLog.ts';
import {
  MAX_BATCH_ROWS, buildUnitPolicyNumbers, describeExpiredPolicyCopies, expiredPolicyCopyRowIds,
  normalizePolicyNumber, reconcileBatchTotal, type PolicyNumberRow, type UnitPolicyAssignment,
} from '../../_shared/b2bBatchIntegrity.ts';

const json = (body: unknown, status = 200): ActionResult => ({ status, body });
const ok = (data: unknown): ActionResult => json({ data });
const err = (message: string, status = 400): ActionResult => json({ error: message }, status);

const VEHICLE_CLASSES: VehicleClass[] = ['MOTORCYCLE', 'CAR', 'HEAVY_EQUIPMENT'];
const ZONES: Zone[] = [1, 2, 3];

interface ClientItemInput {
  rowNo: number;
  nasabahName: string;
  nasabahKtp?: string;
  nasabahPhone?: string;
  nasabahAddress?: string;
  contractNo?: string;
  contractDate?: string;
  tenorMonths: number;
  financingValue: number;
  vehicleClass: VehicleClass;
  commercialBody?: boolean;
  make?: string;
  model?: string;
  modelYear?: number;
  otr?: number;
  plateNo?: string;
  chassisNo?: string;
  engineNo?: string;
  bpkbNo?: string;
  regionText?: string;
  zone: Zone;
  flags?: string[];
  // Order unit (v2.8.23) — semuanya opsional; baris impor massal tidak
  // mengirimnya dan diperlakukan persis seperti sebelumnya.
  coverageStartDate?: string;      // "YYYY-MM-DD", tanggal efektif pertanggungan
  multiYearDepreciation?: boolean; // true → TSI menyusut 10%/tahun (rate dari server)
  discountRate?: number;           // diskon pilihan klien; dijepit ke diskon rate set
  discountShownOnPolicy?: boolean; // diskon dicetak di polis atau tidak
  coverage?: FleetCoverage;        // v2.8.24 — 'COMPREHENSIVE' hanya mobil & motor; bawaan TLO
  // v2.9.1 — perluasan, paket, foto kendaraan (order unit saja).
  addons?: FleetAddOns;
  planId?: string | null;          // id paket sp_b2b_plans, server yang resolve loading_rate
  vehiclePhotos?: Array<{ slot: string; url: string; size_bytes?: number }>;
  // v2.9.13 — kondisi unit & copy polis. Hanya dikirim order satuan; impor
  // massal memakai default BEKAS / NULL.
  vehicleCondition?: 'BARU' | 'BEKAS';
  policyCopyExpiry?: string;       // YYYY-MM-DD, harus >= hari pengajuan
}

// Tanggal efektif boleh hari ini s/d 60 hari ke depan. Sehari kelonggaran di
// kedua ujung karena "hari ini" klien (WIB/WITA/WIT) bisa sudah lewat tengah
// malam sementara server masih di tanggal UTC sebelumnya.
const COVERAGE_START_MAX_DAYS_AHEAD = 60;
function coverageStartError(iso: string): string | null {
  if (!isValidIsoDate(iso)) return 'tanggal efektif tidak valid (format YYYY-MM-DD).';
  const dayMs = 86_400_000;
  const todayUtc = Math.floor(Date.now() / dayMs) * dayMs;
  const start = Date.parse(`${iso}T00:00:00Z`);
  if (start < todayUtc - dayMs) return 'tanggal efektif tidak boleh di masa lalu.';
  if (start > todayUtc + (COVERAGE_START_MAX_DAYS_AHEAD + 1) * dayMs) {
    return `tanggal efektif paling jauh ${COVERAGE_START_MAX_DAYS_AHEAD} hari dari hari ini.`;
  }
  return null;
}

function validateItem(raw: unknown, index: number): { item: ClientItemInput; error?: string } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: `Baris ${index + 1}: data tidak valid.` };
  const r = raw as Record<string, unknown>;
  const nasabahName = String(r.nasabahName ?? '').trim();
  if (!nasabahName) return { error: `Baris ${index + 1}: nama nasabah wajib diisi.` };
  const vehicleClass = String(r.vehicleClass ?? '') as VehicleClass;
  if (!VEHICLE_CLASSES.includes(vehicleClass)) return { error: `Baris ${index + 1}: jenis kendaraan tidak valid.` };
  const zone = Number(r.zone) as Zone;
  if (!ZONES.includes(zone)) return { error: `Baris ${index + 1}: zona tidak valid.` };
  const financingValue = Number(r.financingValue);
  if (!Number.isFinite(financingValue) || financingValue <= 0) return { error: `Baris ${index + 1}: nilai pencairan/pembiayaan tidak valid.` };
  const tenorMonths = Number(r.tenorMonths) || 12;
  const otr = Number(r.otr) || 0;

  const coverageStartDate = r.coverageStartDate ? String(r.coverageStartDate).trim() : undefined;
  if (coverageStartDate) {
    const dateErr = coverageStartError(coverageStartDate);
    if (dateErr) return { error: `Baris ${index + 1}: ${dateErr}` };
  }
  const multiYearDepreciation = r.multiYearDepreciation === true;
  if (multiYearDepreciation && tenorMonths > MULTI_YEAR_MAX_TENOR_MONTHS) {
    return { error: `Baris ${index + 1}: jangka waktu maksimum ${MULTI_YEAR_MAX_TENOR_MONTHS / 12} tahun.` };
  }
  const coverageRaw = String(r.coverage ?? 'TLO').toUpperCase();
  if (coverageRaw !== 'TLO' && coverageRaw !== 'COMPREHENSIVE') {
    return { error: `Baris ${index + 1}: jenis pertanggungan tidak valid.` };
  }
  if (coverageRaw === 'COMPREHENSIVE' && vehicleClass === 'HEAVY_EQUIPMENT') {
    return { error: `Baris ${index + 1}: alat berat hanya tersedia dengan pertanggungan TLO.` };
  }
  let discountRate: number | undefined;
  if (r.discountRate !== undefined && r.discountRate !== null && r.discountRate !== '') {
    discountRate = Number(r.discountRate);
    if (!Number.isFinite(discountRate) || discountRate < 0 || discountRate > 1) {
      return { error: `Baris ${index + 1}: diskon tidak valid.` };
    }
  }

  // Perluasan (opsional). Alat berat mengabaikannya di calcBulkPremium —
  // tetap kita terima dan simpan agar admin bisa melihat apa yang diminta.
  let addons: FleetAddOns | undefined;
  if (r.addons && typeof r.addons === 'object') {
    const a = r.addons as Record<string, unknown>;
    addons = {
      flood: a.flood === true,
      earthquake: a.earthquake === true,
      srcc: a.srcc === true,
      terrorism: a.terrorism === true,
      authorizedWorkshop: a.authorizedWorkshop === true,
      paDriver: a.paDriver === true,
      tplLimit: Math.max(0, Math.round(Number(a.tplLimit) || 0)),
      paPassengerSeats: Math.max(0, Math.min(7, Math.round(Number(a.paPassengerSeats) || 0))),
    };
  }

  const planId = r.planId ? String(r.planId).trim() : null;
  // Foto kendaraan: hanya URL + slot — URL harus diawali https:// supabase
  // storage; sisanya ditolak agar tidak mengarah ke sumber tak dikenal.
  const vehiclePhotos: Array<{ slot: string; url: string; size_bytes?: number }> = [];
  if (Array.isArray(r.vehiclePhotos)) {
    for (const p of r.vehiclePhotos) {
      if (!p || typeof p !== 'object') continue;
      const pr = p as Record<string, unknown>;
      const slot = String(pr.slot ?? '').trim().slice(0, 40);
      const url = String(pr.url ?? '').trim();
      if (!slot || !url) continue;
      if (!/^https:\/\//i.test(url)) continue;
      const size = Number(pr.size_bytes);
      vehiclePhotos.push({ slot, url, size_bytes: Number.isFinite(size) ? size : undefined });
      if (vehiclePhotos.length >= 12) break;
    }
  }

  // v2.9.13 — aturan baru HANYA untuk order satuan (yang mengirim array
  // vehiclePhotos). Baris impor massal tidak mengirimnya dan tetap lewat.
  // Impor massal tidak mengirim `vehicleCondition`; order satuan selalu
  // mengirimnya. Attachment saja tidak cukup untuk mengubah perilaku lama.
  const isUnitOrder = r.vehicleCondition !== undefined;
  let vehicleCondition: 'BARU' | 'BEKAS' = 'BEKAS';
  if (r.vehicleCondition !== undefined) {
    const c = String(r.vehicleCondition).toUpperCase();
    if (c !== 'BARU' && c !== 'BEKAS') {
      return { error: `Baris ${index + 1}: kondisi kendaraan tidak valid.` };
    }
    vehicleCondition = c as 'BARU' | 'BEKAS';
  }
  let policyCopyExpiry: string | undefined;
  if (r.policyCopyExpiry) {
    const s = String(r.policyCopyExpiry).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
      return { error: `Baris ${index + 1}: tanggal berlaku copy polis tidak valid.` };
    }
    const todayUtc = new Date().toISOString().slice(0, 10);
    if (s < todayUtc) {
      return { error: `Baris ${index + 1}: copy polis harus masih berlaku (tanggal berlaku hari ini atau setelahnya).` };
    }
    policyCopyExpiry = s;
  }
  const hasPolicyCopy = vehiclePhotos.some(p => p.slot === 'copy-polis');
  if (hasPolicyCopy && !policyCopyExpiry) {
    return { error: `Baris ${index + 1}: copy polis wajib mencantumkan tanggal masih berlaku.` };
  }
  if (policyCopyExpiry && !hasPolicyCopy) {
    return { error: `Baris ${index + 1}: tanggal copy polis tanpa lampiran copy polis.` };
  }
  if (isUnitOrder && vehicleClass !== 'HEAVY_EQUIPMENT') {
    const newDoc = vehiclePhotos.some(p => p.slot === 'bstk' || p.slot === 'faktur');
    const photoCount = vehiclePhotos.filter(p => /^(depan|belakang|rangka|samping-)/.test(p.slot)).length;
    if (vehicleCondition === 'BARU' && !newDoc) {
      return { error: `Baris ${index + 1}: kendaraan baru wajib melampirkan BSTK atau faktur kendaraan.` };
    }
    if (vehicleCondition === 'BEKAS' && photoCount < 3) {
      return { error: `Baris ${index + 1}: kendaraan bekas wajib melampirkan minimal 3 foto (depan, belakang, nomor rangka).` };
    }
  }

  return {
    item: {
      rowNo: Number(r.rowNo) || index + 1,
      nasabahName,
      nasabahKtp: r.nasabahKtp ? String(r.nasabahKtp) : undefined,
      nasabahPhone: r.nasabahPhone ? String(r.nasabahPhone) : undefined,
      nasabahAddress: r.nasabahAddress ? String(r.nasabahAddress) : undefined,
      contractNo: r.contractNo ? String(r.contractNo) : undefined,
      contractDate: r.contractDate ? String(r.contractDate) : undefined,
      tenorMonths,
      financingValue,
      vehicleClass,
      commercialBody: Boolean(r.commercialBody),
      make: r.make ? String(r.make) : undefined,
      model: r.model ? String(r.model) : undefined,
      modelYear: r.modelYear ? Number(r.modelYear) : undefined,
      otr,
      plateNo: r.plateNo ? String(r.plateNo) : undefined,
      chassisNo: r.chassisNo ? String(r.chassisNo) : undefined,
      engineNo: r.engineNo ? String(r.engineNo) : undefined,
      bpkbNo: r.bpkbNo ? String(r.bpkbNo) : undefined,
      regionText: r.regionText ? String(r.regionText) : undefined,
      zone,
      flags: Array.isArray(r.flags) ? r.flags.map(String) : [],
      coverageStartDate,
      multiYearDepreciation,
      discountRate,
      // Tanpa pilihan eksplisit, diskon tetap tertera — sama seperti semua
      // batch sebelum v2.8.23.
      discountShownOnPolicy: r.discountShownOnPolicy === undefined ? true : r.discountShownOnPolicy === true,
      coverage: coverageRaw as FleetCoverage,
      addons,
      planId,
      vehiclePhotos,
      vehicleCondition,
      policyCopyExpiry,
    },
  };
}

export async function handleB2BBulkAction(action: string, ctx: GatewayContext): Promise<ActionResult | null> {
  const { db, params, caller } = ctx;

  switch (action) {
    // ── Client: create a batch from reviewed rows ──────────────────────────
    case 'b2b_bulk_create_batch': {
      if (caller.role !== 'B2B_CLIENT' && !caller.isAdmin) return err('Forbidden: B2B client only', 403);
      const clientId = caller.spUser?.id;
      if (!clientId) return err('No B2B profile', 403);

      // v2.9.28 — batas laju per klien. Setiap batch memuat set tarif aktif
      // dan menghitung ulang premi tiap baris (mahal), lalu menulis hingga
      // MAX_BATCH_ROWS baris. Tanpa batas, satu akun bisa mengunci fungsi
      // dengan mengulang kiriman besar.
      const allowed = await ctx.checkRateLimit(`b2b:${clientId}`, 30);
      if (!allowed) return err('Terlalu banyak pengajuan batch dalam satu jam. Coba lagi nanti.', 429);

      const rawItems: unknown[] = Array.isArray(params.items) ? params.items : [];
      if (rawItems.length === 0) return err('items tidak boleh kosong', 400);
      if (rawItems.length > MAX_BATCH_ROWS) return err(`Maksimum ${MAX_BATCH_ROWS} baris per batch`, 400);

      // Nama perusahaan diambil dari parameter, lalu fallback ke profil B2B
      // pemanggil. Order unit (satu baris) tidak punya field perusahaan di
      // form — perusahaan sudah terikat ke akun. Bila semuanya kosong kita
      // pakai nama pemilik akun daripada menolak orderan.
      const companyName = String(
        params.company_name
        ?? caller.spUser?.company_name
        ?? caller.spUser?.name
        ?? 'Klien B2B',
      ).trim() || 'Klien B2B';
      const sourceFileName = params.source_file_name ? String(params.source_file_name).slice(0, 255) : null;
      // v2.9.12 — provenance file sumber. Frontend mengunggah file asli ke
      // b2b-documents SEBELUM memanggil aksi ini dan mengirim PATH storage-nya
      // (bucket privat — path, bukan URL). Tanpa ini file asli jadi yatim:
      // tersimpan di bucket tapi alamatnya tidak terekam di mana pun.
      const sourceFilePath = params.source_file_path ? String(params.source_file_path).trim() : null;
      const sourceFileSize = Number.isFinite(Number(params.source_file_size))
        ? Math.round(Number(params.source_file_size)) : null;
      const sourceFileMime = params.source_file_mime ? String(params.source_file_mime).slice(0, 100) : null;

      // v2.9.7 — preferensi asuransi dari klien. Diverifikasi ke sp_insurers
      // agar tidak nyampah kolom notes dengan ID hantu; namanya saja yang
      // disimpan (ke kolom notes yang sudah ada) sehingga admin melihatnya
      // waktu meng-assign insurer. Status insurer harus aktif.
      let preferredInsurerNote: string | null = null;
      if (params.preferred_insurer_id) {
        const { data: insurer } = await db
          .from('sp_insurers')
          .select('id, name, is_active')
          .eq('id', String(params.preferred_insurer_id))
          .maybeSingle();
        if (insurer && insurer.is_active) {
          preferredInsurerNote = `Pilihan asuransi klien: ${insurer.name}`;
        }
      }

      const validated: ClientItemInput[] = [];
      for (let i = 0; i < rawItems.length; i++) {
        const v = validateItem(rawItems[i], i);
        if ('error' in v && !('item' in v)) return err(v.error, 400);
        validated.push((v as { item: ClientItemInput }).item);
      }

      // Authoritative recompute — never trust client-supplied money figures.
      // Loads whatever admin-edited rate set is currently active (or leaves
      // the built-in defaults if none is) before pricing a single row.
      await loadActiveBulkRateConfig(db);

      // Paket asuransi — resolve loading_rate dari sp_b2b_plans setelah
      // mengumpulkan semua id unik agar hanya satu query.
      const planIds = Array.from(new Set(validated.map(v => v.planId).filter((x): x is string => !!x)));
      const planMap = new Map<string, { id: string; loading_rate: number; code: string; name: string }>();
      if (planIds.length > 0) {
        const { data: plans } = await db
          .from('sp_b2b_plans')
          .select('id, loading_rate, code, name, is_active')
          .in('id', planIds);
        for (const p of plans ?? []) {
          if (!p.is_active) continue;
          planMap.set(p.id, p);
        }
      }

      const rated = validated.map(it => {
        const plan = it.planId ? planMap.get(it.planId) ?? null : null;
        const premium: BulkPremiumResult = calcBulkPremium({
          vehicleClass: it.vehicleClass,
          zone: it.zone,
          financingValue: it.financingValue,
          otr: it.otr ?? 0,
          tenorMonths: it.tenorMonths,
          commercialBodyHint: it.commercialBody,
          // Klien hanya memilih YA/TIDAK; besar penyusutan ditentukan server.
          depreciationRate: it.multiYearDepreciation ? MULTI_YEAR_DEPRECIATION_RATE : 0,
          // calcBulkPremium menjepit ini ke 0..diskon rate set aktif.
          discountRateOverride: it.discountRate,
          coverage: it.coverage,
          addons: it.addons,
          planLoadingRate: plan ? Number(plan.loading_rate) : 0,
        });
        return { ...it, plan, premium };
      });

      const totals = calcBulkTotals(rated.map(r => r.premium));

      const { data: batch, error: batchErr } = await db.from('sp_b2b_batches').insert({
        client_id: clientId,
        company_name: companyName,
        source_file_name: sourceFileName,
        source_file_path: sourceFilePath,
        source_file_size: sourceFileSize,
        source_file_mime: sourceFileMime,
        item_count: totals.itemCount,
        total_premium_gross: totals.totalPremiumGross,
        total_discount: totals.totalDiscount,
        total_premium_net: totals.totalPremiumNet,
        total_admin_fee: totals.totalAdminFee,
        total_amount: totals.totalAmount,
        status: 'SUBMITTED',
        notes: preferredInsurerNote,
      }).select().single();
      if (batchErr) { const _err = safeError(batchErr); return err(_err.body.error, _err.status); }

      const itemRows = rated.map(r => ({
        batch_id: batch.id,
        row_no: r.rowNo,
        nasabah_name: r.nasabahName,
        nasabah_ktp: r.nasabahKtp ?? null,
        nasabah_phone: r.nasabahPhone ?? null,
        nasabah_address: r.nasabahAddress ?? null,
        contract_no: r.contractNo ?? null,
        contract_date: r.contractDate || null,
        tenor_months: r.tenorMonths,
        financing_value: r.financingValue,
        vehicle_class: r.vehicleClass,
        make: r.make ?? null,
        model: r.model ?? null,
        model_year: r.modelYear ?? null,
        otr: r.otr ?? null,
        plate_no: r.plateNo ?? null,
        chassis_no: r.chassisNo ?? null,
        engine_no: r.engineNo ?? null,
        bpkb_no: r.bpkbNo ?? null,
        region_text: r.regionText ?? null,
        zone: r.zone,
        coverage_type: r.premium.coverage,
        rate: r.premium.rate,
        premium_gross: r.premium.premiumGross,
        discount_rate: r.premium.discountRate,
        discount_amount: r.premium.discountAmount,
        premium_after_discount: r.premium.premiumAfterDiscount,
        admin_fee: r.premium.adminFee,
        total_premium: r.premium.totalPremium,
        flags: r.flags ?? [],
        status: 'PENDING',
        coverage_start_date: r.coverageStartDate ?? null,
        coverage_end_date: r.coverageStartDate ? addMonthsToIsoDate(r.coverageStartDate, r.tenorMonths) : null,
        depreciation_rate: r.premium.depreciationRate,
        premium_schedule: r.premium.schedule,
        discount_shown_on_policy: r.discountShownOnPolicy ?? true,
        addons: r.addons ?? {},
        addon_premium: r.premium.addonPremium,
        plan_id: r.plan?.id ?? null,
        plan_loading: r.premium.planLoading,
        vehicle_photos: (r.vehiclePhotos ?? []).map(p => ({
          slot: p.slot, url: p.url, size_bytes: p.size_bytes ?? null,
          uploaded_at: new Date().toISOString(),
        })),
        vehicle_condition: r.vehicleCondition ?? 'BEKAS',
        policy_copy_expiry: r.policyCopyExpiry ?? null,
      }));

      const { error: itemsErr } = await db.from('sp_b2b_batch_items').insert(itemRows);
      if (itemsErr) {
        // Roll back the header so a failed import doesn't leave an orphan batch.
        await db.from('sp_b2b_batches').delete().eq('id', batch.id);
        { const _err = safeError(itemsErr); return err(_err.body.error, _err.status); }
      }

      // v2.9.28 — rekonsiliasi header vs baris yang benar-benar tersimpan.
      // Total di header dihitung dari hasil rating server, tetapi satu bug
      // pemetaan kolom atau satu insert parsial akan membuat klien membayar
      // nominal yang tidak sama dengan jumlah polisnya. Baca balik dari DB
      // (bukan dari array di memori) dan batalkan batch bila tidak balance.
      // PostgREST caps a single select at 1,000 rows, so a 2,000-unit batch has
      // to be summed in pages — otherwise reconciliation compares the header
      // against half the fleet and rejects a perfectly good import.
      const PAGE = 1000;
      const persistedTotals: Array<{ total_premium: unknown }> = [];
      let totalErr: unknown = null;
      for (let offset = 0; offset < itemRows.length; offset += PAGE) {
        const { data: page, error } = await db
          .from('sp_b2b_batch_items')
          .select('total_premium')
          .eq('batch_id', batch.id)
          .order('row_no')
          .range(offset, offset + PAGE - 1);
        if (error) { totalErr = error; break; }
        persistedTotals.push(...(page ?? []));
        if ((page ?? []).length < PAGE) break;
      }
      const reconciliation = reconcileBatchTotal(
        Number(batch.total_amount),
        persistedTotals.map((row) => row.total_premium as number),
      );
      if (totalErr || !reconciliation.balanced) {
        console.error('b2b_bulk_create_batch: total reconciliation failed', {
          batch_id: batch.id, error: totalErr, reconciliation, item_count: itemRows.length,
        });
        await db.from('sp_b2b_batches').delete().eq('id', batch.id);
        return err('Total batch tidak konsisten dengan rincian unit. Impor dibatalkan; silakan coba lagi.', 500);
      }

      await db.from('sp_admin_notifications').insert({
        type: 'B2B_BULK_SUBMITTED',
        title: `Impor Massal B2B Baru — ${companyName}`,
        body: `${companyName} mengajukan ${totals.itemCount} unit${rated.every(r => r.premium.coverage === 'TLO') ? ' TLO' : ''}, total Rp ${totals.totalAmount.toLocaleString('id-ID')}.`,
        metadata: { batch_id: batch.id, batch_number: batch.batch_number },
        read: false,
      }).then(() => {}, () => {});

      // v2.9.12 — jejak khusus B2B (kaya konteks; tanpa PII).
      logB2BActivity(db, {
        clientId,
        batchId: batch.id,
        batchNumber: batch.batch_number,
        actorRole: caller.role,
        actorEmail: caller.email,
        action: 'bulk_batch_created',
        summary: `${companyName} mengajukan impor massal ${totals.itemCount} unit, total Rp ${totals.totalAmount.toLocaleString('id-ID')}.`,
        detail: {
          source_file_name: sourceFileName,
          source_file_path: sourceFilePath,
          source_file_size: sourceFileSize,
          item_count: totals.itemCount,
          total_premium_net: totals.totalPremiumNet,
          total_admin_fee: totals.totalAdminFee,
          total_amount: totals.totalAmount,
          preferred_insurer: preferredInsurerNote,
        },
        ip: ctx.reqIp,
        userAgent: ctx.reqUserAgent,
      });

      return ok({ batch, totals });
    }

    // ── Client/admin: list batches ──────────────────────────────────────────
    case 'b2b_bulk_list_batches': {
      let q = db.from('sp_b2b_batches').select('*').order('created_at', { ascending: false });
      if (caller.isAdmin && params.all) {
        // no filter — admin sees every batch
      } else {
        if (caller.role !== 'B2B_CLIENT' && !caller.isAdmin) return err('Forbidden', 403);
        const clientId = caller.spUser?.id;
        if (!clientId) return err('No B2B profile', 403);
        q = q.eq('client_id', clientId);
      }
      const { data, error } = await q;
      if (error) { const _err = safeError(error); return err(_err.body.error, _err.status); }

      // v2.9.25 — opt-in: ikut tandatangani master_policy_document_url utk
      // ISSUED batch, sehingga layar Dokumen bisa langsung memberi link unduh
      // tanpa satu panggilan tambahan per baris. Default perilaku lama (tidak
      // menandatangani) dipertahankan untuk pemanggil yang hanya butuh ID.
      //
      // v2.9.27 (audit-fix #2): fan-out ke Storage dibatasi 25 paralel.
      // Sebelumnya `Promise.all((data).map(async …))` meledakkan semua call
      // bersamaan. Klien dengan ratusan batch ISSUED akan membuka ratusan
      // koneksi Storage dari satu request edge function — budget koneksi fungsi
      // habis dan request lain diblokir. Menyerial dalam gelombang 25 menjaga
      // latensi (25 panggilan paralel ~ latensi satu panggilan Storage) tanpa
      // menguras pool koneksi.
      if (params.include_master_policy_url === true && data && data.length > 0) {
        const SIGN_CONCURRENCY = 25;
        const rows = data as any[];
        const withUrls: any[] = [];
        for (let i = 0; i < rows.length; i += SIGN_CONCURRENCY) {
          const wave = rows.slice(i, i + SIGN_CONCURRENCY);
          const signedWave = await Promise.all(wave.map(async (b: any) => {
            if (!b.master_policy_document_url || b.master_policy_document_url.startsWith('http')) {
              return { ...b, master_policy_signed_url: null };
            }
            const { data: signed } = await db.storage.from('b2b-documents').createSignedUrl(b.master_policy_document_url, 300);
            return { ...b, master_policy_signed_url: signed?.signedUrl ?? null };
          }));
          withUrls.push(...signedWave);
        }
        return ok(withUrls);
      }

      return ok(data ?? []);
    }

    // ── Client/admin: get one batch + its items ──────────────────────────────
    case 'b2b_bulk_get_batch': {
      const batchId = String(params.batch_id ?? '');
      if (!batchId) return err('batch_id required', 400);
      const { data: batch, error: batchErr } = await db.from('sp_b2b_batches').select('*').eq('id', batchId).maybeSingle();
      if (batchErr) { const _err = safeError(batchErr); return err(_err.body.error, _err.status); }
      if (!batch) return err('Batch not found', 404);
      if (!caller.isAdmin && batch.client_id !== caller.spUser?.id) return err('Forbidden', 403);

      const { data: items, error: itemsErr } = await db.from('sp_b2b_batch_items').select('*').eq('batch_id', batchId).order('row_no');
      if (itemsErr) { const _err = safeError(itemsErr); return err(_err.body.error, _err.status); }

      const { data: payment } = await db.from('sp_payments')
        .select('invoice_url, status, created_at')
        .eq('batch_id', batchId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      // master_policy_document_url holds a storage PATH (private bucket) —
      // resolve it to a short-lived signed URL here so the client/admin UI
      // has something that actually downloads. Legacy rows that still hold
      // an old public-URL-shaped value (issued before the 2026-11-05 fix)
      // are left as-is; they simply won't resolve to a live document.
      let masterPolicySignedUrl: string | null = null;
      if (batch.master_policy_document_url && !batch.master_policy_document_url.startsWith('http')) {
        const { data: signed } = await db.storage.from('b2b-documents').createSignedUrl(batch.master_policy_document_url, 300);
        masterPolicySignedUrl = signed?.signedUrl ?? null;
      }

      // v2.9.4 Phase 3 — Resolve plan_id → nama paket sekali, map kembali di
      // klien. Admin perlu melihat NAMA paket ("Premium"), bukan UUID atau
      // kata generik "Paket". Dibaca hanya kalau ada item yang memakai paket.
      const planIds = Array.from(new Set((items ?? []).map((it: { plan_id: string | null }) => it.plan_id).filter((x: string | null): x is string => !!x)));
      const plansMap: Record<string, { name: string; code: string; loading_rate: number }> = {};
      if (planIds.length > 0) {
        const { data: plans } = await db.from('sp_b2b_plans').select('id, name, code, loading_rate').in('id', planIds);
        for (const p of plans ?? []) plansMap[p.id] = { name: p.name, code: p.code, loading_rate: Number(p.loading_rate) };
      }

      // v2.9.12 — audit akses: siapa membuka detail batch (klien ATAU admin).
      logB2BActivity(db, {
        clientId: batch.client_id,
        batchId: batch.id,
        batchNumber: batch.batch_number,
        actorRole: caller.isAdmin ? (caller.role ?? 'ADMIN') : caller.role,
        actorEmail: caller.email,
        action: 'bulk_batch_viewed',
        summary: `${caller.email || 'Pengguna'} membuka detail batch ${batch.batch_number}.`,
        detail: { viewer_role: caller.isAdmin ? 'admin' : 'b2b_client', item_count: batch.item_count },
        ip: ctx.reqIp,
        userAgent: ctx.reqUserAgent,
      });

      return ok({
        batch: { ...batch, master_policy_signed_url: masterPolicySignedUrl },
        items: items ?? [],
        payment: payment ?? null,
        plans: plansMap,
      });
    }

    // ── Client: decide an insurer quote ─────────────────────────────────────
    // FIX v2.8.20 (audit 2026-11-11): keputusan penawaran sebelumnya ditulis
    // langsung dari peramban (update satu kolom tanpa verifikasi apa pun) —
    // tidak ada notifikasi ke admin, status pengajuan induk tidak ikut
    // berubah, dan keandalan transisinya bergantung sepenuhnya pada RLS.
    // Kini satu aksi gateway: hanya pemilik penawaran (B2B_CLIENT) yang boleh
    // memutuskan (MASTER_ADMIN mode pantau sengaja ditolak — sama seperti UI),
    // hanya PENDING yang boleh diputus (keputusan kedua ditolak), status
    // pengajuan disinkronkan, dan admin diberi notifikasi.
    case 'b2b_decide_quote': {
      if (caller.role !== 'B2B_CLIENT') return err('Forbidden: keputusan penawaran hanya untuk klien korporat pemiliknya', 403);
      const clientId = caller.spUser?.id;
      if (!clientId) return err('No B2B profile', 403);
      const quoteId = String(params.quote_id ?? '');
      const decision = String(params.decision ?? '').toUpperCase();
      if (!quoteId) return err('quote_id required', 400);
      if (decision !== 'ACCEPTED' && decision !== 'REJECTED') return err('decision harus ACCEPTED atau REJECTED', 400);

      const { data: quote, error: qErr } = await db.from('sp_b2b_quotes')
        .select('id, submission_id, client_id, insurer_name, premium_amount, status')
        .eq('id', quoteId).maybeSingle();
      if (qErr) { const _err = safeError(qErr); return err(_err.body.error, _err.status); }
      if (!quote) return err('Penawaran tidak ditemukan', 404);
      if (quote.client_id !== clientId) return err('Forbidden: bukan penawaran Anda', 403);
      if (quote.status !== 'PENDING') return err(`Penawaran sudah diputuskan sebelumnya (status: ${quote.status})`, 409);

      const ts = new Date().toISOString();
      const { data: updatedQuote, error: updErr } = await db.from('sp_b2b_quotes')
        .update({ status: decision, updated_at: ts })
        .eq('id', quoteId).eq('status', 'PENDING')
        .select().maybeSingle();
      if (updErr) { const _err = safeError(updErr); return err(_err.body.error, _err.status); }
      if (!updatedQuote) return err('Penawaran sudah diputuskan sebelumnya', 409);

      // Sinkronkan pipeline pengajuan induk — tanpa ini pengajuan selamanya
      // tampak QUOTED walaupun klien sudah setuju atau menolak.
      const { data: submission } = await db.from('sp_b2b_submissions')
        .update({ status: decision, updated_at: ts })
        .eq('id', quote.submission_id)
        .select('id, company_name, status').maybeSingle();

      await db.from('sp_admin_notifications').insert({
        type: 'B2B_QUOTE_DECIDED',
        title: `Penawaran ${decision === 'ACCEPTED' ? 'Diterima' : 'Ditolak'} — ${submission?.company_name ?? 'Klien B2B'}`,
        body: `${submission?.company_name ?? 'Klien korporat'} ${decision === 'ACCEPTED' ? 'MENERIMA' : 'menolak'} penawaran ${quote.insurer_name ?? '(tanpa penanggung)'} senilai Rp ${Number(quote.premium_amount ?? 0).toLocaleString('id-ID')}. ${decision === 'ACCEPTED' ? 'Tindak lanjuti: konversi ke order / terbitkan dokumen.' : 'Tidak perlu tindak lanjut.'}`,
        metadata: { quote_id: quoteId, submission_id: quote.submission_id, decision, premium_amount: quote.premium_amount ?? null },
        read: false,
      }).then(() => {}, () => {});

      return ok({ quote: updatedQuote, submission: submission ?? null });
    }

    // ── Admin: issue the master policy for a PAID batch ────────────────────
    // ── Admin: signed upload URL for the master policy file ────────────────
    // b2b-documents' INSERT storage policy only allows
    // (storage.foldername(name))[1] = auth.uid()::text — there is no
    // is_admin() OR clause on INSERT (only on SELECT/UPDATE/DELETE), so even
    // an authenticated ADMIN cannot satisfy it by uploading directly under a
    // path keyed by batch_id rather than their own uid. uploadB2BBulkMasterPolicy()
    // (services/b2bBulk.ts) relied on exactly that direct upload and would
    // fail. A signed upload URL from service_role sidesteps the policy
    // entirely — same reasoning as insurer_bulk_request_upload_url below.
    case 'admin_b2b_bulk_request_upload_url': {
      if (!caller.isAdmin) return err('Forbidden: admin only', 403);
      const batchId = String(params.batch_id ?? '');
      const fileName = String(params.file_name ?? 'master-policy.pdf');
      if (!batchId) return err('batch_id required', 400);
      const { data: batch } = await db.from('sp_b2b_batches').select('id').eq('id', batchId).maybeSingle();
      if (!batch) return err('Batch not found', 404);
      const ext = (fileName.split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
      const path = `${batchId}/master-policy-${Date.now()}.${ext}`;
      const { data: signed, error: signErr } = await db.storage.from('b2b-documents').createSignedUploadUrl(path);
      if (signErr || !signed) return err(signErr?.message ?? 'Gagal membuat signed upload URL', 400);
      return ok({ path, signed_url: signed.signedUrl, token: signed.token });
    }

    case 'admin_b2b_bulk_issue': {
      if (!caller.isAdmin) return err('Forbidden: admin only', 403);
      const batchId = String(params.batch_id ?? '');
      const policyNumber = String(params.master_policy_number ?? '').trim();
      // FIX 2026-11-05: b2b-documents is a PRIVATE bucket (20260706_security_
      // hardening_phase3) — a getPublicUrl() result for it 404s. This param
      // is now the storage PATH inside that bucket, not a URL; every reader
      // resolves it to a short-lived signed URL (below, and in
      // insurer_list_bulk_batches / b2b_bulk_get_batch) instead of storing
      // one. Accepts a legacy value that still looks like a URL (already
      // issued under the old, broken behavior) without rejecting it — it
      // just won't resolve to anything live; new issuances always get a path.
      const masterPolicyPath = String(params.master_policy_path ?? params.master_policy_document_url ?? '').trim();
      if (!batchId || !policyNumber || !masterPolicyPath) {
        return err('batch_id, master_policy_number, master_policy_path required', 400);
      }
      if (masterPolicyPath.includes('..') || !masterPolicyPath.startsWith(`${batchId}/`)) {
        return err(`master_policy_path harus diawali ${batchId}/`, 400);
      }

      const { data: batch, error: batchErr } = await db.from('sp_b2b_batches').select('id, status').eq('id', batchId).maybeSingle();
      if (batchErr) { const _err = safeError(batchErr); return err(_err.body.error, _err.status); }
      if (!batch) return err('Batch not found', 404);
      if (batch.status !== 'PAID' && batch.status !== 'ISSUED') {
        return err(`Batch belum dibayar (status: ${batch.status}). Polis hanya dapat diterbitkan untuk batch PAID.`, 409);
      }

      // v2.9.28 — nomor polis per unit + peringatan copy polis kedaluwarsa
      // (v2.9.29: peringatan, bukan penghalang — lihat resolveUnitPolicyNumbers).
      const resolved = await resolveUnitPolicyNumbers(db, batchId, policyNumber, params.unit_policy_numbers);
      if (resolved.error) return err(resolved.error, 409);
      const assignments = resolved.assignments;
      const expiredCopyWarning = describeExpiredPolicyCopies(resolved.expiredRowNos);

      const ts = new Date().toISOString();
      const insurerName = params.insurer_name ? String(params.insurer_name) : null;
      const { data: updated, error: updErr } = await db.from('sp_b2b_batches').update({
        status: 'ISSUED',
        master_policy_number: policyNumber,
        master_policy_document_url: masterPolicyPath,
        insurer_name: insurerName,
        issued_at: ts,
        updated_at: ts,
      }).eq('id', batchId).select().maybeSingle();
      if (updErr) { const _err = safeError(updErr); return err(_err.body.error, _err.status); }

      const applied = await applyUnitPolicyNumbers(db, batchId, assignments, ts);
      if (applied) return err(applied, 500);

      // v2.9.28 — beri tahu klien in-app bahwa polisnya sudah terbit.
      await db.from('sp_notifications').insert({
        agent_id: updated.client_id,
        type: 'B2B_BULK_ISSUED_CLIENT',
        title: `Polis massal terbit — ${updated.batch_number ?? batchId}`,
        body: `Polis induk ${policyNumber} untuk ${updated.item_count ?? assignments.length} unit telah diterbitkan. Dokumen dapat diunduh dari portal B2B.`,
        read: false,
        metadata: { batch_id: batchId, master_policy_number: policyNumber, unit_count: assignments.length },
      }).then(() => {}, () => {});

      const { data: signed } = await db.storage.from('b2b-documents').createSignedUrl(masterPolicyPath, 300);

      // v2.9.29 — copy polis kedaluwarsa dilaporkan ke admin agar bisa ditagih
      // ulang ke klien; polis tetap terbit karena batch sudah dibayar.
      if (expiredCopyWarning) {
        await db.from('sp_admin_notifications').insert({
          type: 'B2B_POLICY_COPY_EXPIRED',
          title: `Copy polis kedaluwarsa — ${updated.batch_number ?? batchId}`,
          body: expiredCopyWarning,
          metadata: { batch_id: batchId, expired_policy_copy_rows: resolved.expiredRowNos },
          read: false,
        }).then(() => {}, () => {});
      }

      // v2.9.12 — audit terbitan polis induk oleh admin.
      logB2BActivity(db, {
        clientId: updated.client_id,
        batchId,
        batchNumber: updated.batch_number,
        actorRole: caller.role ?? 'ADMIN',
        actorEmail: caller.email,
        action: 'bulk_master_policy_issued',
        summary: `Polis induk ${policyNumber} diterbitkan untuk ${updated.batch_number}.${expiredCopyWarning ? ' ' + expiredCopyWarning : ''}`,
        detail: {
          master_policy_number: policyNumber,
          master_policy_path: masterPolicyPath,
          insurer_name: insurerName,
          actor: 'admin',
          expired_policy_copy_rows: resolved.expiredRowNos,
        },
        ip: ctx.reqIp,
        userAgent: ctx.reqUserAgent,
      });

      return ok({
        ...updated,
        master_policy_signed_url: signed?.signedUrl ?? null,
        expired_policy_copy_rows: resolved.expiredRowNos,
        warning: expiredCopyWarning,
      });
    }

    // ── Admin: assign the insurer who will issue the master policy ─────────
    // Previously insurer_id on a batch was only ever written by
    // admin_b2b_bulk_issue itself (the LAST step) — there was no way to
    // assign one earlier, so an insurer's token-authed dashboard had nothing
    // to query before the batch was already done. This lets admin pick the
    // insurer any time after submission; it does not change batch status.
    case 'admin_b2b_bulk_assign_insurer': {
      if (!caller.isAdmin) return err('Forbidden: admin only', 403);
      const batchId = String(params.batch_id ?? '');
      const insurerId = String(params.insurer_id ?? '');
      if (!batchId || !insurerId) return err('batch_id, insurer_id required', 400);
      const { data: insurer } = await db.from('sp_insurers').select('id, name').eq('id', insurerId).maybeSingle();
      if (!insurer) return err('Insurer not found', 404);
      const { data, error } = await db.from('sp_b2b_batches').update({
        insurer_id: insurerId, insurer_name: insurer.name, updated_at: new Date().toISOString(),
      }).eq('id', batchId).select().maybeSingle();
      if (error) { const _err = safeError(error); return err(_err.body.error, _err.status); }
      if (!data) return err('Batch not found', 404);

      // v2.9.12 — audit penetapan insurer.
      logB2BActivity(db, {
        clientId: data.client_id,
        batchId,
        batchNumber: data.batch_number,
        actorRole: caller.role ?? 'ADMIN',
        actorEmail: caller.email,
        action: 'bulk_insurer_assigned',
        summary: `Admin menugaskan ${insurer.name} menerbitkan polis untuk ${data.batch_number}.`,
        detail: { insurer_id: insurerId, insurer_name: insurer.name, batch_status: data.status },
        ip: ctx.reqIp,
        userAgent: ctx.reqUserAgent,
      });

      return ok(data);
    }

    // ── Insurer (token-authed): batches assigned to them ────────────────────
    // Mirrors insurer_list_payments's token-validation shape. Only PAID
    // batches are actionable (awaiting their master-policy upload); ISSUED
    // ones are included read-only as history so the dashboard isn't empty
    // once an insurer has worked through their queue.
    case 'insurer_list_bulk_batches': {
      const token = String(params.token ?? '');
      if (!token) return err('token required', 400);
      const { data: authToken, error: authErr } = await db.from('sp_insurer_auth_tokens')
        .select('id, insurer_id, expires_at').eq('token', token).maybeSingle();
      if (authErr) { const _err = safeError(authErr); return err(_err.body.error, _err.status); }
      if (!authToken) return err('Invalid token', 404);
      if (new Date(authToken.expires_at) < new Date()) return err('Token expired', 410);

      const { data: batches, error: batchesErr } = await db.from('sp_b2b_batches')
        .select('*').eq('insurer_id', authToken.insurer_id).in('status', ['PAID', 'ISSUED'])
        .order('created_at', { ascending: false });
      if (batchesErr) { const _err = safeError(batchesErr); return err(_err.body.error, _err.status); }

      // Sign whichever ISSUED batches already have a master policy path, so
      // the dashboard can offer a working download link without a second
      // round trip (same inline-signing shape as insurer_list_order_documents).
      const withUrls = await Promise.all((batches ?? []).map(async (b: any) => {
        if (!b.master_policy_document_url || b.master_policy_document_url.startsWith('http')) {
          return { ...b, master_policy_signed_url: null };
        }
        const { data: signed } = await db.storage.from('b2b-documents').createSignedUrl(b.master_policy_document_url, 300);
        return { ...b, master_policy_signed_url: signed?.signedUrl ?? null };
      }));
      return ok(withUrls);
    }

    // ── Insurer (token-authed): request a signed upload URL ────────────────
    // b2b-documents is private with owner-folder-only INSERT policies — an
    // insurer has no Supabase session (bearer token only), so it cannot
    // satisfy that policy by uploading directly the way an authenticated
    // admin/client would. A signed upload URL from service_role sidesteps
    // that entirely: the URL itself is the grant, scoped to this one path.
    case 'insurer_bulk_request_upload_url': {
      const token = String(params.token ?? '');
      const batchId = String(params.batch_id ?? '');
      const fileName = String(params.file_name ?? 'master-policy.pdf');
      if (!token || !batchId) return err('token, batch_id required', 400);
      const { data: authToken, error: authErr } = await db.from('sp_insurer_auth_tokens')
        .select('id, insurer_id, expires_at').eq('token', token).maybeSingle();
      if (authErr) { const _err = safeError(authErr); return err(_err.body.error, _err.status); }
      if (!authToken) return err('Invalid token', 404);
      if (new Date(authToken.expires_at) < new Date()) return err('Token expired', 410);

      const { data: batch } = await db.from('sp_b2b_batches').select('id, status, insurer_id').eq('id', batchId).maybeSingle();
      if (!batch || batch.insurer_id !== authToken.insurer_id) return err('Batch not found or not assigned to your insurer', 404);
      if (batch.status !== 'PAID') return err(`Batch belum berstatus PAID (status: ${batch.status})`, 409);

      const ext = (fileName.split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
      const path = `${batchId}/master-policy-${Date.now()}.${ext}`;
      const { data: signed, error: signErr } = await db.storage.from('b2b-documents').createSignedUploadUrl(path);
      if (signErr || !signed) return err(signErr?.message ?? 'Gagal membuat signed upload URL', 400);
      return ok({ path, signed_url: signed.signedUrl, token: signed.token });
    }

    // ── Insurer (token-authed): finalize — mirrors insurer_upload_policy ──
    case 'insurer_upload_bulk_master_policy': {
      const token = String(params.token ?? '');
      const batchId = String(params.batch_id ?? '');
      const path = String(params.master_policy_path ?? '').trim();
      const policyNumber = String(params.master_policy_number ?? '').trim();
      if (!token || !batchId || !path) return err('token, batch_id, master_policy_path required', 400);
      if (path.includes('..') || !path.startsWith(`${batchId}/`)) return err(`master_policy_path harus diawali ${batchId}/`, 400);

      const { data: authToken, error: authErr } = await db.from('sp_insurer_auth_tokens')
        .select('id, insurer_id, expires_at').eq('token', token).maybeSingle();
      if (authErr) { const _err = safeError(authErr); return err(_err.body.error, _err.status); }
      if (!authToken) return err('Invalid token', 404);
      if (new Date(authToken.expires_at) < new Date()) return err('Token expired', 410);

      const { data: batch, error: batchErr } = await db.from('sp_b2b_batches')
        .select('id, status, insurer_id, client_id, company_name, batch_number').eq('id', batchId).maybeSingle();
      if (batchErr) { const _err = safeError(batchErr); return err(_err.body.error, _err.status); }
      if (!batch || batch.insurer_id !== authToken.insurer_id) return err('Batch not found or not assigned to your insurer', 404);
      if (batch.status !== 'PAID') return err(`Batch belum berstatus PAID (status: ${batch.status})`, 409);

      // v2.9.28 — nomor polis per unit + peringatan copy polis kedaluwarsa
      // (v2.9.29: peringatan, bukan penghalang — lihat resolveUnitPolicyNumbers).
      const resolved = await resolveUnitPolicyNumbers(db, batchId, policyNumber, params.unit_policy_numbers);
      if (resolved.error) return err(resolved.error, 409);
      const assignments = resolved.assignments;
      const expiredCopyWarning = describeExpiredPolicyCopies(resolved.expiredRowNos);

      const ts = new Date().toISOString();
      const { data: updated, error: updErr } = await db.from('sp_b2b_batches').update({
        status: 'ISSUED',
        master_policy_number: policyNumber || null,
        master_policy_document_url: path,
        issued_at: ts,
        updated_at: ts,
      }).eq('id', batchId).select().maybeSingle();
      if (updErr) { const _err = safeError(updErr); return err(_err.body.error, _err.status); }

      const applied = await applyUnitPolicyNumbers(db, batchId, assignments, ts);
      if (applied) return err(applied, 500);

      // v2.9.28 — klien menerima pemberitahuan in-app yang sama seperti
      // jalur admin, supaya status "polis terbit" tidak hanya terlihat oleh admin.
      await db.from('sp_notifications').insert({
        agent_id: batch.client_id,
        type: 'B2B_BULK_ISSUED_CLIENT',
        title: `Polis massal terbit — ${batch.batch_number}`,
        body: `Polis induk ${policyNumber || '(tanpa nomor)'} untuk batch ${batch.batch_number} telah diterbitkan oleh penanggung.`,
        read: false,
        metadata: { batch_id: batchId, master_policy_number: policyNumber || null, unit_count: assignments.length },
      }).then(() => {}, () => {});

      await db.from('sp_admin_notifications').insert({
        type: 'B2B_BULK_ISSUED',
        title: `Polis Induk B2B Diterbitkan — ${batch.company_name}`,
        body: `${batch.batch_number}: polis ${policyNumber || '(no number)'} diunggah oleh insurer.${expiredCopyWarning ? ' ' + expiredCopyWarning : ''}`,
        metadata: {
          batch_id: batchId,
          policy_number: policyNumber,
          expired_policy_copy_rows: resolved.expiredRowNos,
        },
        read: false,
      }).then(() => {}, () => {});

      // v2.9.12 — audit terbitan oleh insurer (token-authed).
      logB2BActivity(db, {
        clientId: batch.client_id,
        batchId,
        batchNumber: batch.batch_number,
        actorRole: 'INSURER',
        actorEmail: null,
        action: 'bulk_insurer_uploaded_master_policy',
        summary: `Insurer mengunggah polis induk ${policyNumber || '(no number)'} untuk ${batch.batch_number}.${expiredCopyWarning ? ' ' + expiredCopyWarning : ''}`,
        detail: {
          master_policy_number: policyNumber || null,
          master_policy_path: path,
          insurer_id: authToken.insurer_id,
          expired_policy_copy_rows: resolved.expiredRowNos,
        },
        ip: ctx.reqIp,
        userAgent: ctx.reqUserAgent,
      });

      const { data: signed } = await db.storage.from('b2b-documents').createSignedUrl(path, 300);
      return ok({
        ...updated,
        master_policy_signed_url: signed?.signedUrl ?? null,
        expired_policy_copy_rows: resolved.expiredRowNos,
        warning: expiredCopyWarning,
      });
    }

    case 'admin_b2b_bulk_list_batches': {
      if (!caller.isAdmin) return err('Forbidden: admin only', 403);
      const { data, error } = await db.from('sp_b2b_batches').select('*').order('created_at', { ascending: false });
      if (error) { const _err = safeError(error); return err(_err.body.error, _err.status); }
      return ok(data ?? []);
    }

    // ── Admin: tautan unduh (berumur pendek) file sumber upload massal ─────
    // v2.9.12. File asli klien berada di bucket privat b2b-documents pada
    // sp_b2b_batches.source_file_path; admin tidak bisa (dan tidak boleh)
    // membuat tautannya sendiri dari peramban. Aksi ini menge-sign URL 300
    // detik dan mengaudit unduhannya. Batch lama (sebelum kolom ada) tanpa
    // path mendapat pesan jujur, bukan link kosong.
    case 'admin_b2b_bulk_source_url': {
      if (!caller.isAdmin) return err('Forbidden: admin only', 403);
      const batchId = String(params.batch_id ?? '');
      if (!batchId) return err('batch_id required', 400);
      const { data: batch, error: batchErr } = await db.from('sp_b2b_batches')
        .select('id, batch_number, company_name, client_id, source_file_name, source_file_path, source_file_size, source_file_mime')
        .eq('id', batchId).maybeSingle();
      if (batchErr) { const _err = safeError(batchErr); return err(_err.body.error, _err.status); }
      if (!batch) return err('Batch not found', 404);
      if (!batch.source_file_path) {
        return err('File sumber tidak tercatat untuk batch ini (diimpor sebelum v2.9.12 atau tanpa file).', 404);
      }
      const { data: signed, error: signErr } = await db.storage
        .from('b2b-documents')
        .createSignedUrl(batch.source_file_path, 300);
      if (signErr || !signed) {
        return err(signErr?.message ?? 'File sumber tidak dapat ditemukan di storage.', 404);
      }

      logB2BActivity(db, {
        clientId: batch.client_id,
        batchId: batch.id,
        batchNumber: batch.batch_number,
        actorRole: caller.role ?? 'ADMIN',
        actorEmail: caller.email,
        action: 'bulk_source_file_downloaded',
        summary: `Admin mengunduh file sumber ${batch.source_file_name ?? '(tanpa nama)'} dari ${batch.batch_number}.`,
        detail: { file_name: batch.source_file_name, file_size: batch.source_file_size, file_mime: batch.source_file_mime },
        ip: ctx.reqIp,
        userAgent: ctx.reqUserAgent,
      });

      return ok({
        file_name: batch.source_file_name,
        file_size: batch.source_file_size,
        file_mime: batch.source_file_mime,
        url: signed.signedUrl,
      });
    }

    // ── Admin: baca log aktivitas B2B ───────────────────────────────────────
    // v2.9.12. Terbaru dulu, halaman 1..500 baris, bisa difilter per klien
    // dan/atau per batch. RLS tabel deny-all, jadi satu-satunya pintu baca.
    case 'admin_b2b_activity_log': {
      if (!caller.isAdmin) return err('Forbidden: admin only', 403);
      const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 500);
      const offset = Math.max(Number(params.offset) || 0, 0);
      let q = db.from('sp_b2b_activity_log')
        .select('*')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (params.client_id) q = q.eq('client_id', String(params.client_id));
      if (params.batch_id) q = q.eq('batch_id', String(params.batch_id));
      const { data, error } = await q;
      if (error) { const _err = safeError(error); return err(_err.body.error, _err.status); }
      return ok(data ?? []);
    }

    // ── Klien B2B: log aktivitas sendiri ────────────────────────────────────
    // v2.9.24 (roadmap #10). Klien B2B melihat seluruh aktivitas akunnya
    // (impor massal, invoice dibuat, pembayaran, polis terbit) tanpa perlu
    // minta ke admin. Dibatasi: hanya baris dengan client_id milik caller,
    // maksimum 200 baris per halaman, terbaru dulu.
    case 'b2b_my_activity_log': {
      if (!caller.spUser) return err('No profile', 403);
      if (caller.spUser.role !== 'B2B_CLIENT') return err('Forbidden: B2B only', 403);
      const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 200);
      const offset = Math.max(Number(params.offset) || 0, 0);
      const { data, error } = await db.from('sp_b2b_activity_log')
        .select('*')
        .eq('client_id', caller.spUser.id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) { const _err = safeError(error); return err(_err.body.error, _err.status); }
      return ok(data ?? []);
    }

    // ── Klien B2B: riwayat pembayaran (invoice batch + policy order) ────────
    // v2.9.24 (roadmap #3). Satu pintu untuk semua pembayaran milik klien:
    // invoice batch massal (via sp_b2b_batches.client_id) dan pembayaran
    // polis individual (via sp_policy_orders.client_id). Tidak menduplikasi
    // get_my_payments — aksi itu hanya covers order-based; aksi ini juga
    // batch-based, yang merupakan mayoritas use case B2B.
    //
    // v2.9.27 (audit-fix #1 + #3):
    //   (#1) Paginasi eksplisit: `limit` dijepit [1..200], `offset` ≥ 0.
    //        Sebelumnya hard-coded .limit(500) tanpa offset — klien dengan
    //        >500 pembayaran kehilangan baris lama secara diam-diam.
    //        Klien mendeteksi halaman terakhir dengan `payments.length < limit`.
    //   (#3) IN-list dibatasi ke 500 batch + 500 order terbaru per klien.
    //        PostgREST URL untuk `.or('batch_id.in.(uuid,uuid,...)')` bisa
    //        melewati ~8 KB jika klien punya ribuan batch, menghasilkan 414
    //        atau respon terpotong secara diam-diam. UUID aman secara
    //        injeksi (hanya hex + dash) tetapi panjang total URL tidak.
    //        Jika klien benar-benar punya >500 batch aktif, aksi ini hanya
    //        menampilkan pembayaran dari 500 batch terbaru — untuk riwayat
    //        lebih dalam, pakai tab Batch Massal yang terpaginasi sendiri.
    case 'b2b_my_payments': {
      if (!caller.spUser) return err('No profile', 403);
      if (caller.spUser.role !== 'B2B_CLIENT') return err('Forbidden: B2B only', 403);

      const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 200);
      const offset = Math.max(Number(params.offset) || 0, 0);
      const OWNER_LOOKUP_CAP = 500;

      // Kumpulkan id batch milik caller — dibatasi ke 500 terbaru (ORDER BY
      // created_at DESC) agar IN-filter di bawah tetap dalam batas panjang URL.
      const { data: myBatches, error: bErr } = await db
        .from('sp_b2b_batches')
        .select('id, batch_number, company_name, total_amount, status, item_count')
        .eq('client_id', caller.spUser.id)
        .order('created_at', { ascending: false })
        .limit(OWNER_LOOKUP_CAP);
      if (bErr) { const _err = safeError(bErr); return err(_err.body.error, _err.status); }
      const batchIds = (myBatches ?? []).map((b: any) => String(b.id));
      const batchMeta: Record<string, any> = {};
      for (const b of (myBatches ?? [])) batchMeta[String(b.id)] = b;

      // Kumpulkan id order milik caller — dibatasi ke 500 terbaru, alasan sama.
      const { data: myOrders, error: oErr } = await db
        .from('sp_policy_orders')
        .select('id, product_name, premium_amount, status, created_at')
        .eq('client_id', caller.spUser.id)
        .order('created_at', { ascending: false })
        .limit(OWNER_LOOKUP_CAP);
      if (oErr) { const _err = safeError(oErr); return err(_err.body.error, _err.status); }
      const orderIds = (myOrders ?? []).map((o: any) => String(o.id));
      const orderMeta: Record<string, any> = {};
      for (const o of (myOrders ?? [])) orderMeta[String(o.id)] = o;

      if (batchIds.length === 0 && orderIds.length === 0) return ok([]);

      // Ambil payments: batch_id ATAU order_id milik caller, terpaginasi.
      const orFilter = [
        batchIds.length ? `batch_id.in.(${batchIds.join(',')})` : null,
        orderIds.length ? `order_id.in.(${orderIds.join(',')})` : null,
      ].filter(Boolean).join(',');
      const { data: payments, error: pErr } = await db
        .from('sp_payments')
        .select('id, batch_id, order_id, invoice_url, status, paid_amount, xendit_fee, created_at, paid_at, expired_at')
        .or(orFilter)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (pErr) { const _err = safeError(pErr); return err(_err.body.error, _err.status); }

      // Enrichment ringan: tempel judul yang bisa dibaca manusia
      const enriched = (payments ?? []).map((p: any) => ({
        ...p,
        _kind: p.batch_id ? 'batch' : 'order',
        _title: p.batch_id
          ? (batchMeta[p.batch_id]?.batch_number ?? '(batch dihapus)')
          : (orderMeta[p.order_id]?.product_name ?? '(order dihapus)'),
        _subtitle: p.batch_id
          ? (batchMeta[p.batch_id]?.company_name ?? '')
          : (orderMeta[p.order_id]?.status ?? ''),
      }));
      return ok(enriched);
    }

    // ── Klien: batalkan batch yang belum dibayar ───────────────────────────
    // Sebelumnya status CANCELLED ada di CHECK constraint tetapi tidak ada
    // kode yang menulisnya: klien yang salah impor tidak punya jalan keluar
    // dan antrean admin menumpuk selamanya. Hanya pemilik batch, hanya saat
    // SUBMITTED — batch INVOICED punya tagihan hidup yang tidak boleh
    // ditinggalkan tanpa jejak, jadi itu ranah admin.
    case 'b2b_bulk_cancel_batch': {
      if (caller.role !== 'B2B_CLIENT') return err('Forbidden: B2B client only', 403);
      const clientId = caller.spUser?.id;
      if (!clientId) return err('No B2B profile', 403);
      const batchId = String(params.batch_id ?? '');
      if (!batchId) return err('batch_id required', 400);
      const reason = String(params.reason ?? '').trim().slice(0, 300);

      const { data: batch, error: bErr } = await db
        .from('sp_b2b_batches')
        .select('id, batch_number, client_id, status, total_amount')
        .eq('id', batchId).maybeSingle();
      if (bErr) { const _err = safeError(bErr); return err(_err.body.error, _err.status); }
      if (!batch) return err('Batch not found', 404);
      if (batch.client_id !== clientId) return err('Forbidden: bukan batch Anda', 403);
      if (batch.status !== 'SUBMITTED') {
        return err(`Batch tidak dapat dibatalkan sendiri (status: ${batch.status}). Hubungi administrator.`, 409);
      }

      const ts = new Date().toISOString();
      const { data: updated, error: uErr } = await db.from('sp_b2b_batches').update({
        status: 'CANCELLED',
        cancelled_at: ts,
        cancelled_by: clientId,
        cancel_reason: reason || 'Dibatalkan oleh klien.',
        updated_at: ts,
      }).eq('id', batchId).eq('status', 'SUBMITTED')
        .select('id, batch_number, status, cancelled_at').maybeSingle();
      if (uErr) { const _err = safeError(uErr); return err(_err.body.error, _err.status); }
      if (!updated) return err('Status batch sudah berubah. Muat ulang lalu coba lagi.', 409);

      await db.from('sp_admin_notifications').insert({
        type: 'B2B_BULK_CANCELLED',
        title: `Batch B2B Dibatalkan — ${batch.batch_number}`,
        body: `${batch.batch_number} dibatalkan oleh klien. Alasan: ${reason || '(tidak disebutkan)'}`,
        metadata: { batch_id: batchId, reason: reason || null },
        read: false,
      }).then(() => {}, () => {});

      logB2BActivity(db, {
        clientId,
        batchId,
        batchNumber: batch.batch_number,
        actorRole: caller.role,
        actorEmail: caller.email,
        action: 'bulk_batch_cancelled',
        summary: `Klien membatalkan ${batch.batch_number}. Alasan: ${reason || '(tidak disebutkan)'}.`,
        detail: { reason: reason || null, previous_status: batch.status },
        ip: ctx.reqIp,
        userAgent: ctx.reqUserAgent,
      });

      return ok(updated);
    }

    // ── Admin: batalkan batch (termasuk yang sudah punya invoice) ──────────
    case 'admin_b2b_bulk_cancel_batch': {
      if (!caller.isAdmin) return err('Forbidden: admin only', 403);
      const batchId = String(params.batch_id ?? '');
      if (!batchId) return err('batch_id required', 400);
      const reason = String(params.reason ?? '').trim().slice(0, 300);

      const { data: batch, error: bErr } = await db
        .from('sp_b2b_batches')
        .select('id, batch_number, client_id, status')
        .eq('id', batchId).maybeSingle();
      if (bErr) { const _err = safeError(bErr); return err(_err.body.error, _err.status); }
      if (!batch) return err('Batch not found', 404);
      if (batch.status === 'PAID' || batch.status === 'ISSUED') {
        return err(`Batch sudah dibayar (status: ${batch.status}); pembatalan tidak diizinkan.`, 409);
      }
      if (batch.status === 'CANCELLED') {
        return err('Batch sudah dibatalkan.', 409);
      }

      const ts = new Date().toISOString();
      const { data: updated, error: uErr } = await db.from('sp_b2b_batches').update({
        status: 'CANCELLED',
        cancelled_at: ts,
        cancelled_by: caller.spUser?.id ?? null,
        cancel_reason: reason || 'Dibatalkan oleh administrator.',
        updated_at: ts,
      }).eq('id', batchId).in('status', ['SUBMITTED', 'INVOICED'])
        .select('id, batch_number, status, cancelled_at').maybeSingle();
      if (uErr) { const _err = safeError(uErr); return err(_err.body.error, _err.status); }
      if (!updated) return err('Status batch sudah berubah. Muat ulang lalu coba lagi.', 409);

      // An INVOICED batch may still have a payable Xendit invoice. Cancelling
      // the batch does not void it at the provider, so leave an explicit task
      // for finance instead of letting a payment arrive on a dead batch.
      if (batch.status === 'INVOICED') {
        await db.from('sp_admin_notifications').insert({
          type: 'B2B_CANCELLED_WITH_LIVE_INVOICE',
          title: `Batch dibatalkan setelah invoice terbit — ${batch.batch_number}`,
          body: `Invoice Xendit untuk ${batch.batch_number} masih dapat dibayar. Kedaluwarsakan/void invoice tersebut agar tidak ada pembayaran masuk untuk batch yang sudah dibatalkan.`,
          metadata: { batch_id: batchId },
          read: false,
        }).then(() => {}, () => {});
      }

      logB2BActivity(db, {
        clientId: batch.client_id,
        batchId,
        batchNumber: batch.batch_number,
        actorRole: caller.role ?? 'ADMIN',
        actorEmail: caller.email,
        action: 'bulk_batch_cancelled_by_admin',
        summary: `Admin membatalkan ${batch.batch_number}. Alasan: ${reason || '(tidak disebutkan)'}.`,
        detail: { reason: reason || null, previous_status: batch.status },
        ip: ctx.reqIp,
        userAgent: ctx.reqUserAgent,
      });

      return ok(updated);
    }

    // ── Admin: sapu batch SUBMITTED yang tidak pernah dibayar ──────────────
    // Idempoten dan terbatas 200 batch per panggilan. Tidak menyentuh batch
    // yang sudah punya invoice hidup (INVOICED) — invoice itu harus kedaluwarsa
    // lewat webhook Xendit agar tidak ada tagihan yang masih bisa dibayar
    // padahal batch-nya sudah dibatalkan.
    case 'admin_b2b_expire_stale_batches': {
      if (!caller.isAdmin) return err('Forbidden: admin only', 403);
      const days = Math.min(Math.max(Number(params.older_than_days) || 7, 1), 30);
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const ts = new Date().toISOString();

      const { data: stale, error: sErr } = await db
        .from('sp_b2b_batches')
        .select('id, batch_number, client_id, created_at')
        .eq('status', 'SUBMITTED')
        .lt('created_at', cutoff)
        .order('created_at', { ascending: true })
        .limit(200);
      if (sErr) { const _err = safeError(sErr); return err(_err.body.error, _err.status); }

      let expired = 0;
      for (const b of stale ?? []) {
        const { data: upd } = await db.from('sp_b2b_batches').update({
          status: 'CANCELLED',
          cancelled_at: ts,
          cancelled_by: null,
          cancel_reason: `Kedaluwarsa otomatis: ${days} hari tanpa pembayaran.`,
          updated_at: ts,
        }).eq('id', b.id).eq('status', 'SUBMITTED').select('id').maybeSingle();
        if (!upd) continue;
        expired++;
        logB2BActivity(db, {
          clientId: b.client_id,
          batchId: b.id,
          batchNumber: b.batch_number,
          actorRole: 'SYSTEM',
          actorEmail: null,
          action: 'bulk_batch_expired',
          summary: `${b.batch_number} kedaluwarsa otomatis setelah ${days} hari tanpa pembayaran.`,
          detail: { older_than_days: days, created_at: b.created_at },
          ip: ctx.reqIp,
          userAgent: ctx.reqUserAgent,
        });
      }

      return ok({ cutoff, older_than_days: days, scanned: (stale ?? []).length, expired });
    }

    // ── Admin: umur antrean batch (aging) ─────────────────────────────────
    // Menjawab "berapa uang yang tertahan di antrean dan sudah berapa lama"
    // tanpa menarik semua baris ke peramban.
    case 'admin_b2b_batch_aging': {
      if (!caller.isAdmin) return err('Forbidden: admin only', 403);
      const days = Math.min(Math.max(Number(params.days) || 180, 7), 365);
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const { data, error } = await db
        .from('sp_b2b_batches')
        .select('id, status, total_amount, created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .limit(5000);
      if (error) { const _err = safeError(error); return err(_err.body.error, _err.status); }

      const now = Date.now();
      const bucketOf = (ageDays: number) =>
        ageDays < 7 ? 'under_7_days' : ageDays < 30 ? 'days_7_30' : ageDays < 90 ? 'days_30_90' : 'over_90_days';
      const bucketLabels: Record<string, string> = {
        under_7_days: '0–6 hari', days_7_30: '7–29 hari', days_30_90: '30–89 hari', over_90_days: '90+ hari',
      };
      const buckets: Record<string, { label: string; batches: number; amount: number }> = {};
      for (const key of Object.keys(bucketLabels)) buckets[key] = { label: bucketLabels[key], batches: 0, amount: 0 };
      const byStatus: Record<string, { batches: number; amount: number }> = {};

      for (const b of data ?? []) {
        const ageDays = Math.max(0, Math.floor((now - Date.parse(String(b.created_at))) / 86_400_000));
        const amount = Number(b.total_amount) || 0;
        const bucket = buckets[bucketOf(ageDays)];
        bucket.batches += 1;
        bucket.amount += amount;
        const status = String(b.status ?? 'UNKNOWN');
        byStatus[status] = byStatus[status] ?? { batches: 0, amount: 0 };
        byStatus[status].batches += 1;
        byStatus[status].amount += amount;
      }

      return ok({
        as_of: new Date().toISOString(),
        window_days: days,
        // PostgREST caps the underlying select at 1,000 rows; say so rather
        // than presenting a silently truncated queue as complete.
        row_count: (data ?? []).length,
        truncated: (data ?? []).length >= 1000,
        buckets: Object.entries(buckets).map(([key, value]) => ({ key, ...value })),
        by_status: byStatus,
      });
    }

    // ── Klien: radar perpanjangan armada ───────────────────────────────────
    // Batch membawa coverage_end_date per unit (v2.9.13). Tanpa aksi ini
    // tanggal itu hanya tersimpan: tidak ada yang memberi tahu klien bahwa
    // 40 unit habis masa pertanggungannya bulan depan — padahal justru di situ
    // pendapatan perpanjangan berada.
    case 'b2b_fleet_renewals': {
      if (!caller.spUser) return err('No profile', 403);
      if (caller.spUser.role !== 'B2B_CLIENT') return err('Forbidden: B2B only', 403);
      const withinDays = Math.min(Math.max(Number(params.within_days) || 90, 1), 365);
      const today = new Date().toISOString().slice(0, 10);
      const horizon = new Date(Date.now() + withinDays * 86_400_000).toISOString().slice(0, 10);

      const { data: batches, error: bErr } = await db
        .from('sp_b2b_batches')
        .select('id, batch_number, status')
        .eq('client_id', caller.spUser.id)
        .in('status', ['PAID', 'ISSUED'])
        .order('created_at', { ascending: false })
        .limit(500);
      if (bErr) { const _err = safeError(bErr); return err(_err.body.error, _err.status); }
      const batchIds = (batches ?? []).map((b: { id: string }) => b.id);
      if (batchIds.length === 0) return ok({ as_of: today, within_days: withinDays, items: [] });

      const batchMeta: Record<string, { batch_number: string; status: string }> = {};
      for (const b of batches ?? []) batchMeta[b.id] = { batch_number: b.batch_number, status: b.status };

      const { data: items, error: iErr } = await db
        .from('sp_b2b_batch_items')
        .select('id, batch_id, row_no, nasabah_name, plate_no, make, model, coverage_end_date, total_premium, status')
        .in('batch_id', batchIds)
        .gte('coverage_end_date', today)
        .lte('coverage_end_date', horizon)
        .order('coverage_end_date', { ascending: true })
        .limit(1000);
      if (iErr) { const _err = safeError(iErr); return err(_err.body.error, _err.status); }

      const todayMs = Date.parse(`${today}T00:00:00Z`);
      const rows = (items ?? []).map((it: Record<string, any>) => {
        const end = String(it.coverage_end_date).slice(0, 10);
        const daysRemaining = Math.ceil((Date.parse(`${end}T00:00:00Z`) - todayMs) / 86_400_000);
        return {
          ...it,
          batch_number: batchMeta[it.batch_id]?.batch_number ?? null,
          batch_status: batchMeta[it.batch_id]?.status ?? null,
          days_remaining: daysRemaining,
          urgency: daysRemaining <= 14 ? 'CRITICAL' : daysRemaining <= 45 ? 'SOON' : 'PLANNED',
        };
      });

      return ok({ as_of: today, within_days: withinDays, count: rows.length, items: rows });
    }

    default:
      return null;
  }
}

// ── Helpers: per-unit policy numbering ──────────────────────────────────────

/** Accepts either { itemId: number } or [{ item_id, policy_number }]. */
function normalizePolicyNumberOverrides(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const itemId = String(row.item_id ?? row.itemId ?? '').trim();
      const number = String(row.policy_number ?? row.policyNumber ?? '').trim();
      if (itemId && number) out[itemId] = number;
    }
    return out;
  }
  if (typeof raw === 'object') {
    for (const [itemId, value] of Object.entries(raw as Record<string, unknown>)) {
      const key = String(itemId).trim();
      const number = String(value ?? '').trim();
      if (key && number) out[key] = number;
    }
  }
  return out;
}

/**
 * Load the batch rows, check policy copy expiry and produce one policy number
 * per row. Never falls back to a single number for the whole batch.
 *
 * v2.9.29 — an expired policy copy is reported, not fatal. The copy is the
 * client's PREVIOUS policy kept as supporting evidence; the legal basis of the
 * cover being issued is the master policy. Blocking a PAID batch on it left
 * already-paid vehicles uninsured over a document that ops can chase later, so
 * the expiry now travels back as `expiredRowNos` for notification + audit.
 */
async function resolveUnitPolicyNumbers(
  db: any,
  batchId: string,
  masterPolicyNumber: string,
  rawOverrides: unknown,
): Promise<{ assignments: UnitPolicyAssignment[]; expiredRowNos: number[]; error?: string }> {
  const { data: rows, error } = await db
    .from('sp_b2b_batch_items')
    .select('id, row_no, policy_copy_expiry')
    .eq('batch_id', batchId)
    .order('row_no');
  if (error) { const _err = safeError(error); return { assignments: [], expiredRowNos: [], error: _err.body.error }; }

  const items = (rows ?? []) as PolicyNumberRow[];
  if (items.length === 0) {
    return { assignments: [], expiredRowNos: [], error: 'Batch tidak memiliki unit; tidak ada polis yang bisa diterbitkan.' };
  }

  const expired = new Set(expiredPolicyCopyRowIds(items, new Date().toISOString().slice(0, 10)));
  const expiredRowNos = items.filter(r => expired.has(r.id)).map(r => r.rowNo);

  // Legacy insurer flow allows a blank master number. Keep that, but never
  // invent unit numbers out of an empty string.
  if (!normalizePolicyNumber(masterPolicyNumber)) {
    return { assignments: items.map(r => ({ itemId: r.id, rowNo: r.rowNo, policyNumber: '' })), expiredRowNos };
  }

  const built = buildUnitPolicyNumbers(masterPolicyNumber, items, normalizePolicyNumberOverrides(rawOverrides));
  if (built.error) return { assignments: [], expiredRowNos: [], error: built.error };
  return { assignments: built.assignments, expiredRowNos };
}

/** Write each row's own policy number in waves of 25 (bounded DB concurrency). */
async function applyUnitPolicyNumbers(
  db: any,
  batchId: string,
  assignments: UnitPolicyAssignment[],
  ts: string,
): Promise<string | null> {
  const WAVE = 25;
  for (let i = 0; i < assignments.length; i += WAVE) {
    const wave = assignments.slice(i, i + WAVE);
    const results = await Promise.all(wave.map(a => db
      .from('sp_b2b_batch_items')
      .update({ policy_number: a.policyNumber || null, status: 'ISSUED', updated_at: ts })
      .eq('id', a.itemId)
      .eq('batch_id', batchId)));
    for (const r of results) {
      if (r?.error) { const _err = safeError(r.error); return _err.body.error; }
    }
  }
  return null;
}
