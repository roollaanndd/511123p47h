-- B2B corporate submission routing to insurer underwriting portals.
-- Assignments are gateway-only: insurer tokens are validated in the data-gateway,
-- and browser roles must never read or mutate this table directly.

create table if not exists public.sp_b2b_submission_insurers (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.sp_b2b_submissions(id) on delete cascade,
  insurer_id uuid not null references public.sp_insurers(id) on delete restrict,
  assigned_by uuid,
  authorization_confirmed boolean not null default false,
  authorization_confirmed_at timestamptz,
  authorization_confirmed_by uuid,
  status text not null default 'ASSIGNED'
    check (status in ('ASSIGNED', 'REQUEST_INFO', 'QUOTED', 'DECLINED')),
  decision_notes text,
  quoted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sp_b2b_submission_insurers_unique unique (submission_id, insurer_id),
  constraint sp_b2b_submission_insurers_authorization_check
    check (
      (authorization_confirmed = false and authorization_confirmed_at is null and authorization_confirmed_by is null)
      or
      (authorization_confirmed = true and authorization_confirmed_at is not null and authorization_confirmed_by is not null)
    )
);

create index if not exists sp_b2b_submission_insurers_insurer_status_idx
  on public.sp_b2b_submission_insurers (insurer_id, status, created_at desc);
create index if not exists sp_b2b_submission_insurers_submission_idx
  on public.sp_b2b_submission_insurers (submission_id, created_at desc);

alter table public.sp_b2b_submission_insurers enable row level security;
revoke all on table public.sp_b2b_submission_insurers from public, anon, authenticated;
grant select, insert, update, delete on table public.sp_b2b_submission_insurers to service_role;
