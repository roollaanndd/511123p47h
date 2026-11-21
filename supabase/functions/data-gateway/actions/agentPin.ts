// agentPin.ts — PIN 6 digit agen + kunci idle + reset OTP email.
//
// Semua nilai PIN diterima lewat params, diverifikasi di sini dengan PBKDF2
// yang sama seperti authService.ts, lalu dibuang. Yang tersimpan di DB hanya
// hash + salt; jejak aktivitas memakai status, bukan PIN. Reset OTP memakai
// tabel sp_pin_resets (hash OTP, TTL 10 menit, 5 attempt) dan Resend.

import type { GatewayContext, ActionResult } from './types.ts';
import { sendEmailSafe, emailConfigFor, escapeHtml } from '../../_shared/email.ts';
import { renderEmail, tokenBlock, paragraphBlock } from '../../_shared/emailLayout.ts';
import {
  isValidPin, makePinRecord, newOtp, verifyPin, hashPin, newPinSalt,
} from '../../_shared/pin.ts';
import { safeError } from '../../_shared/errorMap.ts';

const json = (body: unknown, status = 200): ActionResult => ({ status, body });

const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RE = /^\d{6}$/;
const PIN_ACTIONS = new Set([
  'set_pin', 'verify_pin', 'request_pin_reset', 'reset_pin', 'mark_app_downloaded',
]);

function agentOnly(ctx: GatewayContext): ActionResult | null {
  if (!ctx.caller.spUser) return json({ error: 'No SurePath profile' }, 403);
  if (ctx.caller.role !== 'AGENT') return json({ error: 'Forbidden: agent only' }, 403);
  return null;
}

