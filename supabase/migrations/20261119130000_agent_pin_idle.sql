-- v2.9.16 — PIN agen 6 digit dengan kunci idle 30 menit.
--
-- Klien hanya boleh mengirim PIN ke data-gateway. Kolom hash/salt TIDAK
-- dikembalikan oleh get_my_profile dan TIDAK bisa diubah lewat PostgREST
-- (trigger guard diperluas di bawah). Semua tulisan PIN lewat service-role
-- gateway yang diaudit tanpa nilai PIN mentah.
--
-- sp_pin_resets menyimpan hash OTP reset (bukan OTP mentah), TTL 10 menit,
-- dan pembatasan attempt. RLS deny-all — akses hanya lewat gateway.

alter table public.sp_users
  add column if not exists pin_hash text,
  add column if not exists pin_salt text,
  add column if not exists pin_set_at timestamptz,
  add column if not exists pin_failed_attempts integer not null default 0,
  add column if not exists pin_locked_until timestamptz,
  add column if not exists app_downloaded_at timestamptz;

do $$
begin
  alter table public.sp_users
    add constraint sp_users_pin_pair_check
    check ((pin_hash is null) = (pin_salt is null) and (pin_hash is null) = (pin_set_at is null));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.sp_users
    add constraint sp_users_pin_hash_check
    check (pin_hash is null or char_length(pin_hash) = 44);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.sp_users
    add constraint sp_users_pin_salt_check
    check (pin_salt is null or char_length(pin_salt) = 24);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.sp_users
    add constraint sp_users_pin_failed_attempts_check
    check (pin_failed_attempts between 0 and 5);
exception when duplicate_object then null;
end $$;

comment on column public.sp_users.pin_hash is
  'PBKDF2-HMAC-SHA256 210k dari PIN 6 digit agen (base64 32 byte). Jangan dikirim ke klien.';
comment on column public.sp_users.pin_salt is
  'Salt acak 16 byte (base64) untuk pin_hash. Jangan dikirim ke klien.';
comment on column public.sp_users.pin_set_at is
  'Waktu PIN terakhir dibuat atau direset lewat OTP email.';
comment on column public.sp_users.pin_failed_attempts is
  'Attempt PIN salah berturut-turut; dikunci setelah 5.';
comment on column public.sp_users.pin_locked_until is
  'Kunci verifikasi PIN sampai waktu ini (15 menit setelah attempt ke-5).';
comment on column public.sp_users.app_downloaded_at is
  'Waktu agen membuka SurePath dari PWA yang terpasang (dilaporkan lewat gateway).';

create table if not exists public.sp_pin_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.sp_users(id) on delete cascade,
  code_hash text not null,
  salt text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  used_at timestamptz,
  created_by_ip text,
  created_at timestamptz not null default now(),
  constraint sp_pin_resets_code_hash_check check (char_length(code_hash) = 44),
  constraint sp_pin_resets_salt_check check (char_length(salt) = 24),
  constraint sp_pin_resets_attempts_check check (attempts between 0 and 5)
);

create index if not exists sp_pin_resets_user_active_idx
  on public.sp_pin_resets (user_id, created_at desc) where used_at is null;

alter table public.sp_pin_resets enable row level security;

-- Deny-all; semua akses via data-gateway service_role.
drop policy if exists sp_pin_resets_deny_all on public.sp_pin_resets;
create policy sp_pin_resets_deny_all on public.sp_pin_resets
  for all using (false) with check (false);

revoke all on table public.sp_pin_resets from anon;
revoke all on table public.sp_pin_resets from authenticated;

-- Perluas guard lama supaya PIN tidak bisa ditimpa lewat update profil biasa.
-- service_role dan admin (pemilik alur lama) tetap seperti semula.
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
       OR NEW.pin_hash IS DISTINCT FROM OLD.pin_hash
       OR NEW.pin_salt IS DISTINCT FROM OLD.pin_salt
       OR NEW.pin_set_at IS DISTINCT FROM OLD.pin_set_at
       OR NEW.pin_failed_attempts IS DISTINCT FROM OLD.pin_failed_attempts
       OR NEW.pin_locked_until IS DISTINCT FROM OLD.pin_locked_until
       OR NEW.app_downloaded_at IS DISTINCT FROM OLD.app_downloaded_at THEN
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
