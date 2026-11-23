# SurePath Session Context
**Updated:** 2026-11-23 (gerbang Perjanjian Mitra: hanya untuk AGENT, tidak diulang bila sudah setuju)

## 23 Nov 2026 — Perjanjian Mitra muncul di admin & diulang setelah ditandatangani

Dua keluhan owner, satu akar: `get_my_agreement` hanya bisa menjawab "ada" /
"tidak ada". Admin (yang memang tidak punya rekaman) dan mitra yang
pengecekannya gagal sama-sama menerima `data: null`, lalu `AgentPortal`
menampilkan gerbang Perjanjian Kemitraan kepada keduanya.

- **Cakupan peran**: `get_my_agreement` (actions/users.ts) kini mengembalikan
  `required`. Untuk peran selain `AGENT` → `{ data: null, required: false }`,
  jadi admin/operator yang membuka app mitra (mode pantau) tidak diminta
  menandatangani kontrak mitra.
- **Tidak diulang**: jawaban membawa `active_version` (dari `sp_tnc_documents`)
  dan error sungguhan bila query gagal. `getMyAgreementStatus()` di
  `services/agreements.ts` memisahkan tiga keadaan: tidak berlaku, sudah/belum
  menandatangani, dan gagal-mengetahui. AgentPortal hanya menahan aplikasi bila
  server **memastikan** belum ada rekaman untuk versi aktif; error jaringan
  tidak lagi disamakan dengan "belum tanda tangan".
- Versi tetap dihitung dari dokumen T&C aktif (`getActiveTncVersion`), jadi
  menerbitkan versi baru memang mewajibkan tanda tangan ulang — sesuai
  permintaan "kecuali ada pembaruan".
- Tes: `services/__tests__/agreementGate.test.ts` (8 tes).

## 23 Nov 2026 — Pathy error AUTH: akar & jejak yang akhirnya tercatat

Keluhan owner: Pathy sering gagal, pesan yang muncul "Sesi kamu sudah berakhir".
Penyebab langsung: respons 401 dari `pathy-agent-proxy`/`pathy-agent`. Yang tidak
terlihat sebelumnya adalah **mengapa** — kegagalan hanya ditulis ke console, dan
kalau JWT ditolak platform Supabase fungsi edge tidak pernah dijalankan sama
sekali, sehingga tidak ada log server yang bisa dibaca.

Yang dikerjakan:
- **Klien** (`services/website.ts`): sesi kosong/tinggal <60 detik dicoba
  `refreshSession()` sekali sebelum menyimpulkan AUTH; setiap kegagalan
  (AUTH 401, RATE_LIMIT 429, UNAVAILABLE 5xx, TIMEOUT/NETWORK, fallback gagal)
  dicatat ke `sp_pathy_errors` lewat **klien anon tanpa sesi** — klien ber-sesi
  akan ditolak PGRST301 justru saat JWT kedaluwarsa, kasus yang ingin dicatat.
- **Server**: `_shared/pathyErrors.ts` (tidak pernah melempar) dipakai
  `pathy-agent` (RATE_LIMIT, NOT_CONFIGURED, UPSTREAM_ERROR + status OpenRouter,
  EMPTY_REPLY, TOOL_LOOP_LIMIT, INTERNAL), `pathy-agent-proxy` (RATE_LIMIT,
  UPSTREAM_ERROR, TIMEOUT/INTERNAL) dan `ai-proxy` (NOT_CONFIGURED,
  UPSTREAM_ERROR, INTERNAL). Sink cadangan `sp_activity_log` (action
  `PATHY_ERROR`) dipakai bila migrasi belum diterapkan, jadi jejak tetap ada
  semenjak deploy.
- **Migrasi** `20261123100000_pathy_error_log.sql` — tabel `sp_pathy_errors`:
  INSERT anon hanya `source='client'`, SELECT hanya `is_admin()`, tanpa isi
  percakapan (hanya kode/status/detail galat ≤ 500 karakter). **Harus
  diterapkan manual** (repo ini tidak punya workflow `supabase db push`).
