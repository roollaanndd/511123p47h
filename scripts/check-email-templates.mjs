#!/usr/bin/env node
// check-email-templates.mjs — penjaga + sumber tunggal untuk template email Auth.
//
// Kenapa ada: template email Supabase hidup di dashboard. Begitu ia hanya ada
// di sana, tidak ada yang bisa di-review, tidak ada riwayat, dan satu salah
// ketik pada `{{ .ConfirmationURL }}` membuat semua pendaftar baru tidak bisa
// mengaktifkan akun. Berkas ini membuat template punya sumber di repo, dan
// memastikan setiap template membawa variabel yang WAJIB ada sebelum dikirim
// ke API.
//
// Pemakaian:
//   node scripts/check-email-templates.mjs           # ringkasan manusia
//   node scripts/check-email-templates.mjs --json    # dipakai workflow
//
// Aturan yang ditegakkan:
//   - variabel Go template wajib ada (kalau hilang, email tidak berguna);
//   - tidak ada <script> (klien email memblokirnya; kalau lolos, itu tanda
//     template disalin dari halaman web);
//   - tidak ada gradient/background-image (aturan desain repo: bukan AI-slop,
//     dan banyak klien email tidak merendernya);
//   - ukuran di bawah batas API (20 KB) supaya PATCH tidak ditolak.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const TEMPLATES = [
  {
    key: 'confirmation',
    file: 'confirmation.html',
    subject: 'Konfirmasi email SurePath',
    subjectField: 'mailer_subjects_confirmation',
    contentField: 'mailer_templates_confirmation_content',
    requiredVars: ['{{ .ConfirmationURL }}'],
  },
  {
    key: 'recovery',
    file: 'recovery.html',
    subject: 'Buat kata sandi baru SurePath',
    subjectField: 'mailer_subjects_recovery',
    contentField: 'mailer_templates_recovery_content',
    requiredVars: ['{{ .ConfirmationURL }}'],
  },
  {
    key: 'magic-link',
    file: 'magic-link.html',
    subject: 'Kode masuk SurePath',
    subjectField: 'mailer_subjects_magic_link',
    contentField: 'mailer_templates_magic_link_content',
    requiredVars: ['{{ .Token }}', '{{ .ConfirmationURL }}'],
  },
  {
    key: 'email-change',
    file: 'email-change.html',
    subject: 'Konfirmasi email baru SurePath',
    subjectField: 'mailer_subjects_email_change',
    contentField: 'mailer_templates_email_change_content',
    requiredVars: ['{{ .ConfirmationURL }}'],
  },
  {
    key: 'invite',
    file: 'invite.html',
    subject: 'Undangan SurePath',
    subjectField: 'mailer_subjects_invite',
    contentField: 'mailer_templates_invite_content',
    requiredVars: ['{{ .ConfirmationURL }}'],
  },
  {
    key: 'reauthentication',
    file: 'reauthentication.html',
    subject: 'Kode verifikasi SurePath',
    subjectField: 'mailer_subjects_reauthentication',
    contentField: 'mailer_templates_reauthentication_content',
    requiredVars: ['{{ .Token }}'],
  },
];

const DIR = join(process.cwd(), 'supabase/templates/email');
const MAX_BYTES = 20_000;

function validate(tpl) {
  const path = join(DIR, tpl.file);
  if (!existsSync(path)) return [`${tpl.file}: berkas tidak ditemukan`];

  const html = readFileSync(path, 'utf8');
  const problems = [];
  const bytes = Buffer.byteLength(html, 'utf8');

  for (const v of tpl.requiredVars) {
    if (!html.includes(v)) problems.push(`${tpl.file}: variabel wajib hilang → ${v}`);
  }
  if (/<script\b/i.test(html)) problems.push(`${tpl.file}: mengandung <script>`);
  if (/linear-gradient|radial-gradient|background-image/i.test(html)) {
    problems.push(`${tpl.file}: memakai gradient/background-image (dilarang)`);
  }
  if (/<img\b/i.test(html)) problems.push(`${tpl.file}: memuat gambar eksternal (bisa diblokir klien email)`);
  if (!html.includes('#059669')) problems.push(`${tpl.file}: warna merek #059669 tidak ada`);
  if (bytes > MAX_BYTES) problems.push(`${tpl.file}: ${bytes} byte > ${MAX_BYTES}`);

  return problems;
}

const problems = TEMPLATES.flatMap(validate);

if (process.argv.includes('--json')) {
  if (problems.length) {
    console.error(JSON.stringify({ ok: false, problems }, null, 2));
    process.exit(1);
  }
  const payload = TEMPLATES.map((t) => ({
    key: t.key,
    file: t.file,
    subject: t.subject,
    subjectField: t.subjectField,
    contentField: t.contentField,
    content: readFileSync(join(DIR, t.file), 'utf8'),
  }));
  console.log(JSON.stringify({ ok: true, templates: payload }));
  process.exit(0);
}

if (problems.length) {
  console.error('✗ Template email Auth bermasalah:\n');
  for (const p of problems) console.error('  · ' + p);
  console.error('');
  process.exit(1);
}

console.log(`✓ ${TEMPLATES.length} template email Auth valid (${DIR})`);
for (const t of TEMPLATES) {
  const bytes = Buffer.byteLength(readFileSync(join(DIR, t.file), 'utf8'), 'utf8');
  console.log(`  · ${t.key.padEnd(16)} ${String(bytes).padStart(5)} byte → ${t.contentField}`);
}
