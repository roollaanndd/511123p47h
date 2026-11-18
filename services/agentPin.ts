// agentPin.ts — kunci agen SurePath: PIN 6 digit + kunci idle 30 menit.
//
// Dua lapis, jangan dicampur:
//   1. Server (data-gateway) adalah satu-satunya yang menyimpan/memverifikasi
//      PIN. Klien hanya mengirim PIN mentah lewat HTTPS ke gateway — tidak
//      pernah menulisnya ke localStorage/DB/audit.
//   2. localStorage di sini HANYA menyimpan status UI per akun: kapan terakhir
//      ada aktivitas, apakah layar sudah dikunci, dan apakah PIN sudah dibuat.
//      Mencuri storage tidak memberi PIN, dan status itu tidak dipercaya server
//      untuk keputusan keamanan apa pun.
//
// Rilis v2.9.16.

import { callGateway } from './db';

export const PIN_IDLE_MS = 30 * 60 * 1000;
export const PIN_LOCKOUT_MS = 15 * 60 * 1000;
export const PIN_LENGTH = 6;

const ACTIVITY_KEY = 'sp_pin_last_activity';
const UNLOCKED_KEY = 'sp_pin_unlocked';
const CONFIGURED_KEY = 'sp_pin_configured';
const DOWNLOADED_KEY = 'sp_pin_app_downloaded_reported';

const keyFor = (prefix: string, userId: string): string => `${prefix}:${userId}`;

const read = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const write = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch { /* storage privat bisa mati */ }
};

// ── activity / idle ─────────────────────────────────────────────────────────

export const recordAgentActivity = (userId: string): void => {
  write(keyFor(ACTIVITY_KEY, userId), String(Date.now()));
};

export const lastAgentActivityAt = (userId: string): number => {
  const raw = read(keyFor(ACTIVITY_KEY, userId));
  const value = Number(raw);
  return raw && Number.isFinite(value) && value > 0 ? value : 0;
};

/** true kalau belum pernah ada aktivitas ATAU sudah lebih dari 30 menit. */
export const isAgentPinIdle = (userId: string): boolean => {
  const last = lastAgentActivityAt(userId);
  return !last || Date.now() - last >= PIN_IDLE_MS;
};

export const markAgentPinUnlocked = (userId: string): void => {
  write(keyFor(UNLOCKED_KEY, userId), '1');
  recordAgentActivity(userId);
};

export const markAgentPinLocked = (userId: string): void => {
  write(keyFor(UNLOCKED_KEY, userId), '0');
  // Cap waktu tetap diperbarui: setelah refresh, status '0' yang menentukan,
  // bukan durasi idle — pengguna tidak perlu menunggu 30 menit lagi.
  recordAgentActivity(userId);
};

export const isAgentPinUnlocked = (userId: string): boolean =>
  read(keyFor(UNLOCKED_KEY, userId)) === '1' && !isAgentPinIdle(userId);

export const cachePinConfigured = (userId: string, configured: boolean): void => {
  write(keyFor(CONFIGURED_KEY, userId), configured ? '1' : '0');
};

/** null = status belum pernah dimuat dari server. */
export const cachedPinConfigured = (userId: string): boolean | null => {
  const raw = read(keyFor(CONFIGURED_KEY, userId));
  return raw === '1' ? true : raw === '0' ? false : null;
};

export const clearAgentPinSession = (userId: string): void => {
  try {
    [ACTIVITY_KEY, UNLOCKED_KEY, CONFIGURED_KEY, DOWNLOADED_KEY].forEach(prefix =>
      localStorage.removeItem(keyFor(prefix, userId)),
    );
  } catch { /* tidak ada yang dibersihkan pun tidak apa-apa */ }
};

// ── gateway ─────────────────────────────────────────────────────────────────

export class AgentPinError extends Error {
  status?: number;
  remaining?: number;
  lockedUntil: string | null;

  constructor(message: string, status?: number, remaining?: number, lockedUntil: string | null = null) {
    super(message);
    this.name = 'AgentPinError';
    this.status = status;
    this.remaining = remaining;
    this.lockedUntil = lockedUntil;
  }
}

const post = async <T = Record<string, unknown>>(
  action: string,
  params: Record<string, unknown> = {},
): Promise<T> => {
  const res = await callGateway(action, params);
  if (res.error) {
    throw new AgentPinError(
      res.error,
      typeof res.status === 'number' ? res.status : undefined,
      typeof res.remaining === 'number' ? res.remaining : undefined,
      typeof res.locked_until === 'string' ? res.locked_until : null,
    );
  }
  return res.data as T;
};

export interface AgentPinStatus {
  configured: boolean;
  lockedUntil: string | null;
  appDownloadedAt: string | null;
}

/**
 * Satu-satunya tempat yang memutuskan apakah agen perlu setup atau unlock.
 * FAIL CLOSED: kalau status tidak bisa dimuat, jangan pernah menganggap PIN
 * sudah dikonfigurasi — kalau tidak, agen bisa masuk ke portal tanpa gate.
 */
export const getAgentPinStatus = async (userId: string): Promise<AgentPinStatus> => {
  const res = await callGateway('get_my_profile');
  if (res.error || !res.data) {
    throw new AgentPinError(res.error ?? 'Gagal memuat status PIN', res.status);
  }
  const data = res.data as Record<string, unknown>;
  const configured = Boolean(data.pin_configured);
  cachePinConfigured(userId, configured);
  return {
    configured,
    lockedUntil: typeof data.pin_locked_until === 'string' ? data.pin_locked_until : null,
    appDownloadedAt: typeof data.app_downloaded_at === 'string' ? data.app_downloaded_at : null,
  };
};

export const setAgentPin = (pin: string) =>
  post<{ pin_configured: boolean }>('set_pin', { pin });

export const verifyAgentPin = (pin: string) =>
  post<{ verified: boolean; pin_configured: boolean }>('verify_pin', { pin });

export const requestPinReset = () =>
  post<{ sent: boolean; email: string; expires_at: string }>('request_pin_reset', {});

export const resetAgentPin = (code: string, pin: string) =>
  post<{ pin_configured: boolean; verified: boolean }>('reset_pin', { code, pin });

/** Dipanggil sekali per akun saat aplikasi berjalan sebagai PWA terpasang. */
export const reportAppDownloadedOnce = async (userId: string): Promise<void> => {
  if (read(keyFor(DOWNLOADED_KEY, userId)) === '1') return;
  await post('mark_app_downloaded', {});
  write(keyFor(DOWNLOADED_KEY, userId), '1');
};

/** Validasi ringan di klien — server tetap memeriksa ulang. */
export const isSixDigits = (value: string): boolean => /^\d{6}$/.test(value);
