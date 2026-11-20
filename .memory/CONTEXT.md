# SurePath Session Context
**Updated:** 2026-11-20 (v2.9.25 — agent Kaca Pagi + B2B expansion + Admin Overview, PR #407 merged)

## Terakhir dikerjakan (20 Nov 2026) — PR #407 merged ke main sebagai `408da1c`

7 commit sekaligus (v2.9.21 → v2.9.25), 17 files, +1997/-353.

### v2.9.21 — Agent inner-screen Kaca Pagi
- `AgentWallet`, `AgentCommission`, `AgentProfile` dimigrasi penuh ke
  `components/agent/ui/kit.tsx` (`AgGlass`, `AgChip`, `AgEmpty`, `AgRow`, ...).
- Anti-slop: `AgentArtKeyframes`, `SpotWallet`, radial blob dihapus.
- Semua nilai uang pakai `fontVariantNumeric: 'tabular-nums'`.
- 1 fix lanjutan (`536af8c`): import tidak terpakai + ikon `clock` → `history`.

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
  deep-linkable + 4 stat sekunder + action-required amber panel + 5 shortcut
  navigasi. Komponen: `B2BOverviewSection` di `components/admin/B2BAdminView.tsx`.

### v2.9.24 — Audit Log + Payment History (roadmap #3 + #10)
- `components/b2b/B2BAuditLog.tsx` — riwayat aktivitas klien dengan aktor
  masking (`ADMIN/MASTER_ADMIN` → "Tim SurePath"). Paginasi 50/load.
- `components/b2b/B2BPayments.tsx` — satu pintu invoice batch + polis;
  KPI (Total Lunas, Menunggu, Transaksi, Bulan Ini); filter All/Paid/Pending/Other;
  aksi Bayar Sekarang (Xendit) + Lihat Invoice.
- Gateway: `b2b_my_activity_log` (filter `client_id` otomatis dari JWT),
  `b2b_my_payments` (OR batch_id/order_id caller + enrichment).

### v2.9.25 — Analytics + Documents (roadmap #2 + #5)
- `components/b2b/B2BAnalytics.tsx` — pure client-side; 4 KPI, 12-month
  premium bar chart (inline SVG), 3 breakdown (produk, insurer, status).
- `components/b2b/B2BDocuments.tsx` — polis induk dengan signed URL 5 menit,
  search + "Hanya terbit" filter, chip "Legacy" untuk URL http:// lama.
- Gateway additive: `b2b_bulk_list_batches` dapat `include_master_policy_url`
  (default false — backward-compatible).

## ⚠️ Deploy edge function diperlukan

Aksi gateway baru/diubah **belum ada di produksi**:
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
GitHub Settings → Secrets and variables → Actions. Setelah itu
`.github/workflows/deploy-edge-functions.yml` deploy otomatis pada push ke main.

Sampai edge deploy jalan: layar Analytics tetap bekerja (pure client), tetapi
Profile save / Payments / Audit Log / Documents gagal (aksi tidak dikenal
gateway versi lama).

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
  (`resend._domainkey` NXDOMAIN per 19 Nov 2026). SPF root hanya Cloudflare.
- **133 pesan error mentah** — `error.message` masih bocor di 133 tempat
  (HTTP 400 responses). Keamanan + UX.
- **Repo GitHub masih publik** — pertimbangkan private.
- **Berkas R2 code siap tetapi UI belum pakai** — upload klien masih ke
  Supabase Storage. Migrasi UI ke `r2_upload_url` + `r2_confirm_upload`
  belum dikerjakan.

## Branch state

Branch kerja `claude/busy-goldberg-h5o5lm` sudah di-merge via PR #407 ke
`main`. Branch ini masih ada di remote; untuk pekerjaan berikutnya, start
dari fresh branch off `main`.
