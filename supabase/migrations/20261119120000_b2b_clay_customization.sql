-- v2.9.15 — Kustomisasi tampilan clay untuk picker insurer & paket B2B.
--
-- Admin dashboard mengatur warna aksen, ikon, urutan, poin detail hover, dan
-- flag unggulan. Klien B2B melihatnya sebagai clay tile: warna/ikon per
-- insurer, detail ribbon saat hover/focus, dan kartu paket dengan aksen
-- masing-masing. Tidak ada data keuangan/identitas yang dipindah ke klien.
--
-- Baris lama tetap valid: semua kolom punya default netral, jadi picker tidak
-- berubah warna sampai admin mengisinya.

alter table public.sp_insurers
  add column if not exists accent_color text,
  add column if not exists icon text not null default 'building',
  add column if not exists sort_order integer not null default 0,
  add column if not exists highlight_bullets jsonb not null default '[]'::jsonb,
  add column if not exists featured boolean not null default false;

alter table public.sp_b2b_plans
  add column if not exists accent_color text,
  add column if not exists icon text not null default 'sparkles',
  add column if not exists featured boolean not null default false;

do $$
begin
  alter table public.sp_insurers
    add constraint sp_insurers_accent_color_check
    check (accent_color is null or accent_color ~ '^#[0-9A-Fa-f]{6}$');
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.sp_insurers
    add constraint sp_insurers_icon_check
    check (icon in ('building','shield','shield-check','landmark','umbrella','star','award','sparkles','zap','circle-dot'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.sp_insurers
    add constraint sp_insurers_sort_order_check
    check (sort_order between -999 and 999);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.sp_b2b_plans
    add constraint sp_b2b_plans_accent_color_check
    check (accent_color is null or accent_color ~ '^#[0-9A-Fa-f]{6}$');
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.sp_b2b_plans
    add constraint sp_b2b_plans_icon_check
    check (icon in ('building','shield','shield-check','landmark','umbrella','star','award','sparkles','zap','circle-dot'));
exception when duplicate_object then null;
end $$;

comment on column public.sp_insurers.accent_color is
  'Warna aksen clay (#RRGGBB) untuk kartu insurer di portal B2B; null = netral.';
comment on column public.sp_insurers.icon is
  'Kunci ikon dari daftar yang diizinkan; dipakai bila logo belum diunggah.';
comment on column public.sp_insurers.sort_order is
  'Urutan tampil insurer di picker B2B (kecil ke besar, lalu nama).';
comment on column public.sp_insurers.highlight_bullets is
  'Maksimal 5 poin detail per insurer yang muncul saat hover/focus.';
comment on column public.sp_insurers.featured is
  'Tandai insurer sebagai unggulan/rekomendasi di picker B2B.';
comment on column public.sp_b2b_plans.accent_color is
  'Warna aksen clay (#RRGGBB) untuk kartu paket B2B; null = netral.';
comment on column public.sp_b2b_plans.icon is
  'Kunci ikon kartu paket B2B dari daftar yang diizinkan.';
comment on column public.sp_b2b_plans.featured is
  'Tandai paket sebagai rekomendasi di kartu paket B2B.';

create index if not exists sp_insurers_active_sort_idx
  on public.sp_insurers (sort_order, name) where is_active = true;
