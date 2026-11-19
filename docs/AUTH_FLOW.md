# SurePath — Alur Autentikasi & Registrasi

> Terakhir diperbarui: 20 November 2026 (v2.9.21 — tombol Google resmi sejak awal, `/login` jadi satu form).

## Identitas: dua lapisan

1. **Supabase Auth** (`auth.users`) — akun login (email+password, Google ID token exchange, OTP email). Google credentials are obtained directly from Google Identity Services, then verified by Supabase with `signInWithIdToken` so every Google user still receives a Supabase session and `auth.users` record.
2. **Profil SurePath** (`public.sp_users`) — nama, role, agent_code, trust_score, dll.

Keduanya dihubungkan oleh action gateway **`ensure_profile`**: membuat baris `sp_users`
dari identitas JWT terverifikasi (id & email dari token, name/phone/role dari signup metadata)
jika belum ada. Idempoten — aman dipanggil berulang.

### ⚠️ Aturan tipe akun (v1.57.0)

**`ensure_profile` tidak akan pernah membuat profil tanpa role yang dinyatakan.** Dulu ia
jatuh ke `'CUSTOMER'` ketika pemanggil maupun metadata signup tidak menyebut role — dan
`AuthGate.buildUserObj` memang memanggilnya tanpa argumen. Akibatnya setiap pendaftar baru
yang tidak membawa role (Google OAuth, dan alur apa pun tanpa metadata signup) diam-diam
dijadikan nasabah **sebelum** layar pemilihan tipe akun sempat tampil. Kini pemanggilan
tanpa role dijawab **409 `ROLE_REQUIRED`** dan tidak ada baris yang ditulis.

Satu-satunya sumber role saat pembuatan profil:
1. `params.role` — dipilih pengguna di `RoleSelectionScreen` atau `AgentOnboarding`, atau
2. `user_metadata.role` — ditanam saat `signUp`, sehingga pilihan bertahan melewati
   konfirmasi email (bahkan di perangkat lain).

Role juga **immutable** lewat endpoint ini: profil yang sudah ada tidak pernah diturunkan
ke role yang diminta klien (lihat "ROLE STICKINESS" di `actions/users.ts`). Satu-satunya
jalur ubah role adalah `admin_update_user` yang teraudit.

⚠️ Akun lama (admin `angkouw84@gmail.com`, agent `angkouw777@gmail.com`) punya `sp_users.id`
yang BERBEDA dari auth id; gateway mencocokkan `id.eq OR email.eq` sehingga tetap jalan.
Jangan "merapikan" id ini — `sp_clients`, `sp_commissions`, dll mereferensikan id lama.

## Alur per skenario

### 1. Registrasi Customer (`AuthGate.tsx` → `handleRegister`)
1. Form registrasi punya toggle **Nasabah / Mitra** (`regRole`). Pilihan Mitra dialihkan ke
   `AgentOnboarding`; Nasabah lanjut di sini.
2. `supabase.auth.signUp(email, password, { data: { name, role: regRole } })` — role yang
   dikirim adalah yang dipilih pengguna (dulu di-hardcode `'CUSTOMER'`).
3. Jika ada sesi langsung (autoconfirm aktif) → `resolveAndLogin` → `ensure_profile({ role })`.
4. Jika butuh konfirmasi email → layar CHECK_EMAIL. Saat pengguna kembali dari tautan email,
   `App.tsx` membaca `user_metadata.role` dan membuat profil dengan role itu — pemilihan
   tipe akun tidak ditanyakan ulang (menanyakan ulang berarti pilihan Mitra bisa berubah
   jadi Nasabah).

### 2. Registrasi Agent (`AgentOnboarding.tsx`)
1. Step 1: nama/email/HP/password → Step 2: KTP/alamat (opsional) + persetujuan.
2. `supabase.auth.signUp` dengan metadata `{ name, phone, role: 'AGENT', ktp, address }`.
3. Ada sesi → `ensure_profile({ role: 'AGENT', ... })` → profil agent dibuat
   (`verified=false`, `commission_rate=0.1`, `agent_code` SP-AGT-XXXX) → langsung masuk.
4. Tanpa sesi → layar "Cek Email"; profil dibuat saat login pertama.
5. Agent baru harus **diverifikasi admin** sebelum dianggap aktif penuh.

