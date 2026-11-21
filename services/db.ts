// Foundation module for the Supabase data layer.
//
// Exports the singleton `supab` client and the `callGateway` helper used by
// every domain file. Split out of the original supabaseService.ts so domain
// modules can import these without creating cycles between themselves.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── Data Gateway Client ─────────────────────────────────────────────────────
// Calls the data-gateway edge function with the current Supabase Auth session JWT.
// All sensitive table reads/writes should go through here instead of direct DB calls.

// Badan respons gerbang dikembalikan utuh (`{ ...body, status }` di bawah), jadi
// bentuknya terbuka: beberapa aksi membawa kunci tambahan di samping `data` —
// `temp_password` dan `recovery_link` dari actions/mitraAccounts.ts misalnya.
// Mendaftar hanya empat kunci membuat tsc menolak pembacaan kunci yang memang
// dikirim server.
export interface GatewayResponse {
  data?: any;
  error?: string;
  /**
   * Stable machine-readable error code (v2.9.30+). Values:
   * 'VALIDATION_FAILED' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' |
   * 'CONFLICT' | 'RATE_LIMITED' | 'INTERNAL_ERROR' | 'UPSTREAM_ERROR'.
   * Client UIs can switch on this to decide tone (destructive vs
   * recoverable) without parsing the human-readable `error` message.
   */
  code?: string;
  status?: number;
  existed?: boolean;
  [key: string]: unknown;
}

async function postToGateway(
  token: string,
  action: string,
  params?: Record<string, unknown>,
  options?: { idempotencyKey?: string },
): Promise<GatewayResponse> {
  try {
    // FIX v1.49.1: Add 15-second timeout to prevent infinite loading
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    if (options?.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    const res = await fetch(`${SUPABASE_URL}/functions/v1/data-gateway`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, params }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      // Preserve status so callers can distinguish "no profile" (404) from
      // transient failures (5xx / network) — critical for the login flow so
      // an ordinary hiccup can't route an existing user through role selection.
      let errBody = '';
      let parsedError: string | undefined;
      try {
        const body = await res.json();
        parsedError = typeof body?.error === 'string' ? body.error : undefined;
        errBody = JSON.stringify(body).slice(0, 200);
      } catch {
        errBody = (await res.text().catch(() => 'Unknown error')).slice(0, 200);
      }
      return { error: parsedError ?? `Gateway error ${res.status}: ${errBody}`, status: res.status };
    }

    const body = await res.json();
    return { ...body, status: res.status };
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      return { error: 'Request timeout (15s). Server mungkin sedang sibuk. Coba lagi.' };
    }
    return { error: String(e?.message ?? e) };
  }
}

async function currentAccessToken(): Promise<string | undefined> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? undefined;
}

async function refreshedAccessToken(): Promise<string | undefined> {
  try {
    const { data } = await supabase.auth.refreshSession();
    return data.session?.access_token ?? undefined;
  } catch {
    return undefined;
  }
}

export async function callGateway(
  action: string,
  params?: Record<string, unknown>,
  options?: { idempotencyKey?: string },
): Promise<GatewayResponse> {
  let token = await currentAccessToken();
  if (!token) token = await refreshedAccessToken();
  if (!token) return { error: 'Not authenticated' };

  let res = await postToGateway(token, action, params, options);
  // 401 / "invalid token" berarti gateway menolak SEBELUM aksi dijalankan,
  // jadi retry setelah refresh tidak bisa menggandakan efek samping. Ini
  // menutup race saat access token kedaluwarsa di tengah sesi B2B yang
  // sudah lama dibuka (panel batch + dashboard ikut merah karenanya).
  const authRejected = res.status === 401
    || res.error === 'Not authenticated'
    || res.error === 'Unauthorized: invalid token'
    || res.error === 'Unauthorized: missing bearer token';
  if (authRejected) {
    const fresh = await refreshedAccessToken();
    if (fresh && fresh !== token) {
      res = await postToGateway(fresh, action, params, options);
    }
  }
  return res;
}

// Like callGateway, but for the small set of PUBLIC_ACTIONS (data-gateway/index.ts)
// that are reachable without a Supabase Auth session — e.g. the unauthenticated
// insurer review-by-email-token flow. No Authorization header is sent; the
// gateway itself only dispatches actions in its PUBLIC_ACTIONS allowlist when
// no bearer token is present.
export async function callPublicGateway(
  action: string,
  params?: Record<string, unknown>,
): Promise<{ data?: any; error?: string }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/data-gateway`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params }),
    });
    return res.json();
  } catch (e) {
    return { error: String((e as Error)?.message ?? e) };
  }
}
