// _shared/r2.ts — presigned URL untuk Cloudflare R2 (S3-compatible, SigV4).
//
// Kenapa presign, bukan upload lewat edge function: file polis/klaim bisa
// puluhan MB. Kalau bytes-nya melewati edge function, biaya dan latensi naik,
// dan batas body Deno menjadi masalah. Dengan presign, browser mengunggah
// LANGSUNG ke R2; edge function hanya menandatangani izin selama N detik.
//
// Konsekuensi keamanan yang harus diingat:
//   - tanda tangan mengikat METHOD + KEY + EXPIRES. Satu URL tidak bisa
//     dipakai untuk method atau path lain;
//   - masa berlaku wajib pendek (default 15 menit untuk unggah, 5 menit untuk
//     unduh);
//   - kredensial R2 hanya hidup di environment edge function, tidak pernah
//     dikirim ke klien.
//
// Modul ini murni: tidak menyentuh jaringan, sehingga bisa diuji dengan
// waktu dan kunci tetap.

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Override untuk testing atau domain kustom. */
  endpoint?: string;
}

export const R2_MAX_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

/**
 * Deno dibaca lewat `globalThis`, bukan sebagai global bebas: dengan begitu
 * modul ini juga bisa di-type-check oleh `tsc` (Node) saat diimpor tes, tanpa
 * menambahkan tipe Deno ke seluruh proyek web.
 */
interface DenoLike {
  env: { get(key: string): string | undefined };
}

function envFromRuntime(key: string): string | undefined {
  return (globalThis as { Deno?: DenoLike }).Deno?.env.get(key);
}

export function r2ConfigFromEnv(
  env: (key: string) => string | undefined = envFromRuntime,
): R2Config | null {
  const accountId = env('R2_ACCOUNT_ID') ?? '';
  const accessKeyId = env('R2_ACCESS_KEY_ID') ?? '';
  const secretAccessKey = env('R2_SECRET_ACCESS_KEY') ?? '';
  const bucket = env('R2_BUCKET') ?? '';
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket, endpoint: env('R2_ENDPOINT') || undefined };
}

function bytesToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(new TextEncoder().encode(input)));
  return bytesToHex(digest);
}

/**
 * Salin ke ArrayBuffer milik sendiri. Deno mengetik Uint8Array<ArrayBufferLike>
 * dan itu tidak memenuhi BufferSource (butuh ArrayBuffer, bukan SharedArrayBuffer).
 */
function toArrayBuffer(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, toArrayBuffer(new TextEncoder().encode(data)));
}

/** RFC 3986: encodeURIComponent + karakter yang tidak di-encode AWS. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Path objek jadi canonical URI; setiap segmen di-encode, garis miring dipertahankan. */
export function canonicalUriForKey(key: string): string {
  const clean = String(key ?? '').replace(/^\/+/, '');
  if (!clean || clean.includes('..')) throw new Error('key tidak valid');
  return '/' + clean.split('/').map(rfc3986).join('/');
}

export interface PresignOptions {
  method: 'GET' | 'PUT';
  key: string;
  /** Detik; default 900 (15 menit). Maksimum 7 hari. */
  expiresIn?: number;
  /** Waktu tetap untuk pengujian. Default: sekarang. */
  now?: Date;
  /**
   * `response-content-disposition` (GET saja). Ikut ditandatangani, sehingga
   * pemanggil tidak bisa mengubahnya menjadi `inline`.
   */
  responseContentDisposition?: string;
}

/**
 * Hasilkan URL bertanda tangan. Fungsi ini deterministik untuk input yang sama
 * (termasuk `now`), sehingga bisa diuji tanpa jaringan.
 */
export async function presignR2Url(cfg: R2Config, opts: PresignOptions): Promise<string> {
  const method = opts.method;
  const expires = Math.min(
    Math.max(1, Math.floor(opts.expiresIn ?? 900)),
    R2_MAX_EXPIRES_SECONDS,
  );

  const host = cfg.endpoint
    ? cfg.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    : `${cfg.bucket}.${cfg.accountId}.r2.cloudflarestorage.com`;

  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const region = 'auto';
  const service = 's3';
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  const uri = canonicalUriForKey(opts.key);
  const queryParams: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${cfg.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  // Override respons wajib ikut ditandatangani; ia bagian dari canonical query.
  if (opts.responseContentDisposition) {
    queryParams.push(['response-content-disposition', opts.responseContentDisposition]);
  }
  const query = queryParams
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .sort()
    .join('&');

  const canonicalRequest = [
    method,
    uri,
    query,
    `host:${host}`,
    '',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmac(new TextEncoder().encode(`AWS4${cfg.secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = bytesToHex(await hmac(kSigning, stringToSign));

  return `https://${host}${uri}?${query}&X-Amz-Signature=${signature}`;
}

/** URL publik (tanpa tanda tangan) untuk bucket yang memang boleh dibaca umum. */
export function publicR2Url(cfg: R2Config, key: string): string {
  const base = (cfg.endpoint?.replace(/\/+$/, '')) ?? `https://${cfg.bucket}.${cfg.accountId}.r2.cloudflarestorage.com`;
  return `${base}${canonicalUriForKey(key)}`;
}