### 3. Login email+password (`AuthGate.tsx` → `handleLogin`)
1. `signInWithPassword` → `resolveAndLogin` → `buildUserObj`.
2. `buildUserObj` **membaca saja** (`get_my_profile` via `fetchMyProfileForLogin`), tidak
   membuat. Tiga kemungkinan:
   - **profil ada** → objek user dengan role aslinya;
   - **404 (belum ada profil)** → jika `user_metadata.role` ada, profil dibuat dengan role
     itu; jika tidak ada, `onNeedsRoleSelection` → `RoleSelectionScreen`;
   - **gagal sementara** (5xx/jaringan) → tampilkan error, **jangan** login dengan role
     tebakan. Role yang salah menulis baris yang salah dan tidak memperbaiki diri sendiri.

### 4. Google Identity Services (renderButton-first, v2.9.21)
1. `services/googleAuth.ts` memuat GIS lalu memanggil **`renderButton` langsung ke slot di kartu login** melalui `components/shared/GoogleSignInButton.tsx`. Tidak ada `prompt()` One Tap dan tidak ada overlay fallback — cooldown FedCM yang dulu membuat klik kedua "mati" tidak lagi dilibatkan, dan pengguna tidak disuruh menutup dialog tambahan.
2. Callback GIS menerima ID token. `supabase.auth.signInWithIdToken({ provider: 'google', token, nonce })` memverifikasinya. `nonce` mentah dikirim ke Supabase harus merupakan preimage dari SHA-256 `nonce` yang diberikan ke `accounts.id.initialize`; kontrak ini diuji di `services/__tests__/googleAuth.test.ts`. Jangan pernah menukar keduanya atau menghapus nonce.
3. `App.tsx` / `AuthGate` resolves the Supabase session → finds the `sp_users` profile. Tidak ada profil dan tidak ada role di
   metadata → `RoleSelectionScreen` → user pilih Nasabah / Mitra / Klien Korporat →
   `ensure_profile({ role, phone, name })` (B2B lewat `createB2BClientProfile`). Pilihan ini dibuat **sekali** saat profil terbentuk; login berikutnya memakai role tersimpan sebagai routing, bukan otoritas.
4. **Header wajib GIS.** CSP harus mengizinkan `https://accounts.google.com` pada
   `script-src`, `connect-src`, `frame-src`, dan `https://accounts.google.com/gsi/style`
   pada `style-src`. Tanpa `style-src`, stylesheet Google diblokir sehingga tombol Google tidak tampil. COOP harus `same-origin-allow-popups` karena alur akun Google memakai popup; `same-origin` memutus `window.opener` sehingga popup gagal berkomunikasi. Ketiga sumber konfigurasi (`vercel.json`, `public/_headers`,
   `server.ts`) harus konsisten; dijaga oleh
   `services/__tests__/googleAuthHeaders.test.ts`.
5. **Dua jalur, satu layar.** Pada web, `?code=` di URL membuat `App.tsx` menahan render
   (`oauthLoading`) sampai profil selesai dicek. Pada APK native (deep link) tidak ada
   `?code=`, jadi `AuthGate` yang sedang tampil ikut menangkap event `SIGNED_IN` — karena
   itu `AuthGate` juga harus bisa memunculkan pemilih role, lewat prop
   `onNeedsRoleSelection`. Tanpa itu, pengguna Android selalu berakhir sebagai nasabah.
6. **Client ID harus cocok dengan Supabase.** Nilai `VITE_GOOGLE_CLIENT_ID` yang dipakai
   GIS di browser harus tercantum di Supabase Dashboard → Authentication → Providers →
   Google → *Client IDs*. Beberapa client ID boleh ditulis comma-separated dengan web
   client di depan. Jika tidak, Supabase menerima token Google tetapi menolak audience
   dengan `Unacceptable audience in id_token: [...]` meskipun provider Google sudah
   aktif. Perbaikan bisa lewat Management API `PATCH /v1/projects/{ref}/config/auth`
   dengan `external_google_client_id` berisi daftar tersebut. Jangan simpan PAT Supabase
   atau Google client secret di repo; setelah konfigurasi berubah, coba login dari tab
   baru.

