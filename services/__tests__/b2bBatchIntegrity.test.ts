/**
 * b2bBatchIntegrity.test.ts — money/identity invariants for the B2B bulk batch.
 *
 * Regression tests for four defects found in the batch flow:
 *   1. Issuing a master policy wrote ONE policy number onto every row, so a
 *      253-vehicle fleet had 253 identical certificate numbers.
 *   2. A policy copy valid at submission could expire before issuance and
 *      still be used to issue — now surfaced as a warning, never a silent
 *      pass and never a hard block on a batch the client already paid for.
 *   3. The batch header total was never reconciled against the rows actually
 *      persisted.
 *   4. Batch creation had no rate limit, batches could not be cancelled, and
 *      every "Pay" click minted a second live Xendit invoice for one batch.
 *
 * The first three are covered as behaviour against the pure module. The last
 * one is a wiring contract, so it is locked at the source level (the gateway
 * needs Deno + Supabase to execute).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH_ROWS,
  MAX_POLICY_NUMBER_LENGTH,
  buildUnitPolicyNumbers,
  describeExpiredPolicyCopies,
  expiredPolicyCopyRowIds,
  normalizePolicyNumber,
  reconcileBatchTotal,
} from '../../supabase/functions/_shared/b2bBatchIntegrity.ts';

const ROWS = [
  { id: 'item-a', rowNo: 1, policyCopyExpiry: '2027-01-01' },
  { id: 'item-b', rowNo: 2, policyCopyExpiry: '2027-01-01' },
  { id: 'item-c', rowNo: 3, policyCopyExpiry: '2027-01-01' },
];

describe('per-unit policy numbers', () => {
  it('gives every row its own deterministic number', () => {
    const result = buildUnitPolicyNumbers('POL-2026', ROWS);
    expect(result.error).toBeUndefined();
    expect(result.assignments).toEqual([
      { itemId: 'item-a', rowNo: 1, policyNumber: 'POL-2026-001' },
      { itemId: 'item-b', rowNo: 2, policyNumber: 'POL-2026-002' },
      { itemId: 'item-c', rowNo: 3, policyNumber: 'POL-2026-003' },
    ]);
    expect(new Set(result.assignments.map((a) => a.policyNumber)).size).toBe(3);
  });

  it('honours an explicit admin override and keeps generation for the rest', () => {
    const result = buildUnitPolicyNumbers('POL-2026', ROWS, { 'item-b': 'MANUAL/99' });
    expect(result.assignments.map((a) => a.policyNumber)).toEqual([
      'POL-2026-001',
      'MANUAL/99',
      'POL-2026-003',
    ]);
  });

  it('rejects duplicate numbers in any casing', () => {
    const result = buildUnitPolicyNumbers('POL-2026', ROWS, { 'item-a': 'SAMA', 'item-b': 'sama' });
    expect(result.assignments).toEqual([]);
    expect(result.error).toMatch(/dipakai lebih dari sekali/);
  });

  it('rejects an invalid override instead of silently renumbering', () => {
    const result = buildUnitPolicyNumbers('POL-2026', ROWS, { 'item-a': '   ' });
    expect(result.error).toMatch(/baris 1/);
  });

  it('keeps generated numbers within the 64-character column limit', () => {
    const result = buildUnitPolicyNumbers('X'.repeat(MAX_POLICY_NUMBER_LENGTH), ROWS);
    expect(result.assignments).toHaveLength(3);
    for (const a of result.assignments) {
      expect(a.policyNumber.length).toBeLessThanOrEqual(MAX_POLICY_NUMBER_LENGTH);
    }
    expect(new Set(result.assignments.map((a) => a.policyNumber)).size).toBe(3);
  });

  it('rejects an over-long master number instead of silently truncating it', () => {
    const result = buildUnitPolicyNumbers('X'.repeat(MAX_POLICY_NUMBER_LENGTH + 1), ROWS);
    expect(result.assignments).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it('refuses an empty master number', () => {
    expect(buildUnitPolicyNumbers('   ', ROWS).error).toBeTruthy();
  });

  it('case-insensitive uniqueness survives identical row_no values', () => {
    const rows = [{ id: 'a', rowNo: 7 }, { id: 'b', rowNo: 7 }];
    const result = buildUnitPolicyNumbers('POL-1', rows);
    expect(result.assignments.map((a) => a.policyNumber)).toEqual(['POL-1-001', 'POL-1-002']);
  });

  it('normalizes whitespace and rejects control characters', () => {
    expect(normalizePolicyNumber('  POL   123  ')).toBe('POL 123');
    expect(normalizePolicyNumber('POL\u0000123')).toBeNull();
    expect(normalizePolicyNumber(null)).toBeNull();
  });
});

describe('policy copy expiry at issuance', () => {
  it('flags only copies that expired before today', () => {
    const rows = [
      { id: 'a', rowNo: 1, policyCopyExpiry: '2026-11-23' },
      { id: 'b', rowNo: 2, policyCopyExpiry: '2026-11-24' },
      { id: 'c', rowNo: 3, policyCopyExpiry: null },
      { id: 'd', rowNo: 4 },
    ];
    expect(expiredPolicyCopyRowIds(rows, '2026-11-24')).toEqual(['a']);
  });

  it('ignores malformed dates rather than blocking issuance on them', () => {
    expect(expiredPolicyCopyRowIds([{ id: 'a', rowNo: 1, policyCopyExpiry: '24-11-2026' }], '2026-11-24')).toEqual([]);
  });

  it('warns instead of hard-blocking, and says issuance continues', () => {
    const warning = describeExpiredPolicyCopies([3, 9]);
    expect(warning).toContain('baris 3, 9');
    expect(warning).toMatch(/tetap dilanjutkan/);
    expect(describeExpiredPolicyCopies([])).toBeNull();
    expect(describeExpiredPolicyCopies([1, 2, 3], 2)).toContain('…');
  });
});

describe('batch total reconciliation', () => {
  it('balances when the header equals the persisted rows', () => {
    expect(reconcileBatchTotal(300.75, ['100.50', 200.25])).toEqual({
      balanced: true,
      expected: 300.75,
      difference: 0,
    });
  });

  it('flags a missing row', () => {
    const result = reconcileBatchTotal(300, [100, 100]);
    expect(result.balanced).toBe(false);
    expect(result.difference).toBe(100);
  });

  it('tolerates sub-rupiah float drift but not a real discrepancy', () => {
    expect(reconcileBatchTotal(0.3, [0.1, 0.2]).balanced).toBe(true);
    expect(reconcileBatchTotal(1001, [1000]).balanced).toBe(false);
  });

  it('caps rows per batch', () => {
    expect(MAX_BATCH_ROWS).toBe(2000);
  });
});

describe('gateway wiring contracts', () => {
  const root = process.cwd();
  const bulk = readFileSync(join(root, 'supabase/functions/data-gateway/actions/b2bBulk.ts'), 'utf8');
  const invoice = readFileSync(join(root, 'supabase/functions/create-b2b-bulk-invoice/index.ts'), 'utf8');
  const webhook = readFileSync(join(root, 'supabase/functions/xendit-webhook/index.ts'), 'utf8');

  it('rate-limits batch creation per client', () => {
    expect(bulk).toContain('checkRateLimit(`b2b:${clientId}`, 30)');
    expect(bulk).toContain('429');
  });

  it('issues per-unit numbers through the shared helper, not one blanket update', () => {
    expect(bulk).toContain('resolveUnitPolicyNumbers(');
    expect(bulk).toContain('applyUnitPolicyNumbers(');
    expect(bulk).not.toContain("policy_number: policyNumber, updated_at: ts }).eq('batch_id', batchId)");
  });

  it('reports an expired policy copy at issuance without blocking it', () => {
    expect(bulk).toContain('expiredPolicyCopyRowIds(');
    expect(bulk).toContain('describeExpiredPolicyCopies(');
    expect(bulk).toContain('expired_policy_copy_rows');
    // The old gate: "Klien harus mengunggah ulang copy polis sebelum penerbitan."
    expect(bulk).not.toContain('sebelum penerbitan');
  });

  it('reconciles the persisted header total against persisted rows', () => {
    expect(bulk).toContain('reconcileBatchTotal(');
    expect(bulk).toContain(".select('total_premium')");
  });

  it('exposes client cancel, admin cancel, stale sweep, aging and renewals', () => {
    for (const action of [
      'b2b_bulk_cancel_batch',
      'admin_b2b_bulk_cancel_batch',
      'admin_b2b_expire_stale_batches',
      'admin_b2b_batch_aging',
      'b2b_fleet_renewals',
    ]) {
      expect(bulk).toContain(`case '${action}'`);
    }
  });

  it('reuses a live invoice instead of minting a second one', () => {
    expect(invoice).toContain(".in('status', ['PENDING', 'INVOICED'])");
    expect(invoice).toContain('reused: true');
    expect(invoice).toContain(".eq('status', 'SUBMITTED')\n      .select('id')");
  });

  it('notifies the client in-app when their batch is paid online', () => {
    expect(webhook).toContain('agent_id: batch.client_id');
    expect(webhook).toContain("type:     'B2B_BULK_PAID_CLIENT'");
  });
});

describe('portal wiring contracts', () => {
  const root = process.cwd();
  const batchScreen = readFileSync(join(root, 'components/b2b/B2BBulkBatches.tsx'), 'utf8');
  const fleetCalendar = readFileSync(join(root, 'components/b2b/B2BFleetCalendar.tsx'), 'utf8');
  const adminView = readFileSync(join(root, 'components/admin/B2BAdminView.tsx'), 'utf8');

  it('lets a client cancel an un-invoiced batch from the batch detail', () => {
    expect(batchScreen).toContain('cancelMyB2BBatch(');
    // INVOICED is admin-only (a live Xendit invoice exists): the client screen
    // offers the action only while the batch is still SUBMITTED.
    expect(batchScreen).toContain("batch.status === 'SUBMITTED' && !allClients");
    expect(batchScreen.match(/cancelMyB2BBatch\(/g)).toHaveLength(1);
  });

  it('renders the batch-unit renewal radar on the fleet calendar', () => {
    expect(fleetCalendar).toContain('getMyB2BFleetRenewals(');
    expect(fleetCalendar).toContain('RENEWAL_TONE');
  });

  it('wires admin cancel, stale sweep and aging into the bulk tab', () => {
    expect(adminView).toContain('adminCancelB2BBatch(');
    expect(adminView).toContain('adminExpireStaleB2BBatches(');
    expect(adminView).toContain('adminGetB2BBatchAging(');
    expect(adminView).toContain('<BulkOpsPanel');
  });
});
