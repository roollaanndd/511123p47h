-- ═══════════════════════════════════════════════════════════════════════════
-- B2B user management di dashboard admin (v2.9.17)
--
-- Latar: tab "Pengguna Korporat" baru bisa create + list + reset sandi.
-- Admin butuh edit profil/KYC, nonaktifkan/aktifkan, dan hapus permanen.
--
-- Keputusan desain:
--   * Kolom KYC baru (company_npwp, company_address, pic_ktp) dipisahkan dari
--     `ktp`/`address` lama yang semantiknya untuk agen/customer.
--   * Nonaktif memakai cap waktu, BUKAN `is_suspended` (kolom itu tidak ada di
--     produksi dan ditolak whitelist admin_update_user). Akun bisa diaktifkan
--     kembali tanpa kehilangan batch/polis.
--   * b2b_profile_version dipakai optimistic lock supaya dua admin yang edit
--     bersamaan tidak saling menimpa.
--   * Hard delete tidak menghapus batch secara diam-diam: gateway menolak bila
--     masih ada baris sp_b2b_batches (FK ON DELETE CASCADE akan menghanguskan
--     seluruh item polis massal + pembayaran terkait).
--
-- Semua DDL idempotent. Rollback (manual, hanya bila diperlukan):
--   ALTER TABLE public.sp_users
--     DROP COLUMN IF EXISTS company_npwp,
--     DROP COLUMN IF EXISTS company_address,
--     DROP COLUMN IF EXISTS pic_ktp,
--     DROP COLUMN IF EXISTS b2b_deactivated_at,
--     DROP COLUMN IF EXISTS b2b_deactivated_by,
--     DROP COLUMN IF EXISTS b2b_profile_version;
-- Perhatian: rollback menghapus data KYC yang sudah tersimpan.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.sp_users
  ADD COLUMN IF NOT EXISTS company_npwp       text,
  ADD COLUMN IF NOT EXISTS company_address    text,
  ADD COLUMN IF NOT EXISTS pic_ktp            text,
  ADD COLUMN IF NOT EXISTS b2b_deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS b2b_deactivated_by uuid REFERENCES public.sp_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS b2b_profile_version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.sp_users.company_npwp IS 'NPWP perusahaan B2B (15/16 digit, tanpa titik saat dinormalisasi gateway).';
COMMENT ON COLUMN public.sp_users.company_address IS 'Alamat domisili perusahaan B2B.';
COMMENT ON COLUMN public.sp_users.pic_ktp IS 'NIK KTP penanggung jawab (PIC) perusahaan B2B.';
COMMENT ON COLUMN public.sp_users.b2b_deactivated_at IS 'Cap waktu nonaktif akun B2B. NULL = aktif. Gateway memblokir semua aksi bila terisi.';
COMMENT ON COLUMN public.sp_users.b2b_deactivated_by IS 'sp_users.id admin yang menonaktifkan akun B2B.';
COMMENT ON COLUMN public.sp_users.b2b_profile_version IS 'Nomor versi untuk optimistic lock pada edit profil B2B oleh admin.';

CREATE INDEX IF NOT EXISTS idx_sp_users_b2b_deactivated
  ON public.sp_users (b2b_deactivated_at)
  WHERE role = 'B2B_CLIENT' AND b2b_deactivated_at IS NOT NULL;

-- ── Perluas guard self-update ───────────────────────────────────────────────
-- Trigger lama (20261013120000) melindungi role/verified/komisi, tapi field
-- KYC baru belum tercakup. Tanpa ini, klien B2B bisa menimpa NPWP/KTP-nya
-- lewat PostgREST self-update dan menghilangkan jejak edit admin.
CREATE OR REPLACE FUNCTION public.guard_sp_users_sensitive_self_updates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND COALESCE(public.is_admin(), false) = false THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.allowed_apps IS DISTINCT FROM OLD.allowed_apps
       OR NEW.verified IS DISTINCT FROM OLD.verified
       OR NEW.trust_score IS DISTINCT FROM OLD.trust_score
       OR NEW.agent_code IS DISTINCT FROM OLD.agent_code
       OR NEW.commission_rate IS DISTINCT FROM OLD.commission_rate
       OR NEW.monthly_target IS DISTINCT FROM OLD.monthly_target
       OR NEW.coins_balance IS DISTINCT FROM OLD.coins_balance
       OR NEW.referral_code IS DISTINCT FROM OLD.referral_code
       OR NEW.upline_id IS DISTINCT FROM OLD.upline_id
       OR NEW.override_commission_total IS DISTINCT FROM OLD.override_commission_total
       OR NEW.tier IS DISTINCT FROM OLD.tier
       OR NEW.tier_assigned_by IS DISTINCT FROM OLD.tier_assigned_by
       OR NEW.tier_assigned_at IS DISTINCT FROM OLD.tier_assigned_at
       OR NEW.identity_status IS DISTINCT FROM OLD.identity_status
       OR NEW.identity_reviewed_by IS DISTINCT FROM OLD.identity_reviewed_by
       OR NEW.identity_reviewed_at IS DISTINCT FROM OLD.identity_reviewed_at
       OR NEW.identity_reject_reason IS DISTINCT FROM OLD.identity_reject_reason
       OR NEW.phone_verified_at IS DISTINCT FROM OLD.phone_verified_at
       OR NEW.member_since IS DISTINCT FROM OLD.member_since
       -- v2.9.17: field yang hanya boleh ditulis admin B2B / service_role.
       OR NEW.company_npwp IS DISTINCT FROM OLD.company_npwp
       OR NEW.company_address IS DISTINCT FROM OLD.company_address
       OR NEW.pic_ktp IS DISTINCT FROM OLD.pic_ktp
       OR NEW.b2b_deactivated_at IS DISTINCT FROM OLD.b2b_deactivated_at
       OR NEW.b2b_deactivated_by IS DISTINCT FROM OLD.b2b_deactivated_by
       OR NEW.b2b_profile_version IS DISTINCT FROM OLD.b2b_profile_version THEN
      RAISE EXCEPTION 'Sensitive account fields can only be changed by an authorized administrator'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_sp_users_sensitive_self_updates() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_sp_users_sensitive_self_updates() FROM anon;
REVOKE ALL ON FUNCTION public.guard_sp_users_sensitive_self_updates() FROM authenticated;

DROP TRIGGER IF EXISTS trg_guard_sp_users_sensitive_self_updates ON public.sp_users;
CREATE TRIGGER trg_guard_sp_users_sensitive_self_updates
  BEFORE UPDATE ON public.sp_users
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_sp_users_sensitive_self_updates();
