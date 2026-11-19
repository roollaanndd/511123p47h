#!/usr/bin/env node
// Penjaga: apa pun yang ada di dist/ akan TERPUBLIKASI ke internet.
//
// Kenapa ada: `npm run build` dulu menulis bundle server dev beserta
// sourcemap-nya ke dist/ — folder yang dipublikasikan Vercel. Sourcemap itu
// membawa `sourcesContent`, yaitu KODE SUMBER TYPESCRIPT ASLI dari server.ts
// (termasuk AI gateway berikut lapisan validasi PII-leak) dan
// services/aiAdminEngine.ts. Siapa pun yang menebak /server.cjs.map bisa
// mengunduh sumbernya utuh, lengkap dengan komentar.
//
// Ini tidak bersuara: build sukses, situs normal, tidak ada yang menandai.
// Persis pola yang sama dengan cacat-cacat lain yang ditemukan di v2.5.2-v2.5.4.
//
// Penjaga ini berjalan di akhir `npm run build`, jadi build GAGAL sebelum
// sesuatu yang tidak semestinya sempat ter-deploy.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = 'dist';

// Berkas yang tidak boleh ada di folder publik, beserta alasannya.
const TERLARANG = [
  { uji: f => f.endsWith('.map'),
    alasan: 'sourcemap membawa kode sumber asli (sourcesContent)' },
  { uji: f => /(^|\/)server\.[cm]?js$/.test(f),
    alasan: 'bundle server dev tidak punya urusan di folder publik' },
  { uji: f => /\.(env|pem|key|p12|keystore|jks)$/i.test(f),
    alasan: 'berkas kredensial' },
  { uji: f => /(^|\/)\.env/.test(f),
    alasan: 'berkas environment' },
];

function semuaBerkas(dir, akar = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...semuaBerkas(p, akar));
    else out.push(relative(akar, p).split('\\').join('/'));
  }
  return out;
}

if (!existsSync(DIST)) {
  console.error(`✗ ${DIST}/ tidak ada — jalankan build lebih dulu.`);
  process.exit(1);
}

const berkas = semuaBerkas(DIST);
const temuan = [];

for (const f of berkas) {
  for (const { uji, alasan } of TERLARANG) {
    if (uji(f)) {
      const kb = (statSync(join(DIST, f)).size / 1024).toFixed(1);
      temuan.push({ f, alasan, kb });
      break;
    }
  }
}

// ─── Pemindai isi (v2.9.17) ──────────────────────────────────────────────────
// Nama berkas yang bersih tidak berarti isinya bersih. Tiga kelas kebocoran
// yang pernah / bisa terjadi tanpa suara:
//   1. service-role key atau secret server ikut ter-inline ke bundel,
//   2. kredensial pihak ketiga (Xendit, Telegram, cron) terbawa,
//   3. komentar sumber panjang yang membawa nama tabel / alur internal.
// Semua ini hanya bisa dicek dengan membaca isi berkas.
const POLA_ISI = [
  { pola: /SUPABASE_SERVICE_ROLE_KEY|service_role\s*[:=]\s*['"]ey[A-Za-z0-9]/, alasan: 'service-role key / nama env server di bundel klien' },
  { pola: /XENDIT_SECRET_KEY|xnd_(development|production)_[A-Za-z0-9]/, alasan: 'kredensial Xendit' },
  { pola: /CRON_SECRET/, alasan: 'secret cron server' },
  { pola: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, alasan: 'private key' },
  { pola: /bot[0-9]{8,10}:[A-Za-z0-9_-]{30,}/, alasan: 'token bot Telegram' },
];

const BERKAS_TEKS = /\.(js|mjs|cjs|css|html|json|webmanifest|txt)$/i;
const temuanIsi = [];

for (const f of berkas) {
  if (!BERKAS_TEKS.test(f)) continue;
  let isi;
  try {
    isi = readFileSync(join(DIST, f), 'utf8');
  } catch {
    continue;
  }
  for (const { pola, alasan } of POLA_ISI) {
    if (pola.test(isi)) temuanIsi.push({ f, alasan });
  }
}

if (temuanIsi.length > 0) {
  console.error('\n✗ BUILD DIHENTIKAN — isi bundel membocorkan kredensial:\n');
  for (const t of temuanIsi) {
    console.error(`  ${t.f}`);
    console.error(`      → ${t.alasan}\n`);
  }
  process.exit(1);
}

if (temuan.length > 0) {
  console.error('\n✗ BUILD DIHENTIKAN — berkas berikut akan terpublikasi ke internet:\n');
  for (const t of temuan) {
    console.error(`  ${t.f}  (${t.kb} KB)`);
    console.error(`      → ${t.alasan}\n`);
  }
  console.error('  Pindahkan keluar dari dist/, atau matikan pembuatannya.\n');
  process.exit(1);
}

console.log(`✓ dist/ bersih: ${berkas.length} berkas, tidak ada sourcemap/bundle server/kredensial.`);
