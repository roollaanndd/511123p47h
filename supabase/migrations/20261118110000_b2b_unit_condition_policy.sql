-- B2B order unit — kondisi kendaraan & copy polis yang masih berlaku.
-- Order satuan memakai tabel batch yang sama dengan impor massal; baris impor
-- tidak mengirim kedua field ini dan tetap memakai default BEKAS/NULL.

alter table public.sp_b2b_batch_items
  add column if not exists vehicle_condition text not null default 'BEKAS',
  add column if not exists policy_copy_expiry date;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sp_b2b_batch_items_vehicle_condition'
  ) then
    alter table public.sp_b2b_batch_items
      add constraint sp_b2b_batch_items_vehicle_condition
      check (vehicle_condition in ('BARU', 'BEKAS'));
  end if;
end $$;

comment on column public.sp_b2b_batch_items.vehicle_condition is
  'Kondisi unit pada order satuan: BARU (cukup BSTK/faktur) atau BEKAS (wajib foto). Impor massal memakai BEKAS.';
comment on column public.sp_b2b_batch_items.policy_copy_expiry is
  'Tanggal berlaku copy polis yang dilampirkan. Gateway menolak tanggal sebelum hari pengajuan.';
comment on column public.sp_b2b_batch_items.vehicle_photos is
  'Array lampiran order unit: [{slot, url, uploaded_at, size_bytes}]. Slot foto: depan/belakang/samping-*/rangka/stnk. Slot dokumen: bstk/faktur/copy-polis.';
