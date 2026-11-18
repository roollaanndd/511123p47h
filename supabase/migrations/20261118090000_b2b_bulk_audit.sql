-- ═══════════════════════════════════════════════════════════════════════════
-- B2B bulk: source-file provenance + dedicated activity log
--
-- Why (18 Nov 2026):
--   1. PROVENANCE — the client's uploaded spreadsheet (b2b-documents/
--      {clientId}/bulk-source/…) was uploaded fire-and-forget and its storage
--      PATH was never persisted anywhere: only the original file name lived
--      on sp_b2b_batches.source_file_name. A successful upload became an
--      orphan file admin could never find again, and a failed upload was
--      invisible. We store the path (plus size/mime) so the file can be
--      re-signed and re-downloaded on demand — the same pattern
--      master_policy_document_url has used since the 2026-11-05 fix.
--
--   2. ACTIVITY LOG — sp_activity_log is a generic per-user trail whose
--      `detail` is deliberately built from a safe whitelist and never stores
--      domain payload (batch numbers, item counts, amounts). B2B operations
--      deserve a first-class trail that answers "what did client X do, when,
--      on which batch, for how much" — and keeps answering it for actions we
--      add later. sp_b2b_activity_log is deny-all RLS, written only by the
--      service-role gateway (logB2BActivity helper), read via
--      admin_b2b_activity_log.
--
--   3. DEFENSE IN DEPTH — sp_policy_orders/sp_payments have DB-level audit
--      triggers (20260714); the B2B bulk tables did not. Status changes and
--      deletions of sp_b2b_batches now land in sp_audit_log regardless of who
--      (or what) writes them.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Source-file provenance on the batch header ──────────────────────────
ALTER TABLE public.sp_b2b_batches
  ADD COLUMN IF NOT EXISTS source_file_path text;
ALTER TABLE public.sp_b2b_batches
  ADD COLUMN IF NOT EXISTS source_file_size integer;
ALTER TABLE public.sp_b2b_batches
  ADD COLUMN IF NOT EXISTS source_file_mime text;

-- ── 2. Dedicated B2B activity log ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sp_b2b_activity_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- Siapa: profil B2B terkait + peran/aktor yang melakukan (bisa klien,
  -- admin, insurer, atau 'system' dari webhook pembayaran).
  client_id    uuid REFERENCES public.sp_users(id) ON DELETE SET NULL,
  actor_role   text,
  actor_email  text,

  -- Ke mana: batch terkait. batch_number disimpan redup agar log tetap
  -- terbaca setelah batch dihapus; FK SET NULL (bukan CASCADE) supaya
  -- riwayat tidak ikut terhapus.
  batch_id     uuid REFERENCES public.sp_b2b_batches(id) ON DELETE SET NULL,
  batch_number text,

  action       text        NOT NULL,   -- 'bulk_batch_created', 'bulk_paid', …
  summary      text        NOT NULL,   -- kalimat manusiawi, siap ditampilkan
  detail       jsonb,                  -- data terstruktur non-PII (jumlah, file, …)

  ip           text,
  user_agent   text
);

CREATE INDEX IF NOT EXISTS idx_sp_b2b_activity_client  ON public.sp_b2b_activity_log(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sp_b2b_activity_batch   ON public.sp_b2b_activity_log(batch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sp_b2b_activity_created ON public.sp_b2b_activity_log(created_at DESC);

ALTER TABLE public.sp_b2b_activity_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_direct_gateway_only ON public.sp_b2b_activity_log;
CREATE POLICY deny_direct_gateway_only ON public.sp_b2b_activity_log
  FOR ALL USING (false) WITH CHECK (false);

-- ── 3. DB-level audit triggers (pola 20260714_integrity_hardening.sql) ─────
-- Setiap UPDATE yang mengubah status/dokumen/penghitung batch, dan setiap
-- DELETE batch (item ikut ter-CASCADE), masuk sp_audit_log — apa pun yang
-- menulisnya, sehingga tampering di luar gateway tetap terlihat.
CREATE OR REPLACE FUNCTION public.audit_b2b_batch_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- Hanya update yang benar-benar mengubah kolom kritis yang diaudit —
  -- perubahan updated_at/noise lain tidak menenggelamkan jejak.
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.insurer_id IS DISTINCT FROM OLD.insurer_id
     OR NEW.master_policy_number IS DISTINCT FROM OLD.master_policy_number
     OR NEW.master_policy_document_url IS DISTINCT FROM OLD.master_policy_document_url
     OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
     OR NEW.source_file_path IS DISTINCT FROM OLD.source_file_path
  THEN
    INSERT INTO public.sp_audit_log (table_name, record_id, action, old_values, new_values)
  VALUES (
    TG_TABLE_NAME,
    NEW.id,
    'UPDATE',
    to_jsonb(jsonb_build_object(
      'status',                     OLD.status,
      'insurer_id',                 OLD.insurer_id,
      'master_policy_number',       OLD.master_policy_number,
      'master_policy_document_url', OLD.master_policy_document_url,
      'total_amount',               OLD.total_amount
    )),
    to_jsonb(jsonb_build_object(
      'status',                     NEW.status,
      'insurer_id',                 NEW.insurer_id,
      'master_policy_number',       NEW.master_policy_number,
      'master_policy_document_url', NEW.master_policy_document_url,
      'total_amount',               NEW.total_amount
    ))
  );
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_b2b_batch_update ON public.sp_b2b_batches;
CREATE TRIGGER trg_audit_b2b_batch_update
  AFTER UPDATE ON public.sp_b2b_batches
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_b2b_batch_update();

CREATE OR REPLACE FUNCTION public.audit_b2b_batch_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  INSERT INTO public.sp_audit_log (table_name, record_id, action, old_values)
  VALUES (
    TG_TABLE_NAME,
    OLD.id,
    'DELETE',
    to_jsonb(jsonb_build_object(
      'batch_number', OLD.batch_number,
      'status',       OLD.status,
      'company_name', OLD.company_name,
      'item_count',   OLD.item_count,
      'total_amount', OLD.total_amount
    ))
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_b2b_batch_delete ON public.sp_b2b_batches;
CREATE TRIGGER trg_audit_b2b_batch_delete
  AFTER DELETE ON public.sp_b2b_batches
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_b2b_batch_delete();