### 5. OTP Email / Magic Link & Reset Password
- Ditangani di `AuthGate.tsx`: `signInWithOtp` (shouldCreateUser=false), `verifyOtp`,
  `resetPasswordForEmail` + mode `RESET_PASSWORD` via event `PASSWORD_RECOVERY`.

### 6. Login Admin (`components/admin/AdminLogin.tsx`)
- Email/password atau tombol Google resmi. Keduanya menghasilkan sesi Supabase yang sama.
- Google **hanya membuktikan identitas**. Akses diberikan hanya jika `get_my_profile`
  (via gateway, dengan access token sesi) mengembalikan profil `sp_users` yang sudah ada
  dengan `ADMIN_ROLES` atau `allowed_apps` memuat `ADMIN`. Jika tidak, sesi di-signOut.
  Tidak ada auto-provision profil dari Google.
- Operator (`components/operator/OperatorLogin.tsx`) tetap email/password dan memeriksa
  `role === OPERATOR` atau `allowed_apps` memuat `OPERATOR`. Insurer
  (`components/insurer/InsurerLogin.tsx`) tetap token undangan 7 hari. Keduanya sengaja
  tidak memakai Google agar otorisasi internal dan alur token tetap eksplisit.

### 7. Login B2B (`components/b2b/B2BLogin.tsx`)
- Email/password atau tombol Google resmi. Google tidak boleh membuat profil korporat.
- Setelah sesi ada, `fetchMyProfileForLogin` harus mengembalikan profil dengan role
  `B2B_CLIENT` atau `MASTER_ADMIN`; selain itu sesi di-signOut dan pengguna diberi pesan
  untuk memakai portal sesuai perannya.

## Riwayat bug yang sudah diperbaiki (PR #3, 10 Juni 2026)

| Bug | Akar masalah | Fix |
|---|---|---|
| Registrasi agent selalu gagal | Tidak pernah `signUp`; memanggil `admin_register_agent` (butuh admin + sesi) | signUp asli + `ensure_profile` |
| OAuth pilih role AGENT gagal | Sama — action admin-only | `ensure_profile` |
| Agent login di APK jadi CUSTOMER | CORS gateway menolak origin `https://localhost` | Izinkan `https://localhost` & `capacitor://localhost` |
| Profil customer kadang tidak tersimpan | Upsert `sp_users` langsung dari browser (rapuh terhadap RLS) | Dihapus; diganti `ensure_profile` server-side |
| 4 akun lama tanpa profil | Sisa bug lama | Backfill manual ke `sp_users` (10 Juni 2026) |

## Riwayat bug yang sudah diperbaiki (v1.57.0, 7 September 2026)

| Bug | Akar masalah | Fix |
|---|---|---|
| Setiap pendaftar baru masuk ke aplikasi nasabah, pemilihan tipe akun tidak pernah muncul | `AuthGate.buildUserObj` memanggil `ensure_profile()` **tanpa role**, dan server diam-diam default ke `CUSTOMER` — profil sudah tercipta sebelum `RoleSelectionScreen` sempat jalan | Lookup di `AuthGate` jadi read-only; profil hanya dibuat kalau rolenya sudah diketahui, selain itu `onNeedsRoleSelection` → pemilih role. Server menolak pembuatan tanpa role (409 `ROLE_REQUIRED`) |
| Pengguna APK Android selalu jadi nasabah | Deep-link OAuth tidak membawa `?code=`, jadi penjaga `oauthLoading` di `App.tsx` tidak aktif dan `AuthGate` yang menangani sesi — lalu membuat profil `CUSTOMER` | `AuthGate` kini bisa memanggil pemilih role lewat `onNeedsRoleSelection` |
| Pilihan "Mitra" di form registrasi tidak ikut ke signup | `options.data.role` di-hardcode `UserRole.CUSTOMER`, mengabaikan toggle `regRole` | Kirim `regRole` |
| Login gagal sementara → user masuk sebagai nasabah | `resolveAndLogin` menangkap error lalu login dengan objek fallback ber-role `CUSTOMER` | Tampilkan error dan minta coba lagi; jangan pernah menebak role |
| Layar login berkedip di tengah OAuth | Timeout 10 detik menurunkan `oauthLoading` walau pencarian profil masih berjalan | Timeout hanya berlaku kalau tidak ada proses yang berjalan |
