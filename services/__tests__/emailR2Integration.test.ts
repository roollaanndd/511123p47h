// @vitest-environment node
/**
 * emailR2Integration.test.ts — kunci dua jalur integrasi (audit 2026-11-19).
 *
 * 1. Email: sebelum ini ada empat tempat berbeda yang memanggil
 *    `https://api.resend.com/emails`. Empat tempat berarti empat peluang lupa
 *    timeout, lupa escape HTML, atau mencetak isi email (beserta PII) ke log.
 *    Tes ini memastikan setiap pemanggil memakai `_shared/email.ts`, dan modul
 *    itu sendiri tidak pernah mencatat penerima/subjek/isi.
 *
 * 2. R2: kunci objek TIDAK boleh berasal dari klien, unduhan harus dipaksa
 *    sebagai lampiran (bukan dirender inline), dan tanda tangan presigned harus
 *    sama dengan implementasi referensi (botocore). Nilai known-answer di bawah
 *    dihasilkan oleh botocore 1.44.6 untuk kredensial dan waktu yang sama —
 *    jadi perubahan pada canonical request akan langsung gagal.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalUriForKey,
  presignR2Url,
  R2_MAX_EXPIRES_SECONDS,
} from '../../supabase/functions/_shared/r2';

const FUNCTIONS = join(process.cwd(), 'supabase/functions');

function read(rel: string): string {
  return readFileSync(join(FUNCTIONS, rel), 'utf8');
}

const EMAIL_CALLERS = [
  'send-insurer-email/index.ts',
  'daily-report/index.ts',
  'insurer-reminder-cron/index.ts',
  'data-gateway/actions/agentPin.ts',
  'data-gateway/actions/orders.ts',
];

describe('Resend — satu pintu', () => {
  it.each(EMAIL_CALLERS)('%s tidak memanggil api.resend.com langsung', (rel) => {
    expect(read(rel)).not.toContain('api.resend.com');
  });

  it.each(EMAIL_CALLERS)('%s memakai _shared/email.ts', (rel) => {
    expect(read(rel)).toContain('_shared/email.ts');
  });

  it('modul email tidak mencatat penerima, subjek, atau isi', () => {
    const src = read('_shared/email.ts');
    expect(src).not.toMatch(/console\.[a-z]+\([^)]*msg\.(to|subject|html)/);
    expect(src).not.toMatch(/console\.[a-z]+\([^)]*\bto\b\s*[,+]/);
    // Idempotency-Key dan timeout adalah kontrak modul, bukan opsional.
    expect(src).toContain("headers['Idempotency-Key']");
    expect(src).toContain('AbortController');
    expect(src).toContain('escapeHtml');
  });

  it('tidak ada jalur email lain yang lolos di dalam fungsi', () => {
    const files = ['send-insurer-email/index.ts', 'daily-report/index.ts', 'insurer-reminder-cron/index.ts'];
    for (const rel of files) {
      const src = read(rel);
      const direct = src.match(/fetch\(\s*['"`]https:\/\/api\.resend\.com/g) ?? [];
      expect(direct.length, `${rel} masih fetch langsung`).toBe(0);
    }
  });
});

describe('R2 — jalur simpan berkas', () => {
  const src = read('data-gateway/actions/r2.ts');

  it('setiap aksi butuh profil terautentikasi', () => {
    const guards = src.match(/if \(!caller\.spUser\) return json\(\{ error: 'No profile' \}, 403\);/g) ?? [];
    expect(guards.length).toBe(3);
  });

  it('kunci objek dibentuk server, bukan dari klien', () => {
    expect(src).toContain('crypto.randomUUID()');
    expect(src).toContain('`${rule.entityType}/${entityId}/${docType}/');
    // `params.key` hanya dibaca untuk unduh/konfirmasi, tidak pernah dipakai
    // sebagai kunci tulis.
    const uploadCase = src.slice(src.indexOf("case 'r2_upload_url'"), src.indexOf("case 'r2_confirm_upload'"));
    expect(uploadCase).not.toContain('params.key');
  });

  it('menolak traversal dan kunci berbentuk lain', () => {
    expect(src).toContain("raw.includes('..')");
    expect(src).toContain("raw.includes('\\\\')");
    expect(src).toContain('if (parts.length !== 4) return null;');
  });

  it('unduhan dipaksa attachment dan dicatat per unduhan', () => {
    expect(src).toContain('attachment; filename=');
    expect(src).toContain("'document.download'");
    expect(src).toContain("'document.upload'");
  });

  it('membatasi laju per pengguna', () => {
    expect(src).toContain('r2-upload:${caller.ownerId}');
    expect(src).toContain('r2-download:${caller.ownerId}');
  });

  it('konfigurasi tidak lengkap menjadi 503, bukan 500 bocor', () => {
    expect(src.match(/Penyimpanan objek belum dikonfigurasi/g)?.length).toBe(2);
    expect(src).toContain('}, 503)');
  });

  it('membatasi ukuran unggahan dan tipe MIME', () => {
    expect(src).toContain('MAX_UPLOAD_BYTES');
    expect(src).toContain('mimeTypes');
    expect(src).toContain('size <= 0 || size > MAX_UPLOAD_BYTES');
  });

  it('terdaftar di dispatcher gateway', () => {
    const index = read('data-gateway/index.ts');
    expect(index).toContain("import { handleR2Action } from './actions/r2.ts';");
    expect(index).toContain('await handleR2Action(action, ctx) ??');
  });
});

describe('presign R2 — known answer dari botocore', () => {
  const cfg = {
    accountId: 'abc123',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'SECRETKEYEXAMPLE',
    bucket: 'surepath-docs',
  };
  const key = 'policy_order/O-1/STNK/00000000-0000-4000-8000-000000000000.jpg';
  const now = new Date('2026-11-19T04:02:47Z');

  it('PUT 15 menit menghasilkan tanda tangan yang sama dengan botocore', async () => {
    const url = await presignR2Url(cfg, { method: 'PUT', key, expiresIn: 900, now });
    expect(url).toContain('X-Amz-Expires=900');
    expect(url).toContain('X-Amz-Signature=1ea80f3ad01d3742962651cd38a87a96cbdc2fff18c57558ff948aa588881fa9');
  });

  it('GET dengan content-disposition ikut ditandatangani', async () => {
    const url = await presignR2Url(cfg, {
      method: 'GET',
      key,
      expiresIn: 300,
      now,
      responseContentDisposition: 'attachment; filename="x.jpg"',
    });
    expect(url).toContain('response-content-disposition=attachment%3B%20filename%3D%22x.jpg%22');
    expect(url).toContain('X-Amz-Signature=5e3ee31bb356684380539579a64eb147e0076051918b4435904f88e70ec6c2e6');
  });

  it('masa berlaku dibatasi maksimum 7 hari', async () => {
    const url = await presignR2Url(cfg, { method: 'GET', key, expiresIn: 10 * 365 * 24 * 3600, now });
    expect(url).toContain(`X-Amz-Expires=${R2_MAX_EXPIRES_SECONDS}`);
  });

  it('menolak kunci dengan traversal', () => {
    expect(() => canonicalUriForKey('../etc/passwd')).toThrow();
    expect(() => canonicalUriForKey('/a/../../b')).toThrow();
    expect(canonicalUriForKey('a/b c.pdf')).toBe('/a/b%20c.pdf');
  });
});
