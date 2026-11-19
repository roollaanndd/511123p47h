// Kunci idle v2.9.16 — state UI disimpan per akun di localStorage.
// Yang diuji di sini BUKAN rahasia PIN (itu di pinCrypto.test.ts), melainkan
// perilaku cap waktu 30 menit dan status kunci saat reload/tab baru.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PIN_IDLE_MS, PIN_LOCKOUT_MS, cachedPinConfigured, cachePinConfigured,
  clearAgentPinSession, isAgentPinIdle, isAgentPinUnlocked, isSixDigits,
  lastAgentActivityAt, markAgentPinLocked, markAgentPinUnlocked, recordAgentActivity,
} from '../agentPin';

const USER_A = 'sp-user-a';
const USER_B = 'sp-user-b';

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-19T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('idle 30 menit per pengguna', () => {
  it('konstanta sesuai keputusan produk', () => {
    expect(PIN_IDLE_MS).toBe(30 * 60 * 1000);
    expect(PIN_LOCKOUT_MS).toBe(15 * 60 * 1000);
  });

  it('belum pernah aktif dianggap idle', () => {
    expect(lastAgentActivityAt(USER_A)).toBe(0);
    expect(isAgentPinIdle(USER_A)).toBe(true);
  });

  it('aktivitas menyegarkan cap waktu, kunci tepat pada 30 menit', () => {
    recordAgentActivity(USER_A);
    const started = Date.now();
    expect(lastAgentActivityAt(USER_A)).toBe(started);
    expect(isAgentPinIdle(USER_A)).toBe(false);

    vi.setSystemTime(started + PIN_IDLE_MS - 1);
    expect(isAgentPinIdle(USER_A)).toBe(false);

    vi.setSystemTime(started + PIN_IDLE_MS);
    expect(isAgentPinIdle(USER_A)).toBe(true);
  });

  it('state tidak bocor antar akun pada perangkat yang sama', () => {
    recordAgentActivity(USER_A);
    expect(isAgentPinIdle(USER_A)).toBe(false);
    expect(isAgentPinIdle(USER_B)).toBe(true);
  });
});

describe('status kunci', () => {
  it('unlock aktif hanya saat belum idle', () => {
    markAgentPinUnlocked(USER_A);
    expect(isAgentPinUnlocked(USER_A)).toBe(true);

    vi.setSystemTime(Date.now() + PIN_IDLE_MS);
    expect(isAgentPinUnlocked(USER_A)).toBe(false);
  });

  it('lock eksplisit tetap berlalu setelah refresh (cap waktu di-update)', () => {
    markAgentPinUnlocked(USER_A);
    markAgentPinLocked(USER_A);
    expect(isAgentPinUnlocked(USER_A)).toBe(false);
    expect(isAgentPinIdle(USER_A)).toBe(false); // tidak perlu tunggu 30 menit lagi

    vi.setSystemTime(Date.now() + PIN_IDLE_MS + 1);
    expect(isAgentPinUnlocked(USER_A)).toBe(false);
    // Kunci sudah dipaksa, tetapi idle juga sudah terlampaui → tetap kunci.
    expect(isAgentPinIdle(USER_A)).toBe(true);
  });

  it('logout menghapus seluruh state PIN akun itu', () => {
    markAgentPinUnlocked(USER_A);
    cachePinConfigured(USER_A, true);
    recordAgentActivity(USER_B);

    clearAgentPinSession(USER_A);
    expect(isAgentPinUnlocked(USER_A)).toBe(false);
    expect(cachedPinConfigured(USER_A)).toBeNull();
    expect(lastAgentActivityAt(USER_A)).toBe(0);
    expect(isAgentPinIdle(USER_B)).toBe(false); // akun lain tidak tersentuh
  });
});

describe('cache status konfigurasi (bukan rahasia)', () => {
  it('membedakan belum dimuat, belum ada PIN, dan sudah ada PIN', () => {
    expect(cachedPinConfigured(USER_A)).toBeNull();
    cachePinConfigured(USER_A, false);
    expect(cachedPinConfigured(USER_A)).toBe(false);
    cachePinConfigured(USER_A, true);
    expect(cachedPinConfigured(USER_A)).toBe(true);
  });
});

describe('isSixDigits — validasi ringan klien', () => {
  it('hanya menerima enam digit', () => {
    expect(isSixDigits('000000')).toBe(true);
    expect(isSixDigits('123456')).toBe(true);
    expect(isSixDigits('12345')).toBe(false);
    expect(isSixDigits('12a456')).toBe(false);
  });
});
