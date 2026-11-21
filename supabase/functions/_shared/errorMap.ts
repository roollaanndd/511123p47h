// _shared/errorMap.ts — map any raw error into a safe public response.
//
// Audit backlog: 111+ places in data-gateway returned raw `error.message`
// from Supabase / PostgREST / thrown Errors to the browser. Postgres messages
// leak table names ("relation \"sp_policy_orders\" does not exist"),
// constraint names ("duplicate key value violates unique constraint
// \"uq_sp_users_email\""), column names, and SQL fragments — all useful to
// an attacker mapping the schema, worthless to a legitimate user.
//
// This module centralises the mapping so every action returns:
//   { error: "<short safe message>", code: "<stable machine code>" }
//
// Server-side logs (data-gateway/index.ts:recordActivity) keep the raw
// `err.message` with the request_id — support can still trace the real
// cause from a user's error chip.
//
// Usage from an action:
//   if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
//
// or where only the body is needed (status chosen by caller):
//   return json(safeErrorPayload(error), 400);
//
// The script that bulk-migrated the 111 call sites is in
//   scripts/apply-error-codes.mjs
// — keep it so future refactors can re-apply the pattern.

export type ErrorCode =
  | 'VALIDATION_FAILED'   // 400 — client sent bad input
  | 'UNAUTHORIZED'        // 401 — not signed in or session expired
  | 'FORBIDDEN'           // 403 — signed in but not allowed
  | 'NOT_FOUND'           // 404
  | 'CONFLICT'            // 409 — already exists / unique violation
  | 'RATE_LIMITED'        // 429
  | 'INTERNAL_ERROR'      // 500 — our bug, never leak detail
  | 'UPSTREAM_ERROR';     // 502 — third-party down (Xendit, Resend, Storage)

export interface PublicError {
  error: string;
  code: ErrorCode;
}

// Patterns to scrub from any message that would otherwise reach the browser.
// Non-exhaustive — meant to catch the most common Postgres/PostgREST leaks,
// not every possible schema reference. Default is to drop the message when
// scrubbing leaves something suspicious.
function scrub(msg: string): string {
  if (!msg || typeof msg !== 'string') return 'Terjadi kesalahan.';

  // Very long messages are almost always full SQL + hints + details — drop
  // them entirely rather than try to clean. Pattern for most Supabase errors
  // is < 200 chars; anything longer is already a smell.
  if (msg.length > 220) return 'Terjadi kesalahan pada server.';

  let out = msg;

  // sp_* table names → "data"
  out = out.replace(/\bsp_[a-z0-9_]+/gi, 'data');

  // Supabase/PostgREST-specific phrasing that reveals internals
  out = out.replace(/relation\s+["']?[^"']+["']?\s+does not exist/gi, 'data tidak ditemukan');
  out = out.replace(/column\s+["']?[^"']+["']?\s+does not exist/gi, 'field tidak valid');
  out = out.replace(/duplicate key value violates unique constraint ["']?[^"']+["']?/gi, 'data sudah ada');
  out = out.replace(/null value in column\s+["']?[^"']+["']?/gi, 'field wajib kosong');
  out = out.replace(/insert or update on table\s+["']?[^"']+["']?/gi, 'perubahan data');
  out = out.replace(/violates foreign key constraint ["']?[^"']+["']?/gi, 'referensi tidak valid');
  out = out.replace(/violates check constraint ["']?[^"']+["']?/gi, 'nilai tidak memenuhi syarat');

  // Collapse whitespace and trim
  out = out.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // If scrubbing left empty or something generic Supabase noise, fall back
  if (!out || out === 'data' || out.length < 3) return 'Terjadi kesalahan.';

  // Cap length as safety belt
  return out.length > 200 ? out.slice(0, 200) + '…' : out;
}

function mapPg(pgCode: string | undefined, defaultStatus: number): { code: ErrorCode; status: number } {
  if (!pgCode) return { code: statusToCode(defaultStatus), status: defaultStatus };

  // Postgres integrity classes (23xxx)
  if (pgCode === '23505') return { code: 'CONFLICT', status: 409 };          // unique violation
  if (pgCode === '23503') return { code: 'VALIDATION_FAILED', status: 400 }; // FK violation
  if (pgCode === '23502') return { code: 'VALIDATION_FAILED', status: 400 }; // not-null violation
  if (pgCode === '23514') return { code: 'VALIDATION_FAILED', status: 400 }; // check violation
  if (pgCode === '23P01') return { code: 'VALIDATION_FAILED', status: 400 }; // exclusion violation

  // PostgREST
  if (pgCode === 'PGRST116') return { code: 'NOT_FOUND', status: 404 };       // row not found
  if (pgCode === 'PGRST301') return { code: 'INTERNAL_ERROR', status: 500 };  // stale connection

  // Postgres syntax/permission (42xxx) — our bug, never show detail
  if (pgCode.startsWith('42')) return { code: 'INTERNAL_ERROR', status: 500 };

  // Postgres connection/resource (53xxx) — upstream
  if (pgCode.startsWith('53')) return { code: 'UPSTREAM_ERROR', status: 502 };

  // Default: respect the caller's chosen status
  return { code: statusToCode(defaultStatus), status: defaultStatus };
}

function statusToCode(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'VALIDATION_FAILED';
}

/**
 * Turn any thrown value / Supabase error into a safe `{ body, status }` pair.
 * Pass `defaultStatus` only when the HTTP status should NOT be derived from
 * the Postgres error code (rare — most callers omit it).
 */
export function safeError(err: unknown, defaultStatus = 400): { body: PublicError; status: number } {
  const raw = err as { message?: string; code?: string } | null | undefined;
  const pgCode = typeof raw?.code === 'string' ? raw.code : undefined;
  const msg = typeof raw?.message === 'string' ? raw.message : String(err ?? '');

  const { code, status } = mapPg(pgCode, defaultStatus);
  return {
    body: { error: scrub(msg), code },
    status,
  };
}

/**
 * Convenience: returns just the body. Useful when the caller already has a
 * fixed status it wants to send (e.g. `return json(safeErrorPayload(err), 400)`).
 */
export function safeErrorPayload(err: unknown): PublicError {
  return safeError(err).body;
}
