# B2B Bulk Batch — lifecycle & integrity (v2.9.28)

Operator/developer reference for the changes shipped on 24 Nov 2026. Read this
before deploying the `data-gateway`, `create-b2b-bulk-invoice` or
`xendit-webhook` functions.

## Deploy order (important)

1. Apply `supabase/migrations/20261124120000_b2b_batch_lifecycle.sql`.
2. Deploy `data-gateway`, `create-b2b-bulk-invoice`, `xendit-webhook`.

The migration is additive (`cancelled_at`, `cancelled_by`, `cancel_reason` plus
two indexes). Deploying the gateway before it runs makes cancellation fail with
a missing-column error — it does not corrupt anything, but the action returns
500 until the columns exist.

## New gateway actions

| Action | Who | Purpose |
| --- | --- | --- |
| `b2b_bulk_cancel_batch` | B2B owner | Cancel own batch while `SUBMITTED`. |
| `admin_b2b_bulk_cancel_batch` | Admin | Cancel `SUBMITTED`/`INVOICED`. Blocks `PAID`/`ISSUED`. |
| `admin_b2b_expire_stale_batches` | Admin | Cancels up to 200 `SUBMITTED` batches older than N days (1–30, default 7). Idempotent. |
| `admin_b2b_batch_aging` | Admin | Batch count/amount by age bucket and status. Reports `truncated` past 1,000 rows. |
| `b2b_fleet_renewals` | B2B owner | Units whose cover ends within N days (1–365, default 90), with urgency. |

`b2b_bulk_cancel_batch` deliberately refuses `INVOICED`: that batch has a live
Xendit invoice which only admin can void. Admin cancellation of an `INVOICED`
batch raises `B2B_CANCELLED_WITH_LIVE_INVOICE` for finance.

## Issuance invariants

Both `admin_b2b_bulk_issue` and `insurer_upload_bulk_master_policy` now:

- Build **one policy number per unit** (`<master>-001`, `<master>-002`, …).
  Optional overrides: `unit_policy_numbers` as `{ itemId: number }` or
  `[{ item_id, policy_number }]`. Duplicates (case-insensitive) and control
  characters are rejected — issuance fails with 409 rather than printing the
  same number on several certificates.
- Check `policy_copy_expiry` on every row and **warn, never block**. The copy
  is the client's previous policy kept as supporting evidence; the legal basis
  of the cover being issued is the master policy. Blocking a PAID batch on it
  left already-paid vehicles uninsured over a document ops can chase later.
  Issuance returns `expired_policy_copy_rows` plus a `warning`, writes the row
  numbers to the B2B activity log, and raises `B2B_POLICY_COPY_EXPIRED` for
  admins. Re-uploading a fresh copy remains the client's task.

  (Before 24 Nov 2026 this was a hard 409. That gate was removed on purpose —
  see `docs/B2B_BATCH_LIFECYCLE.md` history in git for the reasoning.)
- Write rows in waves of 25, never a single blanket update.

## Money invariant

`b2b_bulk_create_batch` re-reads the persisted rows (paged, because PostgREST
caps a select at 1,000 rows), sums `total_premium` and compares it with the
header `total_amount`. On mismatch the batch and its rows are deleted and the
request fails with 500 — the client is never sent to an invoice whose amount
does not match the units.

Batch creation is rate-limited to 30 per client per hour.

## Invoice invariant

`create-b2b-bulk-invoice` returns an existing live invoice (`PENDING`/`INVOICED`)
for the batch instead of minting a second one. Two tabs or a retry can no
longer produce two payable bills for one batch.

If the Xendit invoice cannot be recorded (or the batch transition loses a race),
the function raises `B2B_INVOICE_NOT_RECORDED` / `B2B_INVOICE_ORPHANED` and
fails or returns, so finance can reconcile instead of a client paying an
invoice the webhook cannot match.

## Notifications

The client now receives in-app notifications (table `sp_notifications`, keyed
by `sp_users.id`) when their batch is paid (`B2B_BULK_PAID_CLIENT`) and when it
is issued (`B2B_BULK_ISSUED_CLIENT`). Previously only admins were notified.

## Portal wiring

The actions are reachable from the product:

| Screen | Uses |
| --- | --- |
| B2B portal → Orders & Batches → batch detail | `b2b_bulk_cancel_batch` (only while `SUBMITTED`, with an optional reason) |
| B2B portal → Fleet Calendar | `b2b_fleet_renewals(90)` — "Renewal radar" for units inside batches, which have no policy order and therefore never reach `buildRenewalQueue()` |
| CMS → B2B → Bulk Batches | `admin_b2b_batch_aging` panel, `admin_b2b_expire_stale_batches` sweep button, and per-batch `admin_b2b_bulk_cancel_batch` (required reason) |

The sweep stays manual: cancelling client work automatically is an operator
decision, and no cron is configured here.

## Known gaps (not in this release)

- **Automatic sweep.** `admin_b2b_expire_stale_batches` must be scheduled (or
  run manually); no cron is configured here.
- **WhatsApp/e-mail channel.** The Xendit payload still declares WhatsApp
  preferences without a phone/email; notification is in-app only.
- **Claims, team/PIC roles, statement export** remain roadmap items.
