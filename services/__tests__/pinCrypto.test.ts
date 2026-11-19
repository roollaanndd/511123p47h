// Kripto PIN v2.9.16 — satu implementasi dipakai gateway (Deno) dan test
// (Node). Pastikan PIN mentah tidak bisa dipulihkan dari hash/salt dan OTP
// reset selalu 6 digit angka.
import { describe, it, expect } from 'vitest';
import {
  hashPin, isValidPin, makePinRecord, newOtp, newPinSalt,
  timingSafeEqual, verifyPin,
} from '../../supabase/functions/_shared/pin';

describe('isValidPin — tepat 6 digit angka', () => {
  it('menerima PIN dengan leading zero', () => {
    expect(isValidPin('000000')).toBe(true);
    expect(isValidPin('123456')).toBe(true);
  });

  it('menolak panjang, huruf, whitespace, dan tipe lain', () => {
    expect(isValidPin('12345')).toBe(false);
    expect(isValidPin('1234567')).toBe(false);
    expect(isValidPin('12a456')).toBe(false);
    expect(isValidPin(' 12345')).toBe(false);
    expect(isValidPin(123456)).toBe(false);
    expect(isValidPin(null)).toBe(false);
  });
});

describe('makePinRecord / verifyPin — PBKDF2 210k + salt 16 byte', () => {
  it('menghasilkan hash 32 byte (44 base64) dan salt 16 byte (24 base64)', async () => {
    const rec = await makePinRecord('123456');
    expect(rec.hash).toHaveLength(44);
    expect(rec.salt).toHaveLength(24);
    expect(rec.hash).not.toContain('123456');
  });

  it('salt acak: PIN sama dua kali menghasilkan hash berbeda', async () => {
    const a = await makePinRecord('123456');
    const b = await makePinRecord('123456');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('verifikasi benar/salah, dan deterministik untuk salt sama', async () => {
    const rec = await makePinRecord('135790');
    expect(await verifyPin('135790', rec.hash, rec.salt)).toBe(true);
    expect(await verifyPin('135791', rec.hash, rec.salt)).toBe(false);
    expect(await hashPin('135790', rec.salt)).toBe(rec.hash);
  });

  it('salt rusak atau hash salah tidak melempar, cukup gagal', async () => {
    const rec = await makePinRecord('111111');
    expect(await verifyPin('111111', rec.hash, 'bukan-base64')).toBe(false);
    expect(await verifyPin('111111', 'x'.repeat(44), rec.salt)).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('membandingkan isi, bukan identitas referensi', () => {
    const a = 'abcdef';
    const b = 'abcdef';
    expect(timingSafeEqual(a, b)).toBe(true);
    expect(timingSafeEqual('abcdef', 'abcdeg')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('newPinSalt / newOtp', () => {
  it('salt selalu 16 byte', () => {
    const salt = newPinSalt();
    expect(salt).toHaveLength(24);
    expect(() => Buffer.from(salt, 'base64')).not.toThrow();
    expect(Buffer.from(salt, 'base64')).toHaveLength(16);
  });

  it('OTP selalu 6 digit dan di dalam rentang 0–999999', () => {
    for (let i = 0; i < 120; i++) {
      const otp = newOtp();
      expect(otp).toMatch(/^\d{6}$/);
      expect(Number(otp)).toBeGreaterThanOrEqual(0);
      expect(Number(otp)).toBeLessThanOrEqual(999999);
    }
  });
});
