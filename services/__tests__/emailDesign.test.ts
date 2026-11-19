// @vitest-environment node
/**
 * emailDesign.test.ts — satu tata letak untuk semua email transaksional.
 *
 * Sebelum ini setiap email menulis HTML sendiri: header oranye, ungu, hijau,
 * dan satu tanpa header. Gradient juga masih dipakai, padahal arahan desain
 * 19 Nov melarangnya. Tes ini mengunci bahwa kelima jalur memakai layout
 * bersama, dan welcome email tetap idempoten.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buttonBlock, dataTableBlock, renderEmail, tokenBlock } from '../../supabase/functions/_shared/emailLayout';

const ROOT = process.cwd();
const FN = join(ROOT, 'supabase/functions');

const readFn = (rel: string) => readFileSync(join(FN, rel), 'utf8');

const EMAIL_FILES = [
  'data-gateway/actions/agentPin.ts',
  'data-gateway/actions/orders.ts',
  'data-gateway/actions/welcome.ts',
  'daily-report/index.ts',
  'insurer-reminder-cron/index.ts',
];

describe('layout email bersama', () => {
  const layout = readFn('_shared/emailLayout.ts');

  it('memakai merek dan lebar yang sama dengan template Auth', () => {
    expect(layout).toContain('#059669');
    expect(layout).toContain('max-width:560px');
    expect(layout).toContain('PT Ruang Proteksi Indonesia');
  });

  it('hasil render bersih dari gradient, gambar, dan script', () => {
    const html = renderEmail({
      title: 'Uji', preheader: 'Uji', eyebrow: 'Uji', heading: 'Uji', intro: 'Uji',
      blocks: [buttonBlock('https://myinsurepath.com', 'Buka'), tokenBlock('123456'), dataTableBlock([{ label: 'Total', value: 'Rp1', emphasis: true }])],
      note: 'Catatan',
    });
    expect(html).not.toMatch(/gradient/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toContain('max-width:560px');
    expect(html).toContain('PT Ruang Proteksi Indonesia');
  });

  it.each(EMAIL_FILES)('%s memakai layout bersama, bukan HTML sendiri', (rel) => {
    const src = readFn(rel);
    expect(src).toContain('emailLayout.ts');
    expect(src).toContain('renderEmail(');
    // Tidak ada lagi dokumen HTML utuh yang ditulis tangan di modul email.
    expect(src).not.toMatch(/<!DOCTYPE html>/i);
  });
});

describe('welcome email', () => {
  const src = readFn('data-gateway/actions/welcome.ts');
  const index = readFn('data-gateway/index.ts');
  const authGate = readFileSync(join(ROOT, 'components/AuthGate.tsx'), 'utf8');

  it('terdaftar di dispatcher gateway', () => {
    expect(index).toContain("import { handleWelcomeAction } from './actions/welcome.ts';");
    expect(index).toContain('await handleWelcomeAction(action, ctx) ??');
  });

  it('butuh profil dan email, dan menghormati rate limit', () => {
    expect(src).toContain("if (!caller.spUser) return json({ error: 'No profile' }, 403);");
    expect(src).toContain("if (!caller.email) return json({ error: 'Akun tidak punya email' }, 400);");
    expect(src).toContain('checkRateLimit(`welcome:${caller.ownerId}`, 3)');
  });

  it('idempoten lewat jejak aktivitas, bukan tabel baru', () => {
    expect(src).toContain(".from('sp_activity_log')");
    expect(src).toContain(".eq('action', ACTION_KEY)");
    expect(src).toContain(".eq('status', 'OK')");
    expect(src).toContain("skipped: 'already_sent'");
    // Idempotency-Key Resend menutup balapan dua permintaan bersamaan.
    expect(src).toContain('idempotencyKey: `welcome:${caller.ownerId}`');
  });

  it('kegagalan email tercatat ERROR supaya dicoba lagi, bukan OK', () => {
    // 503 saat email belum dikonfigurasi, 502 saat Resend menolak.
    expect(src).toContain('}, 503)');
    expect(src).toContain('}, 502)');
  });

  it('hanya untuk peran yang memakai aplikasi', () => {
    expect(src).toContain("role !== 'CUSTOMER' && role !== 'AGENT'");
    expect(src).toContain("skipped: 'role'");
  });

  it('dipicu klien sekali, tanpa menahan login', () => {
    expect(authGate).toContain("void callGateway('send_welcome_email').catch(() => {});");
    expect(authGate).toContain("import { callGateway } from '../services/db';");
  });
});
