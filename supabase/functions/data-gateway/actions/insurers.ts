// insurers.ts — 21 actions
// Auto-generated from data-gateway/index.ts split
import type { GatewayContext, ActionResult } from './types.ts';
import { clayPatch, parseHighlightBullets } from './clayFields.ts';

// json() helper — returns ActionResult (main index.ts converts to Response)
import { safeError } from '../../_shared/errorMap.ts';
const json = (body: unknown, status = 200): ActionResult => ({ status, body });

// FIX v2.7.56 (audit): token disimpan sebagai hash SHA-256, bukan plaintext.
// Kolom token_hash diisi migration 20261106; lookup hash-first dengan fallback
// kolom lama supaya deploy kode dan migration bisa berurutan tanpa downtime.
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validasi token insurer: hash-first, fallback plaintext bila kolom hash belum
// ada di database produksi (migration belum jalan). Semua filter .or() hanya
// menerima nilai yang lolos validasi UUID/hex — tidak ada input mentah.
async function findInsurerAuthToken(db: GatewayContext['db'], token: string) {
  if (!UUID_RE.test(token)) return { data: null, error: null as { message: string } | null };
  const tokenHash = await sha256Hex(token);
  const byHash = await db.from('sp_insurer_auth_tokens')
    .select('id, insurer_id, email, expires_at, used_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (!byHash.error) return byHash;
  if (!/token_hash/i.test(byHash.error.message ?? '')) return byHash;
  return db.from('sp_insurer_auth_tokens')
    .select('id, insurer_id, email, expires_at, used_at')
    .eq('token', token)
    .maybeSingle();
}

export async function handleInsurersAction(action: string, ctx: GatewayContext): Promise<ActionResult | null> {
  const { db, params, caller, sendTelegram, logActivity, checkRateLimit, RESEND_KEY } = ctx;

  switch (action) {
    // v2.9.7 — daftar insurer aktif untuk UI mitra/B2B. Setiap sesi yang
    // terotentikasi (B2B client, agent, admin) boleh membaca — hanya
    // id/code/name/logo yang dikembalikan, tanpa kontak PIC atau API config.
    case 'list_active_insurers': {
        if (!caller.authId) return json({ error: 'Login required' }, 401);
        // v2.9.15 — field tampilan clay ikut dikirim, bukan kontak PIC/API.
        const { data, error } = await db.from('sp_insurers')
          .select('id, code, name, description, logo_url, accent_color, icon, sort_order, highlight_bullets, featured')
          .eq('is_active', true)
          .order('sort_order', { ascending: true })
          .order('name', { ascending: true });
        if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
        return json({ data: data ?? [] });
      }

    case 'admin_list_insurer_tokens': {
        if (!caller.isCoreAdmin) return json({ error: 'Forbidden: core admin only' }, 403);
        const { data, error } = await db.from('sp_insurer_auth_tokens')
          .select('id, insurer_id, token, email, expires_at, used_at, created_at')
          .order('created_at', { ascending: false })
          .limit(Number(params.limit ?? 200));
        if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
        // Enrich with insurer name
        const insurerIds = [...new Set((data ?? []).map((t: any) => t.insurer_id))];
        const { data: insurers } = await db.from('sp_insurers')
          .select('id, name')
          .in('id', insurerIds);
        const insurerMap: Record<string, string> = {};
        for (const ins of (insurers ?? [])) insurerMap[ins.id] = ins.name;
        const enriched = (data ?? []).map((t: any) => ({ ...t, insurer_name: insurerMap[t.insurer_id] ?? 'Unknown' }));
        return json({ data: enriched });
      }

    case 'admin_revoke_insurer_token': {
        if (!caller.isCoreAdmin) return json({ error: 'Forbidden: core admin only' }, 403);
        const tokenId = String(params.token_id ?? '');
        if (!tokenId) return json({ error: 'token_id required' }, 400);
        const { error } = await db.from('sp_insurer_auth_tokens').delete().eq('id', tokenId);
        if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
        // Audit notification
        db.from('sp_admin_notifications').insert({
          type: 'INSURER_TOKEN_REVOKED',
          title: 'Token Insurer Dihapus',
          body: `Admin menghapus token akses insurer.`,
          read: false,
          metadata: { token_id: tokenId, revoked_by: caller.authId },
        }).then(() => {}, () => {});
        return json({ data: { success: true } });
      }

    case 'admin_generate_insurer_token': {
        if (!caller.isCoreAdmin) return json({ error: 'Forbidden: core admin only' }, 403);
        const insurerId = String(params.insurer_id ?? '');
        if (!insurerId) return json({ error: 'insurer_id required' }, 400);
        // Fetch insurer
        const { data: ins, error: insErr } = await db.from('sp_insurers')
          .select('id, name, pic_email, admin_email')
          .eq('id', insurerId)
          .maybeSingle();
        if (insErr) { const _err = safeError(insErr); return json(_err.body, _err.status); }
        if (!ins) return json({ error: 'Insurer not found' }, 404);
        const email = ins.pic_email || ins.admin_email;
        if (!email) return json({ error: 'Insurer has no email configured (pic_email or admin_email)' }, 400);
        // Generate new token (7-day rolling)
        const newToken = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        // FIX v2.7.56 (audit): simpan hash, bukan plaintext. Bila kolom
        // token_hash belum ada (migration belum jalan), simpan seperti lama.
        const tokenHash = await sha256Hex(newToken);
        let tkErr: { message: string } | null = null;
        const insertWithHash = await db.from('sp_insurer_auth_tokens').insert({
          insurer_id: insurerId,
          token: newToken,
          token_hash: tokenHash,
          email,
          expires_at: expiresAt,
        });
        tkErr = insertWithHash.error;
        if (tkErr && /token_hash/i.test(tkErr.message)) {
          const retry = await db.from('sp_insurer_auth_tokens').insert({
            insurer_id: insurerId,
            token: newToken,
            email,
            expires_at: expiresAt,
          });
          tkErr = retry.error;
        }
        if (tkErr) { const _err = safeError(tkErr); return json(_err.body, _err.status); }
        const magicLink = `https://myinsurepath.com/insurerapp?token=${newToken}`;
        // Audit notification
        db.from('sp_admin_notifications').insert({
          type: 'INSURER_TOKEN_GENERATED',
          title: 'Token Insurer Baru Dibuat',
          body: `Token akses baru untuk ${ins.name}. Link: ${magicLink}`,
          read: false,
          metadata: { insurer_id: insurerId, token_id: newToken, generated_by: caller.authId },
        }).then(() => {}, () => {});
        return json({ data: { success: true, token: newToken, magic_link: magicLink, insurer_name: ins.name, email } });
      }

    case 'admin_list_review_tokens': {
        // v2.9.17: token review = kunci masuk ke /review/:uuid (bisa
        // menyetujui/menolak polis atas nama insurer). Hanya peran inti.
        if (!caller.isCoreAdmin) return json({ error: 'Forbidden: core admin only' }, 403);
        const { data, error } = await db.from('sp_review_tokens')
          .select('id, token, order_id, expires_at, insurer_action, insurer_notes, actioned_at, accessed_count, last_accessed_at, created_at, review_url')
          .order('created_at', { ascending: false })
          .limit(Number(params.limit ?? 200));
        if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
        // Enrich with order info
        const orderIds = [...new Set((data ?? []).map((t: any) => t.order_id))];
        const { data: orders } = await db.from('sp_policy_orders')
          .select('id, order_number, client_name, product_name, insurer_name, status')
          .in('id', orderIds);
        const orderMap: Record<string, any> = {};
        for (const o of (orders ?? [])) orderMap[o.id] = o;
        const enriched = (data ?? []).map((t: any) => ({
          ...t,
          order_number: orderMap[t.order_id]?.order_number ?? null,
          client_name: orderMap[t.order_id]?.client_name ?? null,
          product_name: orderMap[t.order_id]?.product_name ?? null,
          insurer_name: orderMap[t.order_id]?.insurer_name ?? null,
          order_status: orderMap[t.order_id]?.status ?? null,
        }));
        return json({ data: enriched });
      }

    case 'admin_list_insurer_activity': {
        if (!caller.isAdmin) return json({ error: 'Forbidden: admin only' }, 403);
        let q = db.from('sp_insurer_activity_log')
          .select('id, insurer_id, order_id, action, details, ip_address, user_agent, created_at')
          .order('created_at', { ascending: false })
          .limit(Number(params.limit ?? 100));
        if (params.insurer_id) q = q.eq('insurer_id', params.insurer_id);
        if (params.action) q = q.eq('action', params.action);
        const { data, error } = await q;
        if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
        // Enrich with insurer name + order number
        const insurerIds = [...new Set((data ?? []).map((l: any) => l.insurer_id).filter(Boolean))];
        const orderIds = [...new Set((data ?? []).map((l: any) => l.order_id).filter(Boolean))];
        const [insRes, ordRes] = await Promise.all([
          insurerIds.length > 0 ? db.from('sp_insurers').select('id, name').in('id', insurerIds) : Promise.resolve({ data: [] }),
          orderIds.length > 0 ? db.from('sp_policy_orders').select('id, order_number, client_name').in('id', orderIds) : Promise.resolve({ data: [] }),
        ]);
        const insMap: Record<string, string> = {};
        for (const i of (insRes.data ?? [])) insMap[i.id] = i.name;
        const ordMap: Record<string, any> = {};
        for (const o of (ordRes.data ?? [])) ordMap[o.id] = o;
        const enriched = (data ?? []).map((l: any) => ({
          ...l,
          insurer_name: l.insurer_id ? (insMap[l.insurer_id] ?? 'Unknown') : null,
          order_number: l.order_id ? (ordMap[l.order_id]?.order_number ?? null) : null,
          client_name: l.order_id ? (ordMap[l.order_id]?.client_name ?? null) : null,
        }));
        return json({ data: enriched });
      }

    case 'admin_get_insurer_api_config': {
        if (!caller.isCoreAdmin) return json({ error: 'Forbidden: core admin only' }, 403);
        const insurerId = String(params.insurer_id ?? '');
        if (!insurerId) return json({ error: 'insurer_id required' }, 400);
        const { data, error } = await db.from('sp_insurer_api_configs')
          .select('*')
          .eq('insurer_id', insurerId)
          .maybeSingle();
        if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
        return json({ data });
      }

    case 'admin_create_insurer': {
        if (!caller.isCoreAdmin) return json({ error: 'Forbidden: core admin only' }, 403);
        const clay = clayPatch(params, { icon: 'building' });
        const bullets = parseHighlightBullets(params.highlight_bullets);
        const sortOrder = Number(params.sort_order ?? 0);
        if (!clay.ok || !bullets.ok || !Number.isFinite(sortOrder)) {
          return json({ error: clay.error ?? 'sort_order / highlight_bullets tidak valid' }, 400);
        }
        const { data, error } = await db.from('sp_insurers').insert({
          name: String(params.name ?? ''), code: String(params.code ?? ''),
          description: String(params.description ?? ''), is_active: true,
          admin_name: String(params.admin_name ?? ''), admin_email: String(params.admin_email ?? ''),
          pic_name: String(params.pic_name ?? ''), pic_email: String(params.pic_email ?? ''),
          pic_phone: String(params.pic_phone ?? ''),
          ...clay.patch,
          icon: (clay.patch.icon as string | undefined) ?? 'building',
          sort_order: Math.max(-999, Math.min(999, Math.trunc(sortOrder))),
          highlight_bullets: bullets.value,
          featured: clay.patch.featured === true,
        }).select().single();
        if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
        logActivity(null, null, 'INSURER_CREATED', { insurer_id: (data as any)?.id, name: params.name });
        return json({ data });
      }

    case 'admin_update_insurer': {
        if (!caller.isCoreAdmin) return json({ error: 'Forbidden: core admin only' }, 403);
        const insurerId = String(params.insurer_id ?? '');
        if (!insurerId) return json({ error: 'insurer_id required' }, 400);
        const ALLOWED = ['name', 'code', 'description', 'is_active', 'admin_name', 'admin_email', 'pic_name', 'pic_email', 'pic_phone', 'logo_url'];
        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
        for (const k of ALLOWED) { if (k in params) updates[k] = params[k]; }
        // v2.9.15 — patch hanya field yang dikirim; toggle status tidak boleh
        // menghapus warna/ikon/bullet yang sudah diatur admin.
        const clay = clayPatch(params, { icon: 'building' });
        if (!clay.ok) return json({ error: clay.error }, 400);
        Object.assign(updates, clay.patch);
        if ('sort_order' in params) {
          const sortOrder = Number(params.sort_order);
          if (!Number.isFinite(sortOrder)) return json({ error: 'sort_order tidak valid' }, 400);
          updates.sort_order = Math.max(-999, Math.min(999, Math.trunc(sortOrder)));
        }
        if ('highlight_bullets' in params) {
          const bullets = parseHighlightBullets(params.highlight_bullets);
          if (!bullets.ok) return json({ error: 'highlight_bullets harus array string' }, 400);
          updates.highlight_bullets = bullets.value;
        }
        const { data, error } = await db.from('sp_insurers').update(updates).eq('id', insurerId).select().maybeSingle();
        if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
        return json({ data });
      }

    case 'admin_delete_insurer': {
        if (!caller.isCoreAdmin) return json({ error: 'Forbidden: core admin only' }, 403);
        const insurerId = String(params.insurer_id ?? '');
        if (!insurerId) return json({ error: 'insurer_id required' }, 400);
        const { error } = await db.from('sp_insurers').delete().eq('id', insurerId);
        if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
        logActivity(insurerId, null, 'INSURER_DELETED', { insurer_id: insurerId });
        return json({ data: { success: true } });
      }

    case 'admin_save_insurer_product': {
        if (!caller.isCoreAdmin) return json({ error: 'Forbidden: core admin only' }, 403);
        // 2026-11-23 — formulir Edit di admin tidak mengirim insurer_id (field itu
        // memang tidak ada di ProductFormData), sehingga gateway menolak 400 dan
        // setiap perubahan produk kembali ke nilai lama tanpa pesan apa pun.
        // Saat id dikirim, insurer_id diambil dari baris yang sedang diedit.
        let insurerId = String(params.insurer_id ?? '');
        if (!insurerId && params.id) {
          const { data: existing, error: existingErr } = await db
            .from('sp_insurer_products')
            .select('insurer_id')
            .eq('id', String(params.id))
            .maybeSingle();
          if (existingErr) { const _err = safeError(existingErr); return json(_err.body, _err.status); }
          if (!existing) return json({ error: 'Produk tidak ditemukan', code: 'NOT_FOUND' }, 404);
          insurerId = String(existing.insurer_id ?? '');
        }
        if (!insurerId) return json({ error: 'insurer_id required' }, 400);
        const payload: Record<string, unknown> = {
          insurer_id: insurerId,
          product_type: String(params.product_type ?? 'CAR'),
          vehicle_coverage: String(params.vehicle_coverage ?? 'COMPREHENSIVE'),
          base_commission_rate: Number(params.base_commission_rate ?? 0.1),
          max_discount_rate: Number(params.max_discount_rate ?? 0.25),
          coin_rate: Number(params.coin_rate ?? 0),
          stamp_duty: Number(params.stamp_duty ?? 10000),
          policy_cost: Number(params.policy_cost ?? 50000),
          authorized_garage_rate: Number(params.authorized_garage_rate ?? 0.0025),
          authorized_garage_max_age_years: Number(params.authorized_garage_max_age_years ?? 5),
          is_active: params.is_active !== false,
        };
        // 0 berarti "tanpa batas usia"; truthy-check lama membuang nilai itu.
        if (params.max_vehicle_age_years !== undefined) {
          payload.max_vehicle_age_years = Number(params.max_vehicle_age_years) || 0;
        }
        // Kolom notes ada di tabel tetapi tidak pernah ikut ditulis, jadi catatan
        // admin hilang setiap produk disimpan.
        if (params.notes !== undefined) payload.notes = String(params.notes ?? '').slice(0, 1000);
        if (params.id) {
          const { data, error } = await db.from('sp_insurer_products').update(payload).eq('id', params.id).select().maybeSingle();
          if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
          if (!data) return json({ error: 'Produk tidak ditemukan', code: 'NOT_FOUND' }, 404);
          return json({ data });
        } else {
          const { data, error } = await db.from('sp_insurer_products').insert(payload).select().single();
          if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
          return json({ data });
        }
      }

    case 'admin_delete_insurer_product': {
        if (!caller.isCoreAdmin) return json({ error: 'Forbidden: core admin only' }, 403);
        const productId = String(params.product_id ?? '');
        if (!productId) return json({ error: 'product_id required' }, 400);
        const { error } = await db.from('sp_insurer_products').delete().eq('id', productId);
        if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
        return json({ data: { success: true } });
      }

    // 2026-11-23 — sp_product_configs hanya punya policy SELECT untuk anon dan
    // authenticated (migrasi 20260603_tighten_tier3_rls). UI admin menulis
    // langsung ke tabel, jadi UPDATE mengenai 0 baris tanpa error — kartu
    // menampilkan "Tersimpan" lalu nilainya kembali seperti semula — dan INSERT
    // ditolak RLS. Semua tulis sekarang lewat service_role di sini.
    case 'admin_save_product_config': {
        if (!caller.isCoreAdmin) return json({ error: 'Forbidden: core admin only' }, 403);

        const VEHICLE_TYPES = ['CAR', 'MOTORCYCLE', 'ALL'];
        const COVERAGE_TYPES = ['COMPREHENSIVE', 'TLO', 'ALL'];
        const RATE_BANDS = ['MIN', 'MID', 'MAX'];

        // Persentase disimpan sebagai pecahan 0–1; di luar rentang itu bukan
        // nilai yang bisa dipakai kalkulator.
        const rate = (key: string, fallback: number): number => {
          const raw = Number(params[key]);
          if (!Number.isFinite(raw)) return fallback;
          return Math.round(Math.min(1, Math.max(0, raw)) * 10000) / 10000;
        };

        const patch: Record<string, unknown> = {};
        if ('product_code' in params) patch.product_code = String(params.product_code ?? '').trim().toUpperCase();
        if ('product_name' in params) patch.product_name = String(params.product_name ?? '').trim();
        if ('vehicle_type' in params) {
          const value = String(params.vehicle_type);
          if (!VEHICLE_TYPES.includes(value)) return json({ error: 'vehicle_type tidak valid', code: 'VALIDATION_FAILED' }, 400);
          patch.vehicle_type = value;
        }
        if ('coverage_type' in params) {
          const value = String(params.coverage_type);
          if (!COVERAGE_TYPES.includes(value)) return json({ error: 'coverage_type tidak valid', code: 'VALIDATION_FAILED' }, 400);
          patch.coverage_type = value;
        }
        if ('rate_band' in params) {
          const value = String(params.rate_band);
          if (!RATE_BANDS.includes(value)) return json({ error: 'rate_band tidak valid', code: 'VALIDATION_FAILED' }, 400);
          patch.rate_band = value;
        }
        if ('is_active' in params) patch.is_active = params.is_active !== false;
        if ('notes' in params) patch.notes = String(params.notes ?? '').slice(0, 1000);
        if ('base_commission_rate' in params) patch.base_commission_rate = rate('base_commission_rate', 0.1);
        if ('max_discount_rate' in params) patch.max_discount_rate = rate('max_discount_rate', 0);
        if ('coin_rate' in params) patch.coin_rate = rate('coin_rate', 0);
        // Diskon tidak boleh melebihi komisi (aturan bisnis yang sama dengan UI).
        if (typeof patch.base_commission_rate === 'number' &&
            typeof patch.max_discount_rate === 'number' &&
            patch.max_discount_rate > patch.base_commission_rate) {
          patch.max_discount_rate = patch.base_commission_rate;
        }
        patch.updated_at = new Date().toISOString();

        const configId = params.id ? String(params.id) : '';
        if (configId) {
          const { data, error } = await db
            .from('sp_product_configs')
            .update(patch)
            .eq('id', configId)
            .select()
            .maybeSingle();
          if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
          if (!data) return json({ error: 'Konfigurasi produk tidak ditemukan', code: 'NOT_FOUND' }, 404);
          return json({ data });
        }

        if (!patch.product_code) return json({ error: 'Kode produk wajib diisi', code: 'VALIDATION_FAILED' }, 400);
        if (!patch.product_name) return json({ error: 'Nama produk wajib diisi', code: 'VALIDATION_FAILED' }, 400);
        const { data, error } = await db
          .from('sp_product_configs')
          .insert({
            vehicle_type: 'CAR',
            coverage_type: 'ALL',
            base_commission_rate: 0.1,
            max_discount_rate: 0,
            coin_rate: 0,
            rate_band: 'MID',
            is_active: true,
            ...patch,
          })
          .select()
          .single();
        if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
        return json({ data });
      }

    case 'admin_save_ojk_rate_set': {
        if (!caller.isRateAdmin) return json({ error: 'Forbidden: rate admin only' }, 403);
        const { data, error } = await db.from('sp_ojk_rate_sets').insert({
          version: String(params.version ?? ''),
          source_reference: String(params.source_reference ?? ''),
          effective_date: String(params.effective_date ?? new Date().toISOString().slice(0, 10)),
          is_active: false,
          rates: params.rates ?? {},
        }).select().single();
        if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
        return json({ data });
      }

    case 'admin_activate_ojk_rate_set': {
        if (!caller.isRateAdmin) return json({ error: 'Forbidden: rate admin only' }, 403);
        const rateSetId = String(params.rate_set_id ?? '');
        if (!rateSetId) return json({ error: 'rate_set_id required' }, 400);
        await db.from('sp_ojk_rate_sets').update({ is_active: false }).eq('is_active', true);
        const { data, error } = await db.from('sp_ojk_rate_sets').update({ is_active: true, updated_at: new Date().toISOString() }).eq('id', rateSetId).select().maybeSingle();
        if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
        return json({ data });
      }

    case 'admin_delete_ojk_rate_set': {
        if (!caller.isRateAdmin) return json({ error: 'Forbidden: rate admin only' }, 403);
        const rateSetId = String(params.rate_set_id ?? '');
        if (!rateSetId) return json({ error: 'rate_set_id required' }, 400);
        const { error } = await db.from('sp_ojk_rate_sets').delete().eq('id', rateSetId);
        if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
        return json({ data: { success: true } });
      }

    case 'admin_save_insurer_api_config': {
        if (!caller.isCoreAdmin) return json({ error: 'Forbidden: core admin only' }, 403);
        const insurerId = String(params.insurer_id ?? '');
        const endpointUrl = String(params.endpoint_url ?? '');
        const apiKey = String(params.api_key ?? '');
        const webhookSecret = String(params.webhook_secret ?? '');
        const isActive = params.is_active !== false;
        if (!insurerId || !endpointUrl) return json({ error: 'insurer_id and endpoint_url required' }, 400);
        // SSRF guard: block private IPs + localhost
        const isPrivate = /^(https?:\/\/)(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|::1|fc00:|fe80:)/i.test(endpointUrl);
        if (isPrivate) return json({ error: 'Endpoint URL tidak boleh private/localhost' }, 400);
        const { data, error } = await db.from('sp_insurer_api_configs')
          .upsert({
            insurer_id: insurerId,
            endpoint_url: endpointUrl,
            api_key: apiKey || null,
            webhook_secret: webhookSecret || null,
            is_active: isActive,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'insurer_id' })
          .select()
          .maybeSingle();
        if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
        logActivity(insurerId, null, 'API_CONFIG_SAVED', { endpoint_url: endpointUrl, is_active: isActive });
        return json({ data });
      }

    case 'get_insurer_review': {
        const token = String(params.token ?? '');
        if (!token) return json({ error: 'token required' }, 400);
        // Load token
        const { data: rt, error: rtErr } = await db.from('sp_review_tokens')
          .select('id, token, order_id, expires_at, insurer_action, insurer_notes, actioned_at, accessed_count, reminder_count')
          .eq('token', token)
          .maybeSingle();
        if (rtErr) { const _err = safeError(rtErr); return json(_err.body, _err.status); }
        if (!rt) return json({ error: 'Invalid token' }, 404);
        if (new Date(rt.expires_at) < new Date()) return json({ error: 'Token expired' }, 410);
        // Increment accessed_count (non-blocking)
        db.from('sp_review_tokens').update({ accessed_count: (rt.accessed_count ?? 0) + 1, last_accessed_at: new Date().toISOString() })
          .eq('id', rt.id).then(() => {}, () => {});
        // Load order
        const { data: order, error: ordErr } = await db.from('sp_policy_orders')
          .select('*')
          .eq('id', rt.order_id)
          .maybeSingle();
        if (ordErr) { const _err = safeError(ordErr); return json(_err.body, _err.status); }
        if (!order) return json({ error: 'Order not found' }, 404);
        // Load insurer info
        let insurer: any = null;
        if (order.insurer_id) {
          const { data: ins } = await db.from('sp_insurers')
            .select('id, name, logo_url, admin_name, admin_email, pic_name, pic_email, pic_phone')
            .eq('id', order.insurer_id)
            .maybeSingle();
          insurer = ins;
        }
        // ── Log activity (review page opened) ───────────────────────────────
        logActivity(order.insurer_id ?? null, rt.order_id, 'REVIEW_OPENED', { token_id: rt.id, accessed_count: (rt.accessed_count ?? 0) + 1 });
        return json({ data: { token: rt, order, insurer } });
      }

    case 'submit_insurer_decision': {
        const token = String(params.token ?? '');
        const action = String(params.action ?? '');
        const notes = String(params.notes ?? '');
        if (!token || !action) return json({ error: 'token and action required' }, 400);
        const VALID_ACTIONS = ['APPROVED', 'REQUEST_INFO', 'DECLINED'];
        if (!VALID_ACTIONS.includes(action)) return json({ error: 'Invalid action' }, 400);
        // Notes required for REQUEST_INFO and DECLINED
        if ((action === 'REQUEST_INFO' || action === 'DECLINED') && notes.trim().length < 5) {
          return json({ error: 'Notes required (min 5 chars) for REQUEST_INFO and DECLINED' }, 400);
        }
        // Load token
        const { data: rt, error: rtErr } = await db.from('sp_review_tokens')
          .select('id, order_id, expires_at, insurer_action')
          .eq('token', token)
          .maybeSingle();
        if (rtErr) { const _err = safeError(rtErr); return json(_err.body, _err.status); }
        if (!rt) return json({ error: 'Invalid token' }, 404);
        if (new Date(rt.expires_at) < new Date()) return json({ error: 'Token expired' }, 410);
        if (rt.insurer_action) return json({ error: 'Token already acted on', existing_action: rt.insurer_action }, 409);
        // FIX v2.7.56 (audit): cermin gerbang jalur authed — keputusan hanya
        // saat aplikasi masih hidup (SUBMITTED/UNDER_REVIEW). Sebelumnya jalur
        // review-token bisa menimpa status terminal (ISSUED, CANCELLED, dll).
        const { data: currentOrder, error: curErr } = await db.from('sp_policy_orders')
          .select('id, status')
          .eq('id', rt.order_id)
          .maybeSingle();
        if (curErr) { const _err = safeError(curErr); return json(_err.body, _err.status); }
        if (!currentOrder) return json({ error: 'Order not found' }, 404);
        if (currentOrder.status !== 'SUBMITTED' && currentOrder.status !== 'UNDER_REVIEW') {
          return json({ error: `Order tidak dapat diputuskan pada status ${currentOrder.status}.` }, 409);
        }
        // Update token
        const ts = new Date().toISOString();
        const { error: updTokenErr } = await db.from('sp_review_tokens').update({
          insurer_action: action,
          insurer_notes: notes,
          actioned_at: ts,
        }).eq('id', rt.id);
        if (updTokenErr) { const _err = safeError(updTokenErr); return json(_err.body, _err.status); }
        // Map insurer action → order status
        const orderStatus = action === 'APPROVED' ? 'APPROVED'
          : action === 'REQUEST_INFO' ? 'UNDER_REVIEW'
          : 'REJECTED'; // DECLINED → REJECTED
        // Update order
        const { data: order, error: ordErr } = await db.from('sp_policy_orders').update({
          status: orderStatus,
          insurer_decision: action,
          insurer_decision_notes: notes,
          insurer_decision_at: ts,
          insurer_review_token_id: rt.id,
          reviewer_notes: `Insurer ${action}: ${notes}`,
          reviewed_at: ts,
          updated_at: ts,
        }).eq('id', rt.order_id).select('id, order_number, client_name, agent_id, client_id, product_name, insurer_id').maybeSingle();
        if (ordErr) { const _err = safeError(ordErr); return json(_err.body, _err.status); }
        // Insert admin notification
        const decisionLabel = action === 'APPROVED' ? 'menyetujui' : action === 'REQUEST_INFO' ? 'meminta info tambahan untuk' : 'menolak';
        db.from('sp_admin_notifications').insert({
          type: `INSURER_${action}`,
          title: `Insurer ${decisionLabel} pengajuan`,
          body: `${order?.order_number ?? 'Order'} — ${order?.client_name ?? ''}: ${notes || '(tanpa catatan)'}`,
          order_id: rt.order_id,
          read: false,
          metadata: { order_id: rt.order_id, action, notes, insurer_id: order?.insurer_id },
        }).then(() => {}, () => {});
        // Insert notification for the agent AND the customer.
        //
        // sp_notifications has one owner column, agent_id, and every order
        // notification was written only for order.agent_id — so the customer
        // was never told what happened to their own application. One row per
        // recipient; agent_id here means "whose feed", not "an agent".
        //
        // Type was CLAIM_UPDATE, which is a different thing entirely. An order
        // decision is ORDER_UPDATE.
        {
          const userTitle = action === 'APPROVED' ? 'Pengajuan polis disetujui insurer'
            : action === 'REQUEST_INFO' ? 'Insurer meminta info tambahan'
            : 'Pengajuan polis ditolak insurer';
          const userBody = `${order?.order_number ?? ''}: ${notes || 'Mohon lengkapi persyaratan dari insurer.'}`;
          const recipients = [...new Set([order?.agent_id, order?.client_id].filter(Boolean))];
          for (const recipient of recipients) {
            db.from('sp_notifications').insert({
              agent_id: recipient,
              type: 'ORDER_UPDATE',
              title: userTitle,
              body: userBody,
              read: false,
              metadata: { order_id: rt.order_id, action, notes },
            }).then(() => {}, () => {});
          }
        }
        // Send Telegram alert to admin team
        const tgTime = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        sendTelegram(
          `Insurer Decision - SurePath\n\n` +
          `Order: ${order?.order_number ?? rt.order_id}\n` +
          `Nasabah: ${order?.client_name ?? '-'}\n` +
          `Decision: ${action}\n` +
          `Notes: ${notes || '-'}\n` +
          `Waktu: ${tgTime} WIB`
        );
        // ── Log activity ────────────────────────────────────────────────────
        logActivity(order?.insurer_id ?? null, rt.order_id, 'DECISION_SUBMITTED', { action, notes, via: 'review_token' });
        return json({ data: { success: true, order_status: orderStatus, action } });
      }

    case 'get_insurer_dashboard': {
        const token = String(params.token ?? '');
        if (!token) return json({ error: 'token required' }, 400);
        // FIX v2.7.56 (audit): validasi hash-first (fallback plaintext lama).
        const { data: authToken, error: authErr } = await findInsurerAuthToken(db, token);
        if (authErr) { const _err = safeError(authErr); return json(_err.body, _err.status); }
        if (!authToken) return json({ error: 'Invalid token' }, 404);
        if (new Date(authToken.expires_at) < new Date()) return json({ error: 'Token expired' }, 410);
        // ── Rate limit per insurer (200 req/hour) ───────────────────────────
        const insurerAllowed = await checkRateLimit(`insurer:${authToken.insurer_id}`, 200);
        if (!insurerAllowed) {
          return json({ error: 'Rate limit exceeded untuk insurer ini. Coba lagi dalam 1 jam.' }, 429);
        }
        // Load insurer
        const { data: insurer, error: insErr } = await db.from('sp_insurers')
          .select('id, name, logo_url, admin_name, admin_email, pic_name, pic_email, pic_phone')
          .eq('id', authToken.insurer_id)
          .maybeSingle();
        if (insErr) { const _err = safeError(insErr); return json(_err.body, _err.status); }
        if (!insurer) return json({ error: 'Insurer not found' }, 404);
        // ── Log activity ────────────────────────────────────────────────────
        logActivity(authToken.insurer_id, null, 'DASHBOARD_VIEWED', { email: authToken.email });
        // Load orders for this insurer
        const { data: orders, error: ordErr } = await db.from('sp_policy_orders')
          .select('id, order_number, client_name, client_phone, product_name, product_code, coverage_type, sum_insured, total_premium, net_premium, status, insurer_decision, insurer_decision_notes, insurer_decision_at, policy_number, policy_document_url, vehicle_image_url, vehicle_details, created_at, reviewed_at, issued_at')
          .eq('insurer_id', insurer.id)
          .order('created_at', { ascending: false })
          .limit(200);
        if (ordErr) { const _err = safeError(ordErr); return json(_err.body, _err.status); }
        // KPI counts
        const kpi = {
          total: orders?.length ?? 0,
          pending: (orders ?? []).filter((o: any) => !o.insurer_decision).length,
          approved: (orders ?? []).filter((o: any) => o.insurer_decision === 'APPROVED').length,
          request_info: (orders ?? []).filter((o: any) => o.insurer_decision === 'REQUEST_INFO').length,
          declined: (orders ?? []).filter((o: any) => o.insurer_decision === 'DECLINED').length,
          issued: (orders ?? []).filter((o: any) => o.status === 'ISSUED').length,
        };
        // FIX v2.7.56 (audit): rolling renewal diberi pagu — perpanjang hanya
        // saat masa berlaku tersisa < 2 hari. Token bocor tidak lagi hidup
        // selamanya hanya karena dipakai; maksimum usia = 7 hari + pemakaian.
        const remainingMs = new Date(authToken.expires_at).getTime() - Date.now();
        const withinRenewalWindow = remainingMs < 2 * 24 * 60 * 60 * 1000;
        const finalExpiry = withinRenewalWindow
          ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
          : authToken.expires_at;
        if (withinRenewalWindow) {
          db.from('sp_insurer_auth_tokens').update({ expires_at: finalExpiry, used_at: new Date().toISOString() })
            .eq('id', authToken.id).then(() => {}, () => {});
        } else {
          db.from('sp_insurer_auth_tokens').update({ used_at: new Date().toISOString() })
            .eq('id', authToken.id).then(() => {}, () => {});
        }
        return json({ data: { insurer, orders: orders ?? [], kpi, token_expires_at: finalExpiry } });
      }

    // FIX v2.7.56 (audit): invalidasi sisi server saat logout portal insurer.
    // Sebelumnya logout hanya membersihkan sessionStorage; token bearer tetap
    // hidup sampai rolling expiry-nya habis.
    case 'insurer_logout': {
        const token = String(params.token ?? '');
        const tokenHash = await sha256Hex(token);
        const del = await db.from('sp_insurer_auth_tokens').delete().eq('token_hash', tokenHash);
        if (del.error && /token_hash/i.test(del.error.message ?? '')) {
          if (!UUID_RE.test(token)) return json({ error: 'Invalid token' }, 400);
          await db.from('sp_insurer_auth_tokens').delete().eq('token', token);
        }
        return json({ data: { success: true } });
      }

    case 'insurer_submit_decision_authed': {
        const token = String(params.token ?? '');
        const orderId = String(params.order_id ?? '');
        const action = String(params.action ?? '');
        const notes = String(params.notes ?? '');
        if (!token || !orderId || !action) return json({ error: 'token, order_id, action required' }, 400);
        const VALID_ACTIONS = ['APPROVED', 'REQUEST_INFO', 'DECLINED'];
        if (!VALID_ACTIONS.includes(action)) return json({ error: 'Invalid action' }, 400);
        if ((action === 'REQUEST_INFO' || action === 'DECLINED') && notes.trim().length < 5) {
          return json({ error: 'Notes required (min 5 chars) for REQUEST_INFO and DECLINED' }, 400);
        }
        // Validate auth token
        const { data: authToken, error: authErr } = await db.from('sp_insurer_auth_tokens')
          .select('id, insurer_id, expires_at')
          .eq('token', token)
          .maybeSingle();
        if (authErr) { const _err = safeError(authErr); return json(_err.body, _err.status); }
        if (!authToken) return json({ error: 'Invalid token' }, 404);
        if (new Date(authToken.expires_at) < new Date()) return json({ error: 'Token expired' }, 410);
        // Verify order belongs to this insurer
        const { data: order, error: ordErr } = await db.from('sp_policy_orders')
          .select('id, order_number, client_name, agent_id, client_id, product_name, insurer_id, status, insurer_decision')
          .eq('id', orderId)
          .eq('insurer_id', authToken.insurer_id)
          .maybeSingle();
        if (ordErr) { const _err = safeError(ordErr); return json(_err.body, _err.status); }
        if (!order) return json({ error: 'Order not found or not assigned to your insurer' }, 404);
        // A decision can only be made while the application is live. Issued,
        // rejected and cancelled orders are terminal.
        if (order.status !== 'SUBMITTED' && order.status !== 'UNDER_REVIEW') {
          return json({ error: `Order tidak dapat diputuskan pada status ${order.status}.` }, 409);
        }
        // REQUEST_INFO is not terminal: once the customer/agent answers, the
        // insurer must be able to approve or decline the same order. Only an
        // APPROVED/DECLINED decision is final.
        if (order.insurer_decision && order.insurer_decision !== 'REQUEST_INFO') {
          return json({ error: 'Order already has a decision', existing_action: order.insurer_decision }, 409);
        }
        // Map action → order status
        const orderStatus = action === 'APPROVED' ? 'APPROVED'
          : action === 'REQUEST_INFO' ? 'UNDER_REVIEW' : 'REJECTED';
        const ts = new Date().toISOString();
        const { error: updErr } = await db.from('sp_policy_orders').update({
          status: orderStatus,
          insurer_decision: action,
          insurer_decision_notes: notes,
          insurer_decision_at: ts,
          reviewer_notes: `Insurer ${action}: ${notes}`,
          reviewed_at: ts,
          updated_at: ts,
        }).eq('id', orderId);
        if (updErr) { const _err = safeError(updErr); return json(_err.body, _err.status); }
        // Notifications
        const decisionLabel = action === 'APPROVED' ? 'menyetujui' : action === 'REQUEST_INFO' ? 'meminta info tambahan untuk' : 'menolak';
        db.from('sp_admin_notifications').insert({
          type: `INSURER_${action}`,
          title: `Insurer ${decisionLabel} pengajuan`,
          body: `${order.order_number} — ${order.client_name}: ${notes || '(tanpa catatan)'}`,
          order_id: orderId,
          read: false,
          metadata: { order_id: orderId, action, notes, insurer_id: authToken.insurer_id },
        }).then(() => {}, () => {});
        // Agent and customer both, for the reasons given on the review-token
        // path above.
        {
          const userTitle = action === 'APPROVED' ? 'Pengajuan polis disetujui insurer'
            : action === 'REQUEST_INFO' ? 'Insurer meminta info tambahan'
            : 'Pengajuan polis ditolak insurer';
          const recipients = [...new Set([order.agent_id, order.client_id].filter(Boolean))];
          for (const recipient of recipients) {
            db.from('sp_notifications').insert({
              agent_id: recipient,
              type: 'ORDER_UPDATE',
              title: userTitle,
              body: `${order.order_number}: ${notes || 'Mohon lengkapi persyaratan dari insurer.'}`,
              read: false,
              metadata: { order_id: orderId, action, notes },
            }).then(() => {}, () => {});
          }
        }
        sendTelegram(
          `Insurer Decision (Dashboard) - SurePath\n\nOrder: ${order.order_number}\nNasabah: ${order.client_name}\nDecision: ${action}\nNotes: ${notes || '-'}`
        );
        // ── Log activity ────────────────────────────────────────────────────
        logActivity(authToken.insurer_id, orderId, 'DECISION_SUBMITTED', { action, notes, via: 'dashboard' });
        return json({ data: { success: true, order_status: orderStatus, action } });
      }

    // ── Insurer: list corporate B2B submissions assigned by admin ─────────
    case 'insurer_list_b2b_submissions': {
        const token = String(params.token ?? '');
        if (!token) return json({ error: 'token required' }, 400);
        const { data: authToken, error: authErr } = await findInsurerAuthToken(db, token);
        if (authErr) { const _err = safeError(authErr); return json(_err.body, _err.status); }
        if (!authToken) return json({ error: 'Invalid token' }, 404);
        if (new Date(authToken.expires_at) < new Date()) return json({ error: 'Token expired' }, 410);
        const allowed = await checkRateLimit(`insurer:${authToken.insurer_id}`, 200);
        if (!allowed) return json({ error: 'Rate limit exceeded' }, 429);

        const { data: assignments, error: assignmentErr } = await db.from('sp_b2b_submission_insurers')
          .select('id, submission_id, insurer_id, status, decision_notes, authorization_confirmed_at, created_at, updated_at, quoted_at')
          .eq('insurer_id', authToken.insurer_id)
          .order('created_at', { ascending: false })
          .limit(100);
        if (assignmentErr) { const _err = safeError(assignmentErr); return json(_err.body, _err.status); }
        const submissionIds = [...new Set((assignments ?? []).map((a: any) => a.submission_id))];
        if (submissionIds.length === 0) return json({ data: [] });

        const { data: submissions, error: submissionErr } = await db.from('sp_b2b_submissions')
          .select('id, client_id, product_type, company_name, pic_name, pic_phone, pic_email, submission_data, status, created_at, updated_at')
          .in('id', submissionIds);
        if (submissionErr) { const _err = safeError(submissionErr); return json(_err.body, _err.status); }
        const byId = new Map((submissions ?? []).map((s: any) => [s.id, s]));
        const { data: rawDocs, error: docsErr } = await db.from('sp_b2b_documents')
          .select('id, submission_id, doc_type, file_name, file_path, file_size, mime_type, uploaded_at')
          .in('submission_id', submissionIds)
          .order('uploaded_at', { ascending: true });
        if (docsErr) { const _err = safeError(docsErr); return json(_err.body, _err.status); }

        // The insurer has no Supabase JWT. Issue short-lived URLs only after
        // validating the insurer token and matching the assigned submission.
        const signedDocs: any[] = [];
        const docs = rawDocs ?? [];
        for (let i = 0; i < docs.length; i += 20) {
          const wave = docs.slice(i, i + 20);
          const signedWave = await Promise.all(wave.map(async (doc: any) => {
            const { data: signed } = await db.storage.from('b2b-documents').createSignedUrl(doc.file_path, 300);
            return {
              id: doc.id,
              submission_id: doc.submission_id,
              doc_type: doc.doc_type,
              file_name: doc.file_name,
              file_size: doc.file_size,
              mime_type: doc.mime_type,
              uploaded_at: doc.uploaded_at,
              signed_url: signed?.signedUrl ?? null,
            };
          }));
          signedDocs.push(...signedWave);
        }
        const docsBySubmission = new Map<string, any[]>();
        for (const doc of signedDocs) {
          const list = docsBySubmission.get(doc.submission_id) ?? [];
          list.push(doc);
          docsBySubmission.set(doc.submission_id, list);
        }
        const result = (assignments ?? []).flatMap((a: any) => {
          const submission = byId.get(a.submission_id);
          return submission ? [{ ...a, submission: { ...submission, documents: docsBySubmission.get(a.submission_id) ?? [] } }] : [];
        });
        logActivity(authToken.insurer_id, null, 'B2B_QUEUE_VIEWED', { count: result.length });
        return json({ data: result });
      }

    // ── Insurer: quote, request information, or decline an assigned B2B risk
    case 'insurer_submit_b2b_quote': {
        const token = String(params.token ?? '');
        const assignmentId = String(params.assignment_id ?? '').trim();
        const decision = String(params.decision ?? 'QUOTE').toUpperCase();
        const notes = String(params.notes ?? '').trim().slice(0, 5000);
        if (!token || !assignmentId) return json({ error: 'token and assignment_id required' }, 400);
        if (!['QUOTE', 'REQUEST_INFO', 'DECLINE'].includes(decision)) return json({ error: 'Invalid decision' }, 400);
        if ((decision === 'REQUEST_INFO' || decision === 'DECLINE') && notes.length < 5) {
          return json({ error: 'Notes required (minimum 5 characters)' }, 400);
        }

        const { data: authToken, error: authErr } = await findInsurerAuthToken(db, token);
        if (authErr) { const _err = safeError(authErr); return json(_err.body, _err.status); }
        if (!authToken) return json({ error: 'Invalid token' }, 404);
        if (new Date(authToken.expires_at) < new Date()) return json({ error: 'Token expired' }, 410);
        const allowed = await checkRateLimit(`insurer:${authToken.insurer_id}`, 200);
        if (!allowed) return json({ error: 'Rate limit exceeded' }, 429);

        const { data: assignment, error: assignmentErr } = await db.from('sp_b2b_submission_insurers')
          .select('id, submission_id, insurer_id, status, authorization_confirmed')
          .eq('id', assignmentId)
          .eq('insurer_id', authToken.insurer_id)
          .maybeSingle();
        if (assignmentErr) { const _err = safeError(assignmentErr); return json(_err.body, _err.status); }
        if (!assignment) return json({ error: 'Assignment not found for this insurer' }, 404);
        if (!assignment.authorization_confirmed) return json({ error: 'Submission assignment is missing authorization confirmation' }, 403);
        if (assignment.status !== 'ASSIGNED' && assignment.status !== 'REQUEST_INFO') {
          return json({ error: `Assignment already finalized (${assignment.status})` }, 409);
        }

        const { data: submission, error: submissionErr } = await db.from('sp_b2b_submissions')
          .select('id, client_id, company_name, product_type, status')
          .eq('id', assignment.submission_id)
          .maybeSingle();
        if (submissionErr) { const _err = safeError(submissionErr); return json(_err.body, _err.status); }
        if (!submission) return json({ error: 'Submission not found' }, 404);

        const { data: insurer, error: insurerErr } = await db.from('sp_insurers')
          .select('id, name, logo_url, is_active')
          .eq('id', authToken.insurer_id)
          .maybeSingle();
        if (insurerErr) { const _err = safeError(insurerErr); return json(_err.body, _err.status); }
        if (!insurer || insurer.is_active !== true) return json({ error: 'Insurer is inactive' }, 403);

        if (decision === 'REQUEST_INFO' || decision === 'DECLINE') {
          const nextStatus = decision === 'REQUEST_INFO' ? 'REQUEST_INFO' : 'DECLINED';
          const { data: changed, error: changeErr } = await db.from('sp_b2b_submission_insurers')
            .update({ status: nextStatus, decision_notes: notes, updated_at: new Date().toISOString() })
            .eq('id', assignment.id)
            .eq('insurer_id', authToken.insurer_id)
            .in('status', ['ASSIGNED', 'REQUEST_INFO'])
            .select('id, status')
            .maybeSingle();
          if (changeErr) { const _err = safeError(changeErr); return json(_err.body, _err.status); }
          if (!changed) return json({ error: 'Assignment was updated by another user; refresh and retry' }, 409);
          await db.from('sp_admin_notifications').insert({
            type: decision === 'REQUEST_INFO' ? 'B2B_INSURER_REQUEST_INFO' : 'B2B_INSURER_DECLINED',
            title: decision === 'REQUEST_INFO' ? 'Insurer meminta informasi B2B' : 'Insurer menolak pengajuan B2B',
            body: `${submission.company_name} — ${insurer.name}: ${notes}`,
            read: false,
            metadata: { submission_id: submission.id, assignment_id: assignment.id, insurer_id: insurer.id, decision },
          }).then(() => {}, () => {});
          db.from('sp_notifications').insert({
            agent_id: submission.client_id,
            type: 'B2B_UPDATE',
            title: decision === 'REQUEST_INFO' ? 'Insurer meminta informasi tambahan' : 'Pengajuan B2B ditolak insurer',
            body: `${insurer.name}: ${notes}`,
            read: false,
            metadata: { submission_id: submission.id, assignment_id: assignment.id, insurer_id: insurer.id, decision },
          }).then(() => {}, () => {});
          logActivity(insurer.id, null, 'B2B_SUBMISSION_DECIDED', { submission_id: submission.id, decision });
          return json({ data: { success: true, status: nextStatus } });
        }

        const premiumAmount = Number(params.premium_amount);
        const validUntil = String(params.valid_until ?? '').trim();
        const terms = String(params.terms ?? '').trim().slice(0, 10000);
        const rawCoverage = params.coverage_details && typeof params.coverage_details === 'object' && !Array.isArray(params.coverage_details)
          ? params.coverage_details as Record<string, unknown> : {};
        if (!Number.isFinite(premiumAmount) || premiumAmount <= 0 || premiumAmount > 1_000_000_000_000) {
          return json({ error: 'A valid positive premium amount is required' }, 400);
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil) || !Number.isFinite(Date.parse(`${validUntil}T00:00:00Z`)) ||
            new Date(`${validUntil}T00:00:00Z`).toISOString().slice(0, 10) !== validUntil ||
            new Date(`${validUntil}T23:59:59Z`).getTime() <= Date.now()) {
          return json({ error: 'A valid future valid_until date is required' }, 400);
        }
        let coverageBytes = 0;
        try { coverageBytes = new TextEncoder().encode(JSON.stringify(rawCoverage)).byteLength; }
        catch { return json({ error: 'Invalid coverage details' }, 400); }
        if (coverageBytes > 32 * 1024) return json({ error: 'Coverage details exceed the 32 KB limit' }, 413);
        const logoUrl = String(insurer.logo_url ?? '').trim();
        if (!/^https:\/\//i.test(logoUrl)) return json({ error: 'Insurer official HTTPS logo is not configured' }, 409);

        const ts = new Date().toISOString();
        // Claim the assignment before inserting a quote so concurrent submissions
        // cannot create duplicate insurer offers for the same assignment.
        const { data: claimed, error: claimErr } = await db.from('sp_b2b_submission_insurers')
          .update({ status: 'QUOTED', decision_notes: notes || null, quoted_at: ts, updated_at: ts })
          .eq('id', assignment.id)
          .eq('insurer_id', authToken.insurer_id)
          .in('status', ['ASSIGNED', 'REQUEST_INFO'])
          .select('id')
          .maybeSingle();
        if (claimErr) { const _err = safeError(claimErr); return json(_err.body, _err.status); }
        if (!claimed) return json({ error: 'Assignment was updated by another user; refresh and retry' }, 409);

        const coverageDetails = {
          ...Object.fromEntries(Object.entries(rawCoverage).filter(([key]) => !key.startsWith('__'))),
          __insurer_id: insurer.id,
          __insurer_logo_url: logoUrl,
          __source: 'INSURER_PORTAL',
          __assignment_id: assignment.id,
        };
        const { data: quote, error: quoteErr } = await db.from('sp_b2b_quotes').insert({
          submission_id: submission.id,
          client_id: submission.client_id,
          insurer_name: insurer.name,
          premium_amount: premiumAmount,
          coverage_details: coverageDetails,
          valid_until: validUntil,
          terms,
          status: 'PENDING',
        }).select().single();
        if (quoteErr) {
          await db.from('sp_b2b_submission_insurers')
            .update({ status: assignment.status, quoted_at: null, updated_at: new Date().toISOString() })
            .eq('id', assignment.id).eq('status', 'QUOTED');
          const _err = safeError(quoteErr); return json(_err.body, _err.status);
        }

        await db.from('sp_b2b_submissions').update({ status: 'QUOTED', updated_at: ts })
          .eq('id', submission.id).in('status', ['SUBMITTED', 'REVIEWING', 'QUOTED']);
        await db.from('sp_admin_notifications').insert({
          type: 'B2B_INSURER_QUOTE_RECEIVED',
          title: 'Penawaran B2B dari insurer diterima',
          body: `${submission.company_name} — ${insurer.name}: Rp ${Math.round(premiumAmount).toLocaleString('id-ID')}`,
          read: false,
          metadata: { submission_id: submission.id, quote_id: quote.id, assignment_id: assignment.id, insurer_id: insurer.id },
        }).then(() => {}, () => {});
        db.from('sp_notifications').insert({
          agent_id: submission.client_id,
          type: 'B2B_QUOTE_READY',
          title: 'Penawaran asuransi korporat tersedia',
          body: `${insurer.name} telah mengirim penawaran untuk ${submission.company_name}.`,
          read: false,
          metadata: { submission_id: submission.id, quote_id: quote.id, insurer_id: insurer.id },
        }).then(() => {}, () => {});
        logActivity(insurer.id, null, 'B2B_QUOTE_SUBMITTED', { submission_id: submission.id, quote_id: quote.id });
        sendTelegram(`Penawaran B2B diterima\nPerusahaan: ${submission.company_name}\nInsurer: ${insurer.name}\nPremi: Rp ${Math.round(premiumAmount).toLocaleString('id-ID')}`);
        return json({ data: { success: true, quote } });
      }

    case 'insurer_list_payments': {
        const token = String(params.token ?? '');
        if (!token) return json({ error: 'token required' }, 400);
        const { data: authToken, error: authErr } = await db.from('sp_insurer_auth_tokens')
          .select('id, insurer_id, expires_at')
          .eq('token', token)
          .maybeSingle();
        if (authErr) { const _err = safeError(authErr); return json(_err.body, _err.status); }
        if (!authToken) return json({ error: 'Invalid token' }, 404);
        if (new Date(authToken.expires_at) < new Date()) return json({ error: 'Token expired' }, 410);
        // Get all order IDs for this insurer
        const { data: orders } = await db.from('sp_policy_orders')
          .select('id, order_number, client_name, product_name, total_premium, insurer_id')
          .eq('insurer_id', authToken.insurer_id);
        const orderIds = (orders ?? []).map((o: any) => o.id);
        if (orderIds.length === 0) return json({ data: { payments: [], orders: [] } });
        // Fetch payments for these orders
        const { data: payments, error: payErr } = await db.from('sp_payments')
          .select('id, order_id, amount, currency, status, payment_method, payment_channel, paid_amount, paid_at, payer_email, created_at, updated_at')
          .in('order_id', orderIds)
          .order('created_at', { ascending: false })
          .limit(200);
        if (payErr) { const _err = safeError(payErr); return json(_err.body, _err.status); }
        // Map order_id → order info for easy lookup
        const orderMap: Record<string, any> = {};
        for (const o of (orders ?? [])) orderMap[o.id] = o;
        const enrichedPayments = (payments ?? []).map((p: any) => ({
          ...p,
          order_number: orderMap[p.order_id]?.order_number ?? null,
          client_name: orderMap[p.order_id]?.client_name ?? null,
          product_name: orderMap[p.order_id]?.product_name ?? null,
          total_premium: orderMap[p.order_id]?.total_premium ?? null,
        }));
        return json({ data: { payments: enrichedPayments } });
      }

    // ── Dokumen pengajuan untuk insurer (token-authed) ──────────────────────
    // Audit 28 Okt 2026: insurer sebelumnya hanya melihat vehicle_image_url
    // (yang juga tak pernah terisi). Kini STNK, foto survey, dan laporan audit
    // foto survey tersedia sebagai dokumen pelengkap untuk keputusan
    // underwriting — signed URL diterbitkan server (service_role) sehingga
    // tidak perlu policy storage untuk insurer.
    case 'insurer_list_order_documents': {
        const token = String(params.token ?? '');
        const orderNumber = String(params.order_number ?? '').trim();
        if (!token || !orderNumber) return json({ error: 'token, order_number required' }, 400);
        const { data: authToken, error: authErr } = await db.from('sp_insurer_auth_tokens')
          .select('id, insurer_id, expires_at')
          .eq('token', token)
          .maybeSingle();
        if (authErr) { const _err = safeError(authErr); return json(_err.body, _err.status); }
        if (!authToken) return json({ error: 'Invalid token' }, 404);
        if (new Date(authToken.expires_at) < new Date()) return json({ error: 'Token expired' }, 410);
        // Order wajib milik insurer ini
        const { data: order, error: ordErr } = await db.from('sp_policy_orders')
          .select('id, order_number, insurer_id, vehicle_details')
          .eq('order_number', orderNumber)
          .eq('insurer_id', authToken.insurer_id)
          .maybeSingle();
        if (ordErr) { const _err = safeError(ordErr); return json(_err.body, _err.status); }
        if (!order) return json({ error: 'Order not found or not assigned to your insurer' }, 404);

        const { data: docs, error: docErr } = await db.from('sp_documents')
          .select('id, doc_type, bucket, path, mime_type, size_bytes, meta, created_at')
          .eq('entity_type', 'policy_order')
          .eq('entity_id', String(order.order_number ?? orderNumber))
          .order('created_at', { ascending: true });
        if (docErr) { const _err = safeError(docErr); return json(_err.body, _err.status); }

        // Tandatangani setiap objek privat server-side (TTL 300 detik).
        const withUrls = await Promise.all((docs ?? []).map(async (d: any) => {
          let signedUrl: string | null = null;
          if (d.bucket && d.path) {
            const { data: sd } = await db.storage.from(d.bucket).createSignedUrl(d.path, 300);
            signedUrl = sd?.signedUrl ?? null;
          }
          return { ...d, signed_url: signedUrl };
        }));

        return json({ data: { order_number: order.order_number, documents: withUrls } });
      }

    case 'insurer_upload_policy': {
        const token = String(params.token ?? '');
        const orderId = String(params.order_id ?? '');
        const policyDocumentUrl = String(params.policy_document_url ?? '');
        const policyNumber = String(params.policy_number ?? '');
        if (!token || !orderId || !policyDocumentUrl) return json({ error: 'token, order_id, policy_document_url required' }, 400);
        // Validate insurer auth token
        const { data: authToken, error: authErr } = await db.from('sp_insurer_auth_tokens')
          .select('id, insurer_id, expires_at')
          .eq('token', token)
          .maybeSingle();
        if (authErr) { const _err = safeError(authErr); return json(_err.body, _err.status); }
        if (!authToken) return json({ error: 'Invalid token' }, 404);
        if (new Date(authToken.expires_at) < new Date()) return json({ error: 'Token expired' }, 410);
        // Verify order belongs to this insurer
        const { data: order, error: ordErr } = await db.from('sp_policy_orders')
          .select('id, order_number, insurer_id, status, client_name, agent_id, client_id')
          .eq('id', orderId)
          .eq('insurer_id', authToken.insurer_id)
          .maybeSingle();
        if (ordErr) { const _err = safeError(ordErr); return json(_err.body, _err.status); }
        if (!order) return json({ error: 'Order not found or not assigned to your insurer' }, 404);
        // The UI only offers issuance once an order is approved, but the gateway
        // must enforce it: without this, an insurer could issue a policy for an
        // unpaid (SUBMITTED), still-reviewing, or rejected order. ISSUED is
        // allowed so a wrong document can be replaced.
        if (order.status !== 'APPROVED' && order.status !== 'ISSUED') {
          return json({ error: `Order belum disetujui (status: ${order.status}). Polis hanya dapat diterbitkan untuk order APPROVED.` }, 409);
        }
        // The document URL is used directly in customer/agent document viewers.
        // Reject non-https schemes (javascript:, data:) and anything that is not
        // a policy-documents object URL.
        let docUrl: URL;
        try {
          docUrl = new URL(policyDocumentUrl);
        } catch {
          return json({ error: 'policy_document_url must be a valid URL' }, 400);
        }
        if (docUrl.protocol !== 'https:' || !docUrl.pathname.includes('/policy-documents/') || policyDocumentUrl.length > 2048) {
          return json({ error: 'policy_document_url must be an https URL inside the policy-documents bucket' }, 400);
        }
        // Update order
        const ts = new Date().toISOString();
        const { data: updated, error: updErr } = await db.from('sp_policy_orders').update({
          policy_document_url: policyDocumentUrl,
          policy_number: policyNumber || null,
          status: 'ISSUED',
          issued_at: ts,
          updated_at: ts,
        }).eq('id', orderId).select().maybeSingle();
        if (updErr) { const _err = safeError(updErr); return json(_err.body, _err.status); }
        // Notifications
        db.from('sp_admin_notifications').insert({
          type: 'POLICY_ISSUED',
          title: 'Polis Diterbitkan oleh Insurer',
          body: `${order.order_number} — ${order.client_name}: polis ${policyNumber || '(no number)'} telah diterbitkan.`,
          order_id: orderId,
          read: false,
          metadata: { order_id: orderId, policy_number: policyNumber, insurer_id: authToken.insurer_id },
        }).then(() => {}, () => {});
        // The customer is the one who most needs this one: their policy
        // document is now downloadable from /custapp. Previously only the
        // agent was told.
        {
          const recipients = [...new Set([order.agent_id, order.client_id].filter(Boolean))];
          for (const recipient of recipients) {
            db.from('sp_notifications').insert({
              agent_id: recipient,
              type: 'POLICY_ISSUED',
              title: 'Polis Diterbitkan!',
              body: `${order.order_number}: polis ${policyNumber || ''} sudah diterbitkan oleh insurer.`,
              read: false,
              metadata: { order_id: orderId, policy_number: policyNumber },
            }).then(() => {}, () => {});
          }
        }
        // ── Log activity ────────────────────────────────────────────────────
        logActivity(authToken.insurer_id, orderId, 'POLICY_UPLOADED', { policy_number: policyNumber, document_url: policyDocumentUrl });
        return json({ data: { success: true, order: updated } });
      }

    default:
      return null; // Not handled by this module
  }
}
