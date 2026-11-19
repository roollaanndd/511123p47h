// pin.ts — hash/verifikasi PIN 6 digit agen SurePath.
//
// Dipakai data-gateway (Deno) dan unit test (Node/Vitest). sengaja memakai
// WebCrypto saja supaya satu implementasi jalan di dua runtime. Parameter
// mengikuti pola services/authService.ts: PBKDF2-HMAC-SHA256, 210.000 iterasi,
// salt acak 16 byte, hasil 32 byte. PIN mentah TIDAK pernah disimpan dan
// TIDAK pernah dipakai sebagai kunci audit.

const ITERATIONS = 210000;
const PIN_RE = /^\d{6}$/;

export const isValidPin = (value: unknown): value is string =>
  typeof value === 'string' && PIN_RE.test(value);

const toBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

const fromBase64 = (value: string): Uint8Array | null => {
  try {
    const raw = atob(value);
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  } catch {
    return null;
  }
};

/** Salt 16 byte, base64 — sama panjangnya dengan salt di authService.ts. */
export const newPinSalt = (): string =>
  toBase64(crypto.getRandomValues(new Uint8Array(16)));

export async function hashPin(pin: string, saltB64: string): Promise<string> {
  const salt = fromBase64(saltB64);
  if (!salt || salt.length !== 16) throw new Error('Salt PIN tidak valid');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return toBase64(new Uint8Array(bits));
}

export async function makePinRecord(pin: string): Promise<{ hash: string; salt: string }> {
  const salt = newPinSalt();
  return { hash: await hashPin(pin, salt), salt };
}

/** Perbandingan konstan terhadap panjang string yang sama. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPin(pin: string, hash: string, salt: string): Promise<boolean> {
  try {
    return timingSafeEqual(await hashPin(pin, salt), hash);
  } catch {
    return false;
  }
}

/** OTP reset 6 digit; angka 0–999999 dengan padding, bukan Math.random(). */
export const newOtp = (): string =>
  String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