- Cara membaca: `select created_at, source, code, http_status, detail from
  sp_pathy_errors order by created_at desc limit 50;` — atau filter
  `action = 'PATHY_ERROR'` di Jejak Aktivitas bila migrasi belum jalan.

## 23 Nov 2026 — produk & pilihan asuransi di admin tidak tersimpan

Dua keluhan owner, dua akar berbeda, keduanya soal jalur tulis:

- **Produk & Tier → Produk (Konfigurasi Produk & Komisi).** `sp_product_configs`
  hanya punya policy SELECT untuk anon/authenticated
  (`20260603_tighten_tier3_rls`). UI menulis langsung ke tabel, jadi UPDATE
  mengenai 0 baris TANPA error — kartu menampilkan "Tersimpan" lalu nilai kembali
  ke default — dan INSERT ditolak RLS (pesan lama "Kode mungkin sudah
  digunakan" menyesatkan). Perbaikan: aksi gateway baru
  `admin_save_product_config` (guard `isCoreAdmin`, service_role) dan UI memakai
  `callGateway`, memakai baris balikan server, serta menampilkan error.
- **Asuransi & Rate → Perusahaan Asuransi → Lihat Produk.** `ProductFormData`
  tidak memuat `insurer_id`, sehingga `admin_save_insurer_product` selalu 400
  "insurer_id required" saat Edit; UI mengabaikan error, menutup modal, lalu
  memuat ulang data lama. Tambah/Hapus juga menelan error gateway dan tetap
  memberi toast sukses. Perbaikan: UI mengirim `insurer_id`, gateway menurunkannya
  dari baris yang diedit bila tidak dikirim, `notes` ikut disimpan,
  `max_vehicle_age_years = 0` (tanpa batas) tidak lagi dibuang, dan toast sukses
  hanya muncul saat gateway tidak mengembalikan error. Error DB tetap lewat
  `safeError()` sesuai konvensi v2.9.30.
- Tes: `services/__tests__/adminProductCrud.test.ts` (8 tes, pola sumber seperti
  `gatewayRbac.test.ts`).
- Deploy: edge function ikut auto-deploy saat merge ke `main`; UI menyusul lewat
  Vercel. Health data-gateway dinaikkan ke 1.33.1 sebagai penanda deploy.

## Terakhir dikerjakan (20 Nov 2026) — v2.9.26

**Admin Google sign-in disamakan dengan AuthGate.** Audit lintas portal:
hanya `AuthGate.tsx` (customer + agent) dan `admin/AdminLogin.tsx` yang
punya tombol Google. B2B pakai email/password; operator via admin;
insurer via bearer token. AuthGate adalah yang terbaik dari enam
dimensi — admin diselaraskan ke pola yang sama:
- Logo Google resmi 4-warna (bukan huruf "G" yang melanggar pedoman
  identitas Google)
- `h-12` tetap, `rounded-2xl` kontinu
- `active:scale-[0.98]` umpan balik tekan
- Transisi border hover ke `emerald-500/30`
- Separator diperjelas: "ATAU" → "ATAU LANJUTKAN DENGAN"

Tombol submit utama juga di-bump agar satu bentuk visual dengan
tombol Google. Handler OAuth tidak disentuh.

## PR terakhir yang landed (sebelum v2.9.26)

**PR #407** di-merge ke `main` sebagai `408da1c` (20 Nov 2026).
Rangkuman v2.9.21 → v2.9.25:

### v2.9.21 — Agent inner-screen Kaca Pagi
- `AgentWallet`, `AgentCommission`, `AgentProfile` dimigrasi penuh ke
  `components/agent/ui/kit.tsx` (`AgGlass`, `AgChip`, `AgEmpty`, `AgRow`).
- Anti-slop: `AgentArtKeyframes`, `SpotWallet`, radial blob dihapus.
- Semua nilai uang pakai `fontVariantNumeric: 'tabular-nums'`.

### v2.9.22 — B2B anti-slop + FleetCalendar
- `B2BDashboard` hero: SVG kontur topografi + satu radial blur dihapus.
- `B2BFleetCalendar` dimigrasi ke kit B2B (`B2BKpi`, `B2BGlass`, `B2BPill`).

### v2.9.23 — Fix simpan profil B2B + Admin Overview
- **Bug lama**: `updateB2BProfile` menulis langsung ke `sp_users` (deny-all RLS).
  **Fix**: rute ke `callGateway('update_my_profile')`.
- Gateway `update_my_profile` SAFE list diperluas: `company_name`,
  `company_reg_no`, `company_industry` — khusus role `B2B_CLIENT`.
- Gateway `get_user_profile` SELECT list diperluas: `address`, `company_*`,
  `profile_photo_url`.
- **Admin B2B tab default = Overview** (bukan daftar submissions). 6 KPI
  deep-linkable + 4 stat sekunder + action-required amber panel + 5 shortcut.

### v2.9.24 — Audit Log + Payment History (roadmap #3 + #10)
- `components/b2b/B2BAuditLog.tsx` — riwayat aktivitas klien dengan aktor
  masking (`ADMIN/MASTER_ADMIN` → "Tim SurePath"). Paginasi 50/load.
- `components/b2b/B2BPayments.tsx` — satu pintu invoice batch + polis;
  KPI; filter All/Paid/Pending/Other; aksi Bayar Sekarang + Lihat Invoice.
- Gateway: `b2b_my_activity_log`, `b2b_my_payments`.

### v2.9.25 — Analytics + Documents (roadmap #2 + #5)
- `components/b2b/B2BAnalytics.tsx` — pure client-side; 4 KPI, 12-month
  premium bar chart (inline SVG), 3 breakdown.
- `components/b2b/B2BDocuments.tsx` — polis induk dengan signed URL 5 menit.
- Gateway additive: `b2b_bulk_list_batches` dapat `include_master_policy_url`.

## ⚠️ Deploy edge function masih diperlukan

Dari PR #407, aksi gateway baru/diubah **masih belum di deploy ke produksi**:
- `update_my_profile` (SAFE list B2B)
- `get_user_profile` (SELECT list diperluas)
- `b2b_my_activity_log` (baru)
- `b2b_my_payments` (baru)
- `b2b_bulk_list_batches` (flag `include_master_policy_url`)

Deploy:
```
supabase functions deploy data-gateway --project-ref uyjgeteelnswphyzkjwi
```

Atau aktifkan auto-deploy workflow dengan menambah repo secret
`SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF=uyjgeteelnswphyzkjwi` di
GitHub Settings → Secrets and variables → Actions.

v2.9.26 **tidak butuh deploy edge function** — perubahan hanya styling
tombol di `components/admin/AdminLogin.tsx`.

## Peta jalan portal B2B

Sudah dibangun (4 dari 10):
- ✅ **#2** Documents Center (v2.9.25)
- ✅ **#3** Payment History (v2.9.24)
- ✅ **#5** Analytics (v2.9.25)
- ✅ **#10** Audit Log mandiri (v2.9.24)

Belum, membutuhkan schema atau dependency baru:
- **#1** Klaim portal B2B (gateway + UI)
- **#4** Manajemen Tim/PIC (`sp_b2b_members` table + invite flow)
- **#6** Preferensi Notifikasi (`sp_user_notif_prefs` table)
- **#7** Endorsement Request (schema + approval workflow)
- **#8** COI on-demand (PDF library)
- **#9** Pengingat perpanjangan (FCM cron + schema)

## Backlog lama (masih berlaku)

- **Email domain Resend** — `myinsurepath.com` belum punya record Resend
  (`resend._domainkey` NXDOMAIN per 19 Nov 2026).
- **133 pesan error mentah** — `error.message` masih bocor di 133 tempat.
- **Repo GitHub masih publik** — pertimbangkan private.
- **Berkas R2 code siap tetapi UI belum pakai** — upload klien masih ke
  Supabase Storage.
