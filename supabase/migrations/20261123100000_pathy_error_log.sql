-- ════════════════════════════════════════════════════════════════════════════
-- sp_pathy_errors — jejak kegagalan Pathy (diagnosa 2026-11-23)
--
-- Latar belakang: keluhan "Pathy sering error" berujung pada pesan AUTH
-- ("Sesi kamu sudah berakhir"). Kegagalan itu nyaris tak meninggalkan jejak:
--   • kalau JWT ditolak platform Supabase, fungsi edge TIDAK PERNAH dijalankan,
--     jadi console.error di dalam fungsi pun tidak dieksekusi;
--   • kalau fungsi sempat jalan, alasannya hanya ditulis ke console (log
--     sementara, tidak bisa dibaca dari CMS).
--
-- Tabel ini adalah sink tunggal untuk dua sumber:
--   source = 'client'  → beacon dari browser saat Pathy gagal. Ditulis memakai
--                        klien anon TANPA sesi, supaya tetap tercatat justru
--                        pada kasus JWT kedaluwarsa (kalau memakai sesi, PostgREST
--                        menolak duluan dengan PGRST301 dan jejaknya hilang).
--   source = 'agent' | 'proxy' | 'ai-proxy' → ditulis service_role dari edge
--                        function, termasuk status upstream OpenRouter.
--
-- Sengaja TIDAK menyimpan isi pesan pengguna maupun jawaban model: yang dicari
-- adalah kode/status, bukan percakapan. `detail` dibatasi 500 karakter dan
-- pemanggil hanya boleh mengirim pesan galat, bukan prompt.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.sp_pathy_errors (
  id                bigserial PRIMARY KEY,
  created_at        timestamptz NOT NULL DEFAULT now(),
  source            text NOT NULL CHECK (source IN ('client', 'agent', 'proxy', 'ai-proxy')),
  -- Kode yang dipakai klien (PathyErrorCode) plus kode diagnostik tambahan.
  code              text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 32),
  http_status       integer,
  route             text CHECK (route IS NULL OR char_length(route) <= 60),
  detail            text CHECK (detail IS NULL OR char_length(detail) <= 500),
  user_id           uuid,
  user_email        text CHECK (user_email IS NULL OR char_length(user_email) <= 200),
  session_present   boolean,
  token_expires_at  timestamptz,
  client_clock      timestamptz,
  user_agent        text CHECK (user_agent IS NULL OR char_length(user_agent) <= 300)
);

CREATE INDEX IF NOT EXISTS sp_pathy_errors_created_idx
  ON public.sp_pathy_errors (created_at DESC);

CREATE INDEX IF NOT EXISTS sp_pathy_errors_code_idx
  ON public.sp_pathy_errors (code, created_at DESC);

ALTER TABLE public.sp_pathy_errors ENABLE ROW LEVEL SECURITY;

-- Tulis saja, dari browser. Tidak ada SELECT: pengguna tidak boleh membaca
-- (apalagi menghapus) jejak kegagalan siapa pun.
DROP POLICY IF EXISTS "sp_pathy_errors_client_insert" ON public.sp_pathy_errors;
CREATE POLICY "sp_pathy_errors_client_insert"
  ON public.sp_pathy_errors FOR INSERT
  TO anon, authenticated
  WITH CHECK (source = 'client');

-- Admin CMS boleh membaca untuk menelusuri keluhan. is_admin() sudah dipakai
-- policy lain (20260704_security_hardening_phase1.sql).
DROP POLICY IF EXISTS "sp_pathy_errors_admin_read" ON public.sp_pathy_errors;
CREATE POLICY "sp_pathy_errors_admin_read"
  ON public.sp_pathy_errors FOR SELECT
  TO authenticated
  USING (is_admin());

-- PostgREST butuh GRANT eksplisit; RLS tetap yang menentukan baris.
GRANT INSERT ON TABLE public.sp_pathy_errors TO anon, authenticated;
GRANT SELECT ON TABLE public.sp_pathy_errors TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sp_pathy_errors_id_seq TO anon, authenticated;
