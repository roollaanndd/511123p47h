// _shared/email.ts — satu pintu untuk semua email transaksional (Resend).
//
// Kenapa ada: sebelum ini ada empat jalur berbeda yang memanggil
// `https://api.resend.com/emails` — `send-insurer-email`, gerbang PIN
// (`actions/agentPin.ts`), tautan review (`actions/orders.ts`), dan satu
// fungsi SQL yang memanggil Resend lewat pg_net. Empat jalur berarti empat
// tempat yang bisa lupa memasang timeout, lupa meng-escape HTML, atau
// mencetak isi email (beserta PII) ke log.
//
// Kontrak modul ini:
//   - tidak pernah mencetak `to`, `subject`, atau `html` ke log;
//   - selalu memakai timeout (default 10 detik) supaya edge function tidak
//     menggantung sampai batas eksekusi;
//   - kegagalan Resend menjadi `EmailError` dengan status HTTP aslinya,
//     bukan string bebas;
//   - mengirim `Idempotency-Key` bila diminta, supaya retry tidak
//     menghasilkan email ganda.
//
// Modul ini TIDAK menyimpan log ke database. Bila nanti dibutuhkan riwayat
// kirim, tambahkan tabel `sp_email_log` dan catat hanya id pesan + status.

export interface EmailConfig {
  apiKey: string;
  /** Default: `SurePath <noreply@myinsurepath.com>` */
  from: string;
  /** Default: https://api.resend.com */
  baseUrl: string;
  timeoutMs: number;
}

export interface EmailMessage {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  /** Kunci idempotensi; kirim ulang dengan kunci sama tidak menggandakan email. */
  idempotencyKey?: string;
  /** Tag Resend untuk analitik, mis. ['insurer-review']. Jangan taruh PII. */
  tags?: Array<{ name: string; value: string }>;
}

export interface EmailResult {
  id: string;
  status: number;
}

export class EmailError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(message: string, status: number, detail = '') {
    super(message);
    this.name = 'EmailError';
    this.status = status;
    this.detail = detail;
  }
}

const DEFAULT_FROM = 'SurePath <noreply@myinsurepath.com>';
const DEFAULT_BASE = 'https://api.resend.com';
const DEFAULT_TIMEOUT_MS = 10_000;

/** Escape untuk interpolasi ke HTML email. Selalu pakai ini untuk data pengguna. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c),
  );
}

/**
 * Konfigurasi dari kunci yang sudah dipegang pemanggil.
 * Dipakai data-gateway, yang menerima `RESEND_KEY` lewat GatewayContext dan
 * tidak seharusnya membaca env lagi di dalam modul aksi.
 */
export function emailConfigFor(
  apiKey: string,
  env: (key: string) => string | undefined = (k) => Deno.env.get(k),
): EmailConfig | null {
  if (!apiKey) return null;
  return {
    apiKey,
    from: env('RESEND_FROM') || DEFAULT_FROM,
    baseUrl: (env('RESEND_BASE_URL') || DEFAULT_BASE).replace(/\/+$/, ''),
    timeoutMs: Number(env('RESEND_TIMEOUT_MS') || DEFAULT_TIMEOUT_MS),
  };
}

/** Ambil konfigurasi dari environment; null bila API key belum diisi. */
export function emailConfigFromEnv(
  env: (key: string) => string | undefined = (k) => Deno.env.get(k),
): EmailConfig | null {
  return emailConfigFor(env('RESEND_API_KEY') ?? env('RESEND_KEY') ?? '', env);
}

function normalizeRecipients(to: string | string[]): string[] {
  const list = Array.isArray(to) ? to : [to];
  const out = list.map((v) => String(v).trim()).filter(Boolean);
  if (out.length === 0) throw new EmailError('Email tanpa penerima', 400);
  if (out.length > 50) throw new EmailError('Terlalu banyak penerima (maks 50)', 400);
  return out;
}

/**
 * Kirim satu email. Melempar `EmailError` bila gagal.
 * Pemanggil yang tidak ingin kegagalan email menggagalkan alur bisnis harus
 * menangkapnya sendiri (lihat `sendEmailSafe`).
 */
export async function sendEmail(
  cfg: EmailConfig,
  msg: EmailMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailResult> {
  const recipients = normalizeRecipients(msg.to);
  if (!msg.subject || !msg.subject.trim()) throw new EmailError('Email tanpa subjek', 400);
  if (!msg.html || !msg.html.trim()) throw new EmailError('Email tanpa isi', 400);

  const body: Record<string, unknown> = {
    from: msg.from || cfg.from,
    to: recipients,
    subject: msg.subject,
    html: msg.html,
  };
  if (msg.text) body.text = msg.text;
  if (msg.replyTo) body.reply_to = msg.replyTo;
  if (msg.tags?.length) body.tags = msg.tags.slice(0, 20);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (msg.idempotencyKey) headers['Idempotency-Key'] = msg.idempotencyKey.slice(0, 256);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, cfg.timeoutMs));

  try {
    const res = await fetchImpl(`${cfg.baseUrl}/emails`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Detail dibaca untuk log server, TIDAK dikembalikan ke klien apa adanya.
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      throw new EmailError(`Resend menolak permintaan (${res.status})`, res.status, detail);
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { id: String(data?.id ?? ''), status: res.status };
  } catch (err) {
    if (err instanceof EmailError) throw err;
    if ((err as Error)?.name === 'AbortError') {
      throw new EmailError('Resend timeout', 504);
    }
    throw new EmailError('Gagal menghubungi Resend', 502, String((err as Error)?.message ?? err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Versi yang tidak melempar: untuk alur bisnis yang tidak boleh gagal karena
 * email (mis. pemberitahuan setelah pembayaran sukses sudah tercatat).
 */
export async function sendEmailSafe(
  cfg: EmailConfig | null,
  msg: EmailMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!cfg) return { ok: false, error: 'RESEND_API_KEY belum diset' };
  try {
    const res = await sendEmail(cfg, msg, fetchImpl);
    return { ok: true, id: res.id };
  } catch (err) {
    const e = err as EmailError;
    // Hanya status. detail adalah body Resend dan pada error validasi bisa
    // memuat alamat penerima — jangan pernah masuk log.
    console.error('[email] gagal', e?.status ?? 0);
    return { ok: false, error: e?.message ?? 'unknown' };
  }
}
