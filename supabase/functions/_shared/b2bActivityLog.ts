// b2bActivityLog.ts — dedicated B2B activity trail (v2.9.12).
//
// sp_activity_log (v2.5.14) is the generic per-user audit trail; its `detail`
// is deliberately built from a safe whitelist and never stores domain payload.
// B2B operations need a first-class, richer trail that answers "what did
// client X do, when, on which batch, for how much" — and keeps doing so for
// actions we add later. This helper writes sp_b2b_activity_log (deny-all RLS,
// service-role only — the gateway db client IS service-role).
//
// Rules mirrored from the dispatcher's recordActivity():
//  - fire-and-forget: an audit write must never fail the action it audits;
//  - NEVER log PII or secrets (no KTP/phone/address/password/base64) —
//    detail carries identifiers, counts, money, file metadata only;
//  - B2B tables are gateway-only, so anything written here was already
//    authenticated by the dispatcher — no client-supplied identity goes in.

export interface B2BActivityEntry {
  /** Profil B2B pemilik konteks (sp_users.id) — null untuk aksi admin tanpa klien. */
  clientId?: string | null;
  batchId?: string | null;
  /** Disimpan redup agar log tetap terbaca setelah batch dihapus. */
  batchNumber?: string | null;
  actorRole?: string | null;
  actorEmail?: string | null;
  action: string;
  /** Kalimat manusiawi siap tampil di CMS. */
  summary: string;
  /** Data terstruktur non-PII: jumlah item, nominal, nama file, status, dll. */
  detail?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Setiap aksi yang lewat helper ini harus masuk daftar ALLOWED_ACTIONS. */
export const B2B_ACTIVITY_ACTIONS = [
  'bulk_batch_created',
  'bulk_batch_viewed',
  'bulk_invoice_created',
  'bulk_paid',
  'bulk_invoice_expired',
  'bulk_insurer_assigned',
  'bulk_master_policy_issued',
  'bulk_insurer_uploaded_master_policy',
  'bulk_source_file_downloaded',
  // v2.9.17 — kelola pengguna korporat oleh admin. `b2b_user_deleted`
  // ditulis synchronous (bukan fire-and-forget) sebelum barisnya dihapus.
  'b2b_user_profile_updated',
  'b2b_user_deactivated',
  'b2b_user_reactivated',
  'b2b_user_deleted',
] as const;

export type B2BActivityAction = (typeof B2B_ACTIVITY_ACTIONS)[number];

export function logB2BActivity(db: any, entry: B2BActivityEntry): void {
  try {
    db.from('sp_b2b_activity_log')
      .insert({
        client_id: entry.clientId ?? null,
        actor_role: entry.actorRole ?? null,
        actor_email: entry.actorEmail ?? null,
        batch_id: entry.batchId ?? null,
        batch_number: entry.batchNumber ?? null,
        action: entry.action,
        summary: entry.summary,
        detail: entry.detail ?? null,
        ip: entry.ip ?? null,
        user_agent: entry.userAgent ?? null,
      })
      .then(() => {}, () => {});
  } catch {
    // never let auditing break the call it is auditing
  }
}
