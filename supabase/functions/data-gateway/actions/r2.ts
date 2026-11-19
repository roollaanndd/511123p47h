// r2.ts — unggah/unduh dokumen lewat Cloudflare R2 (bucket privat, S3-compatible).
//
// Kenapa di gateway, bukan edge function baru: otorisasi, rate limit, dan jejak
// aktivitas sudah ada di sini. Setiap fungsi baru berarti satu permukaan baru
// yang harus diaudit ulang — dan audit 2026-11-19 menunjukkan justru fungsi
// lama yang lupa dijaga.
//
// Alur (byte TIDAK melewati edge function):
//   1) r2_upload_url    → server membuat kunci + izin PUT 15 menit
//   2) klien PUT ke R2  → langsung ke bucket
//   3) r2_confirm_upload→ baris sp_documents (bucket 'r2') dicatat
//   4) r2_download_url  → izin GET 5 menit + jejak unduhan
//
// Keputusan keamanan:
//   - Kunci TIDAK pernah datang dari klien. Ia dibentuk dari entity + doc_type
//     + uuid, sehingga tidak ada `../`, tidak ada penimpaan objek, dan tidak ada
//     objek yang bisa ditebak.
//   - Bucket wajib privat. Akses hanya lewat URL bertanda tangan.
//   - Unduhan memakai `response-content-disposition: attachment` yang IKUT
//     ditandatangani, sehingga berkas HTML/SVG yang diselundupkan tidak pernah
//     dirender inline di domain penyimpanan.
//   - Batas ukuran ditegakkan saat permintaan izin (10 MB) dan dicatat di
//     registry; presigned PUT sendiri tidak bisa mengikat ukuran. Objek yang
//     diunggah tanpa konfirmasi tidak terlihat di database — lifecycle rule
//     per-bucket tidak bisa membedakannya, jadi perlu rekonsiliasi berkala
//     (listing R2 vs sp_documents.bucket = 'r2').

import type { GatewayContext, ActionResult } from './types.ts';
import { presignR2Url, r2ConfigFromEnv } from '../../_shared/r2.ts';

const json = (body: unknown, status = 200): ActionResult => ({ status, body });

const UPLOAD_TTL_SECONDS = 900;   // 15 menit
const DOWNLOAD_TTL_SECONDS = 300; // 5 menit
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// entity_id dipakai sebagai segmen kunci objek: wajib ketat.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type EntityType = 'policy_order' | 'claim' | 'agent';

interface PurposeRule {
  entityType: EntityType;
  docTypes: readonly string[];
  mimeTypes: readonly string[];
}

const IMAGE_AND_PDF = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

const PURPOSES: Record<string, PurposeRule> = {
  'order-document': {
    entityType: 'policy_order',
    docTypes: ['STNK', 'VEHICLE_PHOTO', 'SURVEY_PHOTO', 'SURVEY_AUDIT_REPORT', 'POLICY_PDF', 'OTHER'],
    mimeTypes: IMAGE_AND_PDF,
  },
  'claim-document': {
    entityType: 'claim',
    docTypes: ['CLAIM_PHOTO', 'KTP', 'OTHER'],
    mimeTypes: IMAGE_AND_PDF,
  },
  'agent-document': {
    entityType: 'agent',
    docTypes: ['KTP', 'AGREEMENT_PDF', 'OTHER'],
    mimeTypes: ['image/jpeg', 'image/png', 'application/pdf'],
  },
};

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

const ENTITY_TYPES: readonly string[] = ['policy_order', 'claim', 'agent'];

interface ParsedKey {
  entityType: string;
  entityId: string;
  docType: string;
  file: string;
}

/** Pisah kunci objek; null bila bentuknya bukan yang kita terbitkan sendiri. */
function parseKey(raw: string): ParsedKey | null {
  if (!raw || raw.length > 512 || raw.includes('..') || raw.includes('\\')) return null;
  const parts = raw.split('/');
  if (parts.length !== 4) return null;
  const [entityType, entityId, docType, file] = parts;
  if (!ENTITY_TYPES.includes(entityType)) return null;
  if (!ID_RE.test(entityId) || !ID_RE.test(docType) || !ID_RE.test(file)) return null;
  return { entityType, entityId, docType, file };
}

/** Pemilik entitas, atau admin. Aturannya sama dengan `documents_signed_url`. */
async function canAccess(
  db: any,
  caller: GatewayContext['caller'],
  entityType: string,
  entityId: string,
): Promise<boolean> {
  if (caller.isAdmin) return true;
  if (entityType === 'agent') return caller.ownerIds.includes(entityId);

  if (entityType === 'policy_order') {
    const { data } = await db.from('sp_policy_orders')
      .select('agent_id, client_id')
      .eq('order_number', entityId)
      .maybeSingle();
    if (!data) return false;
    return caller.ownerIds.includes(String(data.agent_id ?? ''))
      || (data.client_id != null && caller.ownerIds.includes(String(data.client_id)));
  }

  if (entityType === 'claim') {
    const { data } = await db.from('sp_claims')
      .select('user_id, agent_id')
      .eq('id', entityId)
      .maybeSingle();
    if (!data) return false;
    return caller.ownerIds.includes(String(data.user_id ?? ''))
      || (data.agent_id != null && caller.ownerIds.includes(String(data.agent_id)));
  }

  return false;
}

