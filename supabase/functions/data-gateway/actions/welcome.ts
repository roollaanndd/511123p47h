// welcome.ts — email selamat datang, sekali per akun.
//
// IDEMPOTENSI TANPA MIGRASI
// Dispatcher data-gateway sudah mencatat setiap aksi ke `sp_activity_log`
// (actor_id, action, status). Aksi ini hanya mengirim bila belum ada baris
// berstatus OK untuk (actor_id, 'send_welcome_email'). Kalau pengiriman gagal,
// respons 502 dicatat sebagai ERROR — jadi login berikutnya mencoba lagi.
//
// Konsekuensi yang harus diingat:
//   - dua permintaan yang benar-benar bersamaan bisa sama-sama lolos pemeriksaan;
//     `Idempotency-Key` Resend (`welcome:<ownerId>`) menutup duplikat dalam
//     jendela singkat itu;
//   - kalau `sp_activity_log` dipangkas, email bisa terkirim lagi setelahnya.
//     Itu kerugian kecil, dan lebih baik daripada menambah tabel penanda yang
//     harus dimigrasikan ke produksi hanya untuk satu email.
//
// Email ini tidak boleh menggagalkan login: klien memanggilnya tanpa menunggu
// hasil, dan kegagalan hanya berarti percobaan berikutnya.

import type { GatewayContext, ActionResult } from './types.ts';
import { sendEmail, emailConfigFor, escapeHtml } from '../../_shared/email.ts';
import {
  renderEmail, paragraphBlock, buttonBlock, calloutBlock,
} from '../../_shared/emailLayout.ts';

const json = (body: unknown, status = 200): ActionResult => ({ status, body });

const ACTION_KEY = 'send_welcome_email';
const APP_URL = 'https://myinsurepath.com';
const PORTAL_AGEN_URL = 'https://myinsurepath.com/agent';

export async function handleWelcomeAction(
  action: string,
  ctx: GatewayContext,
): Promise<ActionResult | null> {
  if (action !== ACTION_KEY) return null;

  const { db, caller, checkRateLimit, RESEND_KEY } = ctx;

  if (!caller.spUser) return json({ error: 'No profile' }, 403);
  if (!caller.email) return json({ error: 'Akun tidak punya email' }, 400);

  const cfg = emailConfigFor(RESEND_KEY);
  // 503 (bukan 200 "skipped") supaya percobaan berikutnya tetap terjadi setelah
  // email dikonfigurasi — dan supaya dispatcher mencatatnya sebagai ERROR,
  // bukan OK yang akan memblokir pengiriman selamanya.
  if (!cfg) return json({ error: 'Email belum dikonfigurasi' }, 503);

  if (!(await checkRateLimit(`welcome:${caller.ownerId}`, 3))) {
    return json({ error: 'Terlalu banyak permintaan. Coba lagi nanti.' }, 429);
  }

  const { data: prior } = await db.from('sp_activity_log')
    .select('id')
    .eq('actor_id', caller.spUser.id)
    .eq('action', ACTION_KEY)
    .eq('status', 'OK')
    .limit(1);

  if (Array.isArray(prior) && prior.length > 0) {
    return json({ data: { sent: false, skipped: 'already_sent' } });
  }

  const role = String(caller.role ?? '').toUpperCase();
  // Hanya akun yang benar-benar memakai aplikasi. Operator/admin tidak perlu
  // email selamat datang, dan mengirimnya hanya menambah kebisingan.
  if (role !== 'CUSTOMER' && role !== 'AGENT') {
    return json({ data: { sent: false, skipped: 'role' } });
  }

  const rawName = String(caller.spUser?.name ?? '').trim().split(/\s+/)[0] ?? '';
  const name = escapeHtml(rawName || 'Kak');
  const isAgent = role === 'AGENT';

  const html = renderEmail({
    title: 'Selamat datang di SurePath',
    preheader: 'Akun Anda aktif. Ini langkah pertama yang paling berguna.',
    eyebrow: 'Selamat datang',
    heading: `Selamat datang, ${name}`,
    intro: isAgent
      ? 'Akun mitra Anda sudah aktif. Berikut yang paling berguna untuk dikerjakan lebih dulu.'
      : 'Akun Anda sudah aktif. Berikut tiga hal yang paling sering dipakai nasabah.',
    blocks: [
      calloutBlock(isAgent
        ? '<strong>Lengkapi profil mitra</strong> — data diri dan rekening dipakai untuk pencairan komisi.'
        : '<strong>Simpan polis Anda</strong> — semua polis dan dokumen ada di satu tempat.'),
      paragraphBlock(isAgent
        ? 'Buat order pertama dari portal agen, lalu pantau statusnya sampai polis terbit.'
        : 'Bandingkan produk, hitung premi, dan ajukan polis langsung dari aplikasi.'),
      buttonBlock(isAgent ? PORTAL_AGEN_URL : APP_URL, isAgent ? 'Buka portal agen' : 'Buka SurePath'),
    ],
    note: 'Butuh bantuan? Balasan ke email ini tidak dibaca — gunakan menu Bantuan di aplikasi.',
  });

  try {
    await sendEmail(cfg, {
      to: caller.email,
      subject: 'Selamat datang di SurePath',
      html,
      flow: 'welcome',
      idempotencyKey: `welcome:${caller.ownerId}`,
    });
  } catch (err) {
    console.error('[welcome] gagal', (err as { status?: number })?.status ?? 0);
    return json({ error: 'Email belum terkirim. Coba lagi nanti.' }, 502);
  }

  return json({ data: { sent: true } });
}
