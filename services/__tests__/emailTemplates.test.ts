// @vitest-environment node
/**
 * emailTemplates.test.ts — template email Auth sebagai kode, bukan rahasia dashboard.
 *
 * Sebelum ini, isi email konfirmasi/reset/OTP hanya hidup di dashboard Supabase:
 * tidak bisa di-review, tidak punya riwayat, dan tidak ada yang menangkap kalau
 * `{{ .ConfirmationURL }}` hilang — akibatnya semua pendaftar baru tidak bisa
 * mengaktifkan akun, tanpa error di mana pun.
 *
 * Tes ini mengunci: variabel wajib per template, larangan gradient/gambar
 * eksternal/script, dan bentuk workflow penerapnya.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const DIR = join(ROOT, 'supabase/templates/email');
const read = (file: string) => readFileSync(join(DIR, file), 'utf8');

const TEMPLATES: Array<[string, string[]]> = [
  ['confirmation.html', ['{{ .ConfirmationURL }}']],
  ['recovery.html', ['{{ .ConfirmationURL }}']],
  ['magic-link.html', ['{{ .Token }}', '{{ .ConfirmationURL }}']],
  ['email-change.html', ['{{ .ConfirmationURL }}']],
  ['invite.html', ['{{ .ConfirmationURL }}']],
  ['reauthentication.html', ['{{ .Token }}']],
];

describe('template email Auth', () => {
  it.each(TEMPLATES)('%s membawa variabel yang wajib ada', (file, vars) => {
    const html = read(file);
    for (const v of vars) {
      expect(html, `${file} kehilangan ${v}`).toContain(v);
    }
  });

  it.each(TEMPLATES)('%s bersih dari gradient, script, dan gambar eksternal', (file) => {
    const html = read(file);
    expect(html).not.toMatch(/linear-gradient|radial-gradient|background-image/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<img\b/i);
  });

  it.each(TEMPLATES)('%s memakai warna merek dan ukuran wajar', (file) => {
    const html = read(file);
    expect(html).toContain('#059669');
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(20_000);
  });

  it('validator menerima keenam template', () => {
    const out = execFileSync('node', ['scripts/check-email-templates.mjs', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.templates.map((t: { key: string }) => t.key)).toEqual([
      'confirmation', 'recovery', 'magic-link', 'email-change', 'invite', 'reauthentication',
    ]);
  });

  it('validator menolak template yang kehilangan variabel', () => {
    // Dijalankan di salinan sementara supaya template asli tidak pernah diubah.
    const tmp = mkdtempSync(join(ROOT, '.tmp-templates-'));
    try {
      cpSync(join(ROOT, 'scripts'), join(tmp, 'scripts'), { recursive: true });
      cpSync(join(ROOT, 'supabase/templates'), join(tmp, 'supabase/templates'), { recursive: true });
      const broken = join(tmp, 'supabase/templates/email/confirmation.html');
      writeFileSync(broken, read('confirmation.html').replace('{{ .ConfirmationURL }}', '#'), 'utf8');
      let failed = false;
      try {
        execFileSync('node', ['scripts/check-email-templates.mjs'], { cwd: tmp, encoding: 'utf8', stdio: 'pipe' });
      } catch {
        failed = true;
      }
      expect(failed, 'validator seharusnya gagal').toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('workflow penerapan template', () => {
  const wf = readFileSync(join(ROOT, '.github/workflows/apply-email-templates.yml'), 'utf8');

  it('hanya manual, dengan dry run sebagai default', () => {
    expect(wf).toContain('workflow_dispatch:');
    expect(wf).not.toMatch(/^ {2}push:/m);
    expect(wf).toContain("default: 'true'");
  });

  it('menuntut konfirmasi eksplisit untuk menyentuh produksi', () => {
    expect(wf).toContain('confirm_production');
    expect(wf).toContain('APPLY');
  });

  it('menerapkan per template lewat field API yang benar', () => {
    // Field API berasal dari validator (sumber tunggal), bukan dari teks workflow.
    expect(wf).toContain('contentField');
    expect(wf).toContain('subjectField');
    expect(wf).toContain('--oauth2-bearer');

    const out = execFileSync('node', ['scripts/check-email-templates.mjs', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const conf = JSON.parse(out).templates.find((t: { key: string }) => t.key === 'confirmation');
    expect(conf.contentField).toBe('mailer_templates_confirmation_content');
    expect(conf.subjectField).toBe('mailer_subjects_confirmation');
  });

  it('tidak menyentuh SMTP atau Site URL', () => {
    expect(wf).not.toContain('smtp_host');
    expect(wf).not.toContain('site_url');
  });
});