export async function handleR2Action(action: string, ctx: GatewayContext): Promise<ActionResult | null> {
  const { db, params, caller, checkRateLimit, logActivity } = ctx;

  switch (action) {

    // ── 1. Izin unggah: server yang membuat kunci ───────────────────────────
    case 'r2_upload_url': {
      if (!caller.spUser) return json({ error: 'No profile' }, 403);

      const cfg = r2ConfigFromEnv();
      if (!cfg) return json({ error: 'Penyimpanan objek belum dikonfigurasi' }, 503);

      const purpose = String(params.purpose ?? '');
      const rule = PURPOSES[purpose];
      if (!rule) return json({ error: 'purpose tidak dikenali' }, 400);

      const entityId = String(params.entity_id ?? '').trim();
      if (!ID_RE.test(entityId)) return json({ error: 'entity_id tidak valid' }, 400);

      const docType = String(params.doc_type ?? '').toUpperCase();
      if (!rule.docTypes.includes(docType)) {
        return json({ error: `doc_type tidak diizinkan: ${docType}` }, 400);
      }

      const mime = String(params.mime_type ?? '').toLowerCase();
      if (!rule.mimeTypes.includes(mime)) {
        return json({ error: `mime_type tidak diizinkan: ${mime}` }, 400);
      }

      const size = Number(params.size_bytes ?? 0);
      if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
        return json({ error: `size_bytes harus antara 1 dan ${MAX_UPLOAD_BYTES}` }, 400);
      }

      if (!(await checkRateLimit(`r2-upload:${caller.ownerId}`, 40))) {
        return json({ error: 'Terlalu banyak unggahan. Coba lagi nanti.' }, 429);
      }
      if (!(await canAccess(db, caller, rule.entityType, entityId))) {
        return json({ error: 'Forbidden' }, 403);
      }

      const key = `${rule.entityType}/${entityId}/${docType}/${crypto.randomUUID()}.${EXT_BY_MIME[mime]}`;
      const uploadUrl = await presignR2Url(cfg, {
        method: 'PUT',
        key,
        expiresIn: UPLOAD_TTL_SECONDS,
      });

      return json({
        data: {
          key,
          upload_url: uploadUrl,
          method: 'PUT',
          expires_in: UPLOAD_TTL_SECONDS,
          // Petunjuk, bukan pengikat: tanda tangan hanya mengikat host+path.
          headers: { 'Content-Type': mime },
        },
      });
    }

    // ── 2. Konfirmasi: kunci terdaftar hanya setelah dipakai ────────────────
    case 'r2_confirm_upload': {
      if (!caller.spUser) return json({ error: 'No profile' }, 403);

      const key = String(params.key ?? '');
      const parsed = parseKey(key);
      if (!parsed) return json({ error: 'key tidak valid' }, 400);

      const purpose = String(params.purpose ?? '');
      const rule = PURPOSES[purpose];
      if (!rule || rule.entityType !== parsed.entityType) {
        return json({ error: 'purpose tidak cocok dengan key' }, 400);
      }
      if (!rule.docTypes.includes(parsed.docType)) {
        return json({ error: 'doc_type tidak cocok dengan key' }, 400);
      }
      if (!(await canAccess(db, caller, parsed.entityType, parsed.entityId))) {
        return json({ error: 'Forbidden' }, 403);
      }

      const mime = String(params.mime_type ?? '').toLowerCase();
      const sizeRaw = Number(params.size_bytes ?? 0);
      const size = Number.isFinite(sizeRaw) && sizeRaw > 0 && sizeRaw <= MAX_UPLOAD_BYTES
        ? Math.round(sizeRaw)
        : null;

      const { error } = await db.from('sp_documents').upsert({
        entity_type: parsed.entityType,
        entity_id: parsed.entityId,
        doc_type: parsed.docType,
        bucket: 'r2',
        path: key,
        url: null,
        mime_type: rule.mimeTypes.includes(mime) ? mime : null,
        size_bytes: size,
        uploaded_by: caller.authId,
        uploaded_by_role: caller.role,
        meta: { provider: 'r2', purpose },
      }, { onConflict: 'bucket,path' });
      if (error) return json({ error: error.message }, 400);

      // Jejak tanpa isi berkas: hanya kunci, jenis, dan aktor.
      logActivity(null, null, 'document.upload', {
        key,
        doc_type: parsed.docType,
        purpose,
        provider: 'r2',
      });

      return json({ data: { registered: true, key } });
    }

    // ── 3. Unduh: URL pendek + jejak per unduhan ────────────────────────────
    case 'r2_download_url': {
      if (!caller.spUser) return json({ error: 'No profile' }, 403);

      const cfg = r2ConfigFromEnv();
      if (!cfg) return json({ error: 'Penyimpanan objek belum dikonfigurasi' }, 503);

      const key = String(params.key ?? '');
      const parsed = parseKey(key);
      if (!parsed) return json({ error: 'key tidak valid' }, 400);

      if (!(await canAccess(db, caller, parsed.entityType, parsed.entityId))) {
        return json({ error: 'Forbidden' }, 403);
      }
      if (!(await checkRateLimit(`r2-download:${caller.ownerId}`, 120))) {
        return json({ error: 'Terlalu banyak unduhan. Coba lagi nanti.' }, 429);
      }

      const filename = parsed.file.replace(/[^A-Za-z0-9._-]/g, '_');
      const signedUrl = await presignR2Url(cfg, {
        method: 'GET',
        key,
        expiresIn: DOWNLOAD_TTL_SECONDS,
        responseContentDisposition: `attachment; filename="${filename}"`,
      });

      // Audit per unduhan — kekosongan yang dicatat pada audit 2026-11-19.
      logActivity(null, null, 'document.download', {
        key,
        doc_type: parsed.docType,
        entity_type: parsed.entityType,
        entity_id: parsed.entityId,
      });

      return json({ data: { signed_url: signedUrl, expires_in: DOWNLOAD_TTL_SECONDS } });
    }

    default:
      return null; // Not handled by this module
  }
}
