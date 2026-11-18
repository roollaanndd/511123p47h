# Alur PIN Agen SurePath (v2.9.16)

## Ringkas

Portal agen dikunci dengan PIN 6 digit. PIN diminta saat agen membuka portal
dalam sesi baru dan setiap kali perangkat sudah 30 menit tanpa aktivitas.
Login email/password tetap berlaku seperti biasa — PIN adalah lapisan kedua
yang melindungi perangkat yang sudah login dan ditinggalkan.

## Status dan transisi

| Kondisi | Layar | Aksi gateway |
| --- | --- | --- |
| `pin_configured = false` | Setup PIN (PIN + konfirmasi) | `set_pin` |
| `pin_configured = true`, kunci masih berlaku | Portal normal | — |
| `pin_configured = true`, idle ≥ 30 menit / kunci dipaksa | Unlock | `verify_pin` |
| Lupa PIN | Request OTP → reset | `request_pin_reset`, `reset_pin` |
| PWA/native standalone dibuka | Penanda sekali per akun | `mark_app_downloaded` |

`pin_configured` dibaca dari `get_my_profile`. Field `pin_hash`, `pin_salt`
sengaja **tidak** dikirim ke klien.

## Penyimpanan

**Server (sumber kebenaran)**

- `sp_users.pin_hash`, `pin_salt`, `pin_set_at`, `pin_failed_attempts`,
  `pin_locked_until`, `app_downloaded_at`.
- `sp_pin_resets` — OTP reset dalam bentuk hash, `expires_at`, `attempts`,
  `used_at`. RLS deny-all; semua akses lewat service-role `data-gateway`.
- Trigger `guard_sp_users_sensitive_self_updates()` menolak perubahan kolom
  tersebut lewat PostgREST oleh user biasa.

**Klien (hanya status UI, per akun)**

- `sp_pin_last_activity:<userId>` — cap waktu aktivitas terakhir (ms).
- `sp_pin_unlocked:<userId>` — `1` / `0`.
- `sp_pin_configured:<userId>` — cache hasil gateway, bukan rahasia.
- `sp_pin_app_downloaded_reported:<userId>` — penanda sudah melapor.

Mencuri localStorage tidak memberi PIN yang bisa dipakai: verifikasi tetap
terjadi di gateway dengan JWT pengguna yang sedang login.

## Kripto dan pembatasan

- PBKDF2-HMAC-SHA256, 210.000 iterasi, salt acak 16 byte, turunan 32 byte —
  identik dengan `services/authService.ts`.
- Hash dan perbandingan memakai WebCrypto satu implementasi
  (`supabase/functions/_shared/pin.ts`) agar Deno dan Vitest identik.
- 5 PIN salah → kunci 15 menit (`pin_locked_until`).
- Rate limit DB-backed via `sp_rate_limits`: set 10/jam, verify 20/jam,
  request reset 3/jam, verifikasi OTP 10/jam (per akun).
- OTP reset: 6 digit, TTL 10 menit, maksimal 5 attempt, sekali pakai.
- Jejak di `sp_activity_log` hanya nama aksi + status + HTTP status + kunci
  parameter. Nilai `pin` dan `code` tidak pernah masuk kolom `detail`.

## Idle watcher

`App.tsx` memasang pendengar `pointerdown`, `keydown`, `scroll`, `focus`,
`visibilitychange`, plus timer 30 detik. Setiap event:

1. Jika idle ≥ 30 menit → tandai kunci, tampilkan gate, **lalu** baru catat
   waktu. Urutan ini penting agar klik pertama setelah kembali tidak
   menghapus penanda idle.
2. Jika belum idle → perbarui cap waktu.

Saat logout, seluruh state PIN akun tersebut dihapus.

## Catatan operasional

- Setiap perubahan `supabase/functions/**` wajib di-deploy ulang
  `data-gateway` lewat `.github/workflows/deploy-edge-functions.yml`.
- Migrasi: `supabase/migrations/20261119130000_agent_pin_idle.sql`.
- `RESEND_API_KEY` (atau `RESEND_KEY`) harus tersedia di edge function untuk
  fitur lupa PIN. Tanpa itu, `request_pin_reset` menolak dengan 503.
- Token Supabase/GitHub hanya lewat GitHub Secrets — tidak pernah ditulis ke
  berkas repo.
