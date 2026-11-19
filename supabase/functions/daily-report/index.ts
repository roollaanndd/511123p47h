
import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendEmail, emailConfigFor } from '../_shared/email.ts';
import { renderEmail, dataTableBlock, buttonBlock } from '../_shared/emailLayout.ts';

// Admin daily digest — new users, orders, claims, payments for the day.
// Delivered via Telegram AND email (Resend), so admins get it even if only one
// channel is configured. Called by Supabase cron (see cron.job daily-report),
// never from a browser.
//
// Auth: requires Authorization: Bearer <CRON_SECRET>. A custom request header
// such as x-supabase-cron is not proof of origin because any caller can spoof it.
// Configure CRON_SECRET in Supabase and in the scheduled invocation.

const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';

function fmtIDR(n: number) {
  if (n >= 1_000_000_000) return `Rp ${(n / 1_000_000_000).toFixed(1)}M`;
  if (n >= 1_000_000)     return `Rp ${(n / 1_000_000).toFixed(1)} jt`;
  if (n >= 1_000)         return `Rp ${(n / 1_000).toFixed(0)} rb`;
  return `Rp ${n}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');

  // Fail closed when the secret is missing or the caller cannot prove possession.
  const authHeader = req.headers.get('authorization') ?? '';
  const providedSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const secretOk = CRON_SECRET !== '' && providedSecret === CRON_SECRET;
  if (!secretOk) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
    const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const BOT_TOKEN    = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
    const CHAT_ID      = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID') ?? '';
    const RESEND_KEY   = Deno.env.get('RESEND_API_KEY') ?? Deno.env.get('RESEND_KEY') ?? '';
    const ADMIN_EMAIL  = Deno.env.get('ADMIN_DIGEST_EMAIL') ?? '';

    const db  = createClient(SUPABASE_URL, SUPABASE_KEY);
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();

    const [usersRes, paymentsRes, ordersRes, agentsRes, customersRes, claimsRes, adminEmailsRes] = await Promise.all([
      db.from('sp_users').select('id, name, role, created_at').gte('created_at', todayISO),
      db.from('sp_payments').select('amount, paid_amount, paid_at').eq('status', 'PAID').gte('paid_at', todayISO),
      db.from('sp_policy_orders').select('status, total_premium, product_name, created_at').gte('created_at', todayISO),
      db.from('sp_users').select('id', { count: 'exact', head: true }).eq('role', 'AGENT').eq('verified', true),
      db.from('sp_users').select('id', { count: 'exact', head: true }).eq('role', 'CUSTOMER'),
      db.from('sp_claims').select('id, status').gte('created_at', todayISO),
      // Admin recipients for the email channel
      db.from('sp_users').select('email').in('role', ['MASTER_ADMIN', 'ADMIN']),
    ]);

    const newUsers    = usersRes.data ?? [];
    const payments    = paymentsRes.data ?? [];
    const orders      = ordersRes.data ?? [];
    const claimsToday = claimsRes.data ?? [];

    const newAgents    = newUsers.filter(u => u.role === 'AGENT');
    const newCustomers = newUsers.filter(u => u.role === 'CUSTOMER');
    const newB2B       = newUsers.filter(u => u.role === 'B2B_CLIENT');

    const gwpToday = payments.reduce((s, p) => s + (p.paid_amount ?? p.amount ?? 0), 0);
    const ordersSubmitted = orders.filter(o => o.status === 'SUBMITTED').length;
    const ordersIssued    = orders.filter(o => o.status === 'ISSUED').length;

    const totalAgents    = agentsRes.count ?? 0;
    const totalCustomers = customersRes.count ?? 0;

    const dateStr = now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
    const timeStr = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });

    let msg = `📊 <b>Laporan Harian SurePath</b>\n`;
    msg += `📅 ${dateStr} · ${timeStr} WIB\n\n`;
    msg += `💰 <b>Transaksi Hari Ini</b>\n`;
    msg += `  GWP Terbayar: <b>${fmtIDR(gwpToday)}</b>\n`;
    msg += `  Pembayaran sukses: <b>${payments.length}</b>\n`;
    msg += `  Order masuk: <b>${ordersSubmitted}</b>\n`;
    msg += `  Polis terbit: <b>${ordersIssued}</b>\n\n`;
    msg += `👥 <b>Pendaftaran Baru</b>\n`;
    msg += `  🏢 Agen baru: <b>${newAgents.length}</b>\n`;
    msg += `  👤 Nasabah baru: <b>${newCustomers.length}</b>\n`;
    msg += `  🏭 Klien korporat: <b>${newB2B.length}</b>\n`;
    if (newAgents.length > 0) {
      msg += `  ↳ ${newAgents.slice(0, 3).map(a => a.name).join(', ')}${newAgents.length > 3 ? ` +${newAgents.length - 3}` : ''}\n`;
    }
    msg += `\n📈 <b>Klaim Hari Ini:</b> ${claimsToday.length}\n\n`;
    msg += `🏦 <b>Platform</b>\n`;
    msg += `  Agen aktif: <b>${totalAgents.toLocaleString('id-ID')}</b>\n`;
    msg += `  Total nasabah: <b>${totalCustomers.toLocaleString('id-ID')}</b>\n\n`;
    msg += `<a href="https://myinsurepath.com/admin">Buka Dashboard →</a>`;

    const channels: Record<string, unknown> = {};

    // ── Telegram ──────────────────────────────────────────────────────────────
    if (BOT_TOKEN && CHAT_ID) {
      try {
        const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'HTML', disable_web_page_preview: true }),
        });
        channels.telegram = { ok: tgRes.ok, status: tgRes.status };
      } catch (e) {
        channels.telegram = { ok: false, error: String(e) };
      }
    } else {
      channels.telegram = { ok: false, skipped: 'TELEGRAM_BOT_TOKEN/CHAT_ID not set' };
    }

    // ── Email (Resend) — to configured ADMIN_DIGEST_EMAIL + all admin accounts ──
    const recipients = [
      ...(ADMIN_EMAIL ? [ADMIN_EMAIL] : []),
      ...((adminEmailsRes.data ?? []).map((r: { email: string }) => r.email).filter(Boolean)),
    ];
    const uniqueRecipients = [...new Set(recipients)];
    const mailCfg = emailConfigFor(RESEND_KEY);
    if (mailCfg && uniqueRecipients.length > 0) {
      const html = renderEmail({
        title: `Laporan harian SurePath — ${dateStr}`,
        preheader: `${dateStr} ${timeStr} WIB · ${payments.length} pembayaran, ${ordersSubmitted} order masuk.`,
        eyebrow: 'Ringkasan harian',
        heading: 'Laporan harian SurePath',
        intro: `${dateStr} · ${timeStr} WIB`,
        blocks: [
          dataTableBlock([
            { label: 'GWP terbayar', value: fmtIDR(gwpToday), emphasis: true },
            { label: 'Pembayaran sukses', value: String(payments.length) },
            { label: 'Order masuk', value: String(ordersSubmitted) },
            { label: 'Polis terbit', value: String(ordersIssued) },
            { label: 'Agen baru', value: String(newAgents.length) },
            { label: 'Nasabah baru', value: String(newCustomers.length) },
            { label: 'Klien korporat', value: String(newB2B.length) },
            { label: 'Klaim hari ini', value: String(claimsToday.length) },
            { label: 'Agen aktif (total)', value: totalAgents.toLocaleString('id-ID') },
            { label: 'Total nasabah', value: totalCustomers.toLocaleString('id-ID') },
          ]),
          buttonBlock('https://myinsurepath.com/admin', 'Buka dashboard'),
        ],
      });
      try {
        const mail = await sendEmail(mailCfg, {
          to: uniqueRecipients,
          subject: `📊 Laporan Harian SurePath — ${dateStr}`,
          html,
          idempotencyKey: `daily-report:${dateStr}`,
          tags: [{ name: 'flow', value: 'daily-report' }],
        });
        channels.email = { ok: true, status: mail.status, recipients: uniqueRecipients.length };
      } catch (e) {
        channels.email = { ok: false, error: String(e) };
      }
    } else {
      channels.email = { ok: false, skipped: RESEND_KEY ? 'no admin recipients' : 'RESEND_API_KEY not set' };
    }

    return new Response(JSON.stringify({ ok: true, channels }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('daily-report error:', err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
});