export async function handleAgentPinAction(
  action: string,
  ctx: GatewayContext,
): Promise<ActionResult | null> {
  // Jangan menyentuh aksi di luar domain ini — dispatcher memanggil semua
  // module sampai ada yang menjawab, dan guard peran di sini hanya berlaku
  // untuk aksi PIN.
  if (!PIN_ACTIONS.has(action)) return null;
  // Audit dilakukan dispatcher index.ts (sp_activity_log): nama aksi + status
  // + http_status, tanpa nilai PIN. Tidak perlu logActivity() — itu untuk
  // sp_insurer_activity_log dan akan mencemari jejak keputusan insurer.
  const { db, params, caller, RESEND_KEY, checkRateLimit, reqIp } = ctx;
  const guard = agentOnly(ctx);
  if (guard) return guard;

  const ownerId = caller.ownerId;
  const nowIso = () => new Date().toISOString();

  switch (action) {
    case 'set_pin': {
      if (!isValidPin(params.pin)) return json({ error: 'PIN harus tepat 6 digit angka' }, 400);
      if (!(await checkRateLimit(`pin-set:${ownerId}`, 10))) {
        return json({ error: 'Terlalu banyak percobaan pembuatan PIN. Coba lagi nanti.' }, 429);
      }
      if (caller.spUser?.pin_hash) {
        return json({ error: 'PIN sudah dibuat. Gunakan reset lewat email.' }, 409);
      }
      const record = await makePinRecord(params.pin);
      const { error } = await db.from('sp_users').update({
        pin_hash: record.hash,
        pin_salt: record.salt,
        pin_set_at: nowIso(),
        pin_failed_attempts: 0,
        pin_locked_until: null,
      }).eq('id', ownerId);
      if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
      return json({ data: { pin_configured: true } });
    }

    case 'verify_pin': {
      if (!isValidPin(params.pin)) return json({ error: 'PIN harus tepat 6 digit angka' }, 400);
      if (!(await checkRateLimit(`pin-verify:${ownerId}`, 20))) {
        return json({ error: 'Terlalu banyak percobaan PIN. Coba lagi nanti.' }, 429);
      }
      const now = Date.now();
      const lockedUntil = caller.spUser?.pin_locked_until
        ? Date.parse(String(caller.spUser.pin_locked_until))
        : 0;
      if (Number.isFinite(lockedUntil) && lockedUntil > now) {
        return json({
          error: 'PIN terkunci setelah beberapa kali salah. Coba lagi nanti atau reset lewat email.',
          locked_until: caller.spUser?.pin_locked_until ?? null,
        }, 423);
      }
      if (!caller.spUser?.pin_hash || !caller.spUser?.pin_salt) {
        return json({ error: 'PIN belum dibuat pada akun ini' }, 409);
      }
      const matched = await verifyPin(
        params.pin,
        String(caller.spUser.pin_hash),
        String(caller.spUser.pin_salt),
      );
      if (!matched) {
        const attempts = Number(caller.spUser?.pin_failed_attempts ?? 0) + 1;
        const locked = attempts >= MAX_PIN_ATTEMPTS;
        const { error } = await db.from('sp_users').update({
          pin_failed_attempts: locked ? MAX_PIN_ATTEMPTS : attempts,
          pin_locked_until: locked ? new Date(now + LOCKOUT_MS).toISOString() : null,
        }).eq('id', ownerId);
        if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
        return json({
          error: locked
            ? 'PIN terkunci 15 menit. Gunakan reset lewat email.'
            : `PIN salah. Sisa ${MAX_PIN_ATTEMPTS - attempts} percobaan.`,
          remaining: Math.max(0, MAX_PIN_ATTEMPTS - attempts),
          locked_until: locked ? new Date(now + LOCKOUT_MS).toISOString() : null,
        }, locked ? 423 : 401);
      }
      const { error } = await db.from('sp_users').update({
        pin_failed_attempts: 0,
        pin_locked_until: null,
      }).eq('id', ownerId);
      if (error) { const _err = safeError(error); return json(_err.body, _err.status); }
      return json({ data: { verified: true, pin_configured: true } });
    }

    case 'request_pin_reset': {
      if (!caller.email) return json({ error: 'Akun tidak punya email' }, 400);
      if (!RESEND_KEY) return json({ error: 'Pengiriman email reset belum tersedia' }, 503);
      if (!(await checkRateLimit(`pin-reset:${ownerId}`, 3))) {
        return json({ error: 'Terlalu banyak permintaan kode reset. Coba lagi nanti.' }, 429);
      }

      const code = newOtp();
      const salt = newPinSalt();
      const codeHash = await hashPin(code, salt);
      const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
      const { data: reset, error: insertError } = await db.from('sp_pin_resets').insert({
        user_id: ownerId,
        code_hash: codeHash,
        salt,
        expires_at: expiresAt,
        attempts: 0,
        created_by_ip: reqIp ?? null,
      }).select('id').single();
      if (insertError) { const _err = safeError(insertError); return json(_err.body, _err.status); }

      const html = renderEmail({
        title: 'Reset PIN SurePath',
        preheader: 'Kode reset PIN berlaku 10 menit.',
        eyebrow: 'Keamanan akun',
        heading: 'Kode reset PIN',
        intro: `Halo ${escapeHtml(String(caller.spUser?.name ?? 'Agen').slice(0, 80))}, gunakan kode berikut untuk membuat PIN agen baru.`,
        blocks: [
          tokenBlock(code),
          paragraphBlock('Kode berlaku 10 menit dan hanya bisa dipakai sekali.'),
        ],
        note: 'Kalau kamu tidak meminta reset, abaikan email ini — PIN lama tetap berlaku.',
      });
      // audit 2026-11-19: satu jalur email (_shared/email.ts).
      // Idempotency-Key memakai id baris reset: retry tidak mengirim dua kode.
      const mail = await sendEmailSafe(emailConfigFor(RESEND_KEY), {
        to: caller.email,
        subject: 'Kode reset PIN SurePath',
        html,
        idempotencyKey: `pin-reset:${reset.id}`,
        tags: [{ name: 'flow', value: 'pin-reset' }],
      });
      if (!mail.ok) {
        // Jangan biarkan kode yang tidak pernah sampai jadi sampel serangan.
        await db.from('sp_pin_resets').update({ used_at: nowIso() }).eq('id', reset.id);
        return json({ error: 'Gagal mengirim email reset. Coba lagi.' }, 502);
      }
      return json({ data: { sent: true, email: caller.email, expires_at: expiresAt } });
    }

    case 'reset_pin': {
      if (!isValidPin(params.pin)) return json({ error: 'PIN baru harus 6 digit angka' }, 400);
      const code = String(params.code ?? '').trim();
      if (!OTP_RE.test(code)) return json({ error: 'Kode OTP harus 6 digit angka' }, 400);
      if (!(await checkRateLimit(`pin-reset-verify:${ownerId}`, 10))) {
        return json({ error: 'Terlalu banyak percobaan kode. Coba lagi nanti.' }, 429);
      }

      const { data: reset } = await db.from('sp_pin_resets')
        .select('id, code_hash, salt, attempts, expires_at, used_at')
        .eq('user_id', ownerId)
        .is('used_at', null)
        .gt('expires_at', nowIso())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!reset) {
        return json({ error: 'Kode reset tidak valid atau sudah kedaluwarsa' }, 400);
      }
      if (Number(reset.attempts ?? 0) >= OTP_MAX_ATTEMPTS) {
        return json({ error: 'Kode reset terkunci. Minta kode baru.' }, 429);
      }
      const matched = await verifyPin(code, String(reset.code_hash), String(reset.salt));
      if (!matched) {
        await db.from('sp_pin_resets').update({
          attempts: Number(reset.attempts ?? 0) + 1,
        }).eq('id', reset.id);
        return json({ error: 'Kode reset salah.' }, 401);
      }

      const record = await makePinRecord(params.pin);
      const { error: pinError } = await db.from('sp_users').update({
        pin_hash: record.hash,
        pin_salt: record.salt,
        pin_set_at: nowIso(),
        pin_failed_attempts: 0,
        pin_locked_until: null,
      }).eq('id', ownerId);
      if (pinError) { const _err = safeError(pinError); return json(_err.body, _err.status); }
      await db.from('sp_pin_resets').update({ used_at: nowIso() }).eq('id', reset.id);
      return json({ data: { pin_configured: true, verified: true } });
    }

    case 'mark_app_downloaded': {
      if (caller.spUser?.app_downloaded_at) {
        return json({ data: { app_downloaded_at: caller.spUser.app_downloaded_at } });
      }
      const at = nowIso();
      await db.from('sp_users')
        .update({ app_downloaded_at: at })
        .eq('id', ownerId)
        .is('app_downloaded_at', null);
      const { data: fresh } = await db.from('sp_users')
        .select('app_downloaded_at')
        .eq('id', ownerId)
        .maybeSingle();
      return json({ data: { app_downloaded_at: fresh?.app_downloaded_at ?? at } });
    }
  }

  return null;
}
