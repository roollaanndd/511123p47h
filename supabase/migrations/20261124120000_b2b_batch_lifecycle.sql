-- ═══════════════════════════════════════════════════════════════════════════
-- B2B bulk batch lifecycle — cancellation + renewal index
--
-- Why: a batch could only move forward (SUBMITTED → INVOICED → PAID →
-- ISSUED). CANCELLED existed in the status CHECK constraint but nothing ever
-- wrote it, so a client who imported the wrong spreadsheet had no way to
-- withdraw it and admin had no way to clear a stale queue. This adds the
-- bookkeeping columns the gateway now writes when a batch is cancelled
-- (actor, timestamp, reason) plus the indexes the stale-batch sweeper and
-- the fleet renewal lookups need.
--
-- Additive and idempotent: no data is rewritten, no policy is relaxed.
-- Apply this migration BEFORE deploying the gateway code that writes these
-- columns (20261124 batch lifecycle release).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.sp_b2b_batches
  ADD COLUMN IF NOT EXISTS cancelled_at  timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by  uuid REFERENCES public.sp_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_reason text;

-- Queue scans: "which batches have been sitting unpaid for N days?" and the
-- hardening index used by the list actions.
CREATE INDEX IF NOT EXISTS idx_sp_b2b_batches_stale
  ON public.sp_b2b_batches (status, created_at)
  WHERE status IN ('SUBMITTED', 'INVOICED');

-- Renewal radar: items whose cover ends inside a window, per client via batch.
CREATE INDEX IF NOT EXISTS idx_sp_b2b_batch_items_coverage_end
  ON public.sp_b2b_batch_items (coverage_end_date)
  WHERE coverage_end_date IS NOT NULL;
