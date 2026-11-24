// b2bBatchIntegrity.ts — pure integrity helpers for B2B bulk batches.
//
// These live in _shared (not in the gateway action file) so they can be unit
// tested without Deno or a database. They encode three invariants the batch
// flow needs:
//
//   1. A master policy number is NOT a unit policy number. Issuing one
//      certificate number onto every row of a 253-vehicle batch makes each
//      vehicle's policy indistinguishable from the others (claims, renewals
//      and police checks all reference the number in the document). Each row
//      gets its own deterministic number, with an optional admin override.
//   2. A policy copy that has expired between submission and issuance is a
//      stale supporting document. It is ADVISORY at issuance, not a gate:
//      the copy is evidence of the client's previous cover, not the cover
//      being issued, so refusing to issue a PAID batch would leave vehicles
//      already paid for uninsured. The stale rows are reported so ops can ask
//      the client to re-upload (see describeExpiredPolicyCopies).
//   3. The aggregate money on the header must equal the sum of the rows that
//      were actually persisted — never the numbers the client sent.

export const MAX_BATCH_ROWS = 2000;
export const MAX_POLICY_NUMBER_LENGTH = 64;

const MAX_MASTER_BASE_LENGTH = MAX_POLICY_NUMBER_LENGTH - 4; // "-001"

export interface PolicyNumberRow {
  id: string;
  rowNo: number;
  policyCopyExpiry?: string | null;
  vehicleClass?: string | null;
}

export interface UnitPolicyAssignment {
  itemId: string;
  rowNo: number;
  policyNumber: string;
}

export interface BuildPolicyNumbersResult {
  assignments: UnitPolicyAssignment[];
  error?: string;
}

/**
 * Trim, collapse internal whitespace and validate a policy number.
 * Returns null when the value is empty/too long or contains characters that
 * do not belong in a printed certificate number.
 */
export function normalizePolicyNumber(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  if (raw.length > MAX_POLICY_NUMBER_LENGTH) return null;
  // Reject control characters (which end up in the certificate PDF) but keep
  // the full printable range: real insurer formats include '+', '#', ':' and
  // non-ASCII prefixes, and blocking those would reject valid legacy numbers.
  if (/[\u0000-\u001F\u007F]/.test(raw)) return null;
  return raw;
}

/**
 * Build one policy number per batch row.
 *
 * Generated numbers are `<master>-<NNN>` using the row's position in the
 * batch (already ordered by row_no), so the mapping is stable and cannot
 * collide even when two rows share the same row_no. An override map
 * (itemId -> policy number) wins over the generated value.
 *
 * Returns { assignments: [], error } when the input cannot produce a unique,
 * valid set — callers must not fall back to writing one number everywhere.
 */
export function buildUnitPolicyNumbers(
  masterPolicyNumber: string,
  rows: PolicyNumberRow[],
  overrides: Record<string, string> = {},
): BuildPolicyNumbersResult {
  const master = normalizePolicyNumber(masterPolicyNumber);
  if (!master) {
    return { assignments: [], error: 'Nomor polis induk tidak valid (kosong, terlalu panjang, atau memuat karakter terlarang).' };
  }
  if (rows.length === 0) {
    return { assignments: [], error: 'Batch tidak memiliki unit untuk diterbitkan.' };
  }
  if (rows.length > MAX_BATCH_ROWS) {
    return { assignments: [], error: `Batch melebihi ${MAX_BATCH_ROWS} unit.` };
  }

  const base = master.slice(0, MAX_MASTER_BASE_LENGTH).replace(/[ -./_]+$/, '') || 'POLIS';
  const assignments: UnitPolicyAssignment[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const override = overrides[row.id];
    let policyNumber: string;
    if (override !== undefined) {
      const normalized = normalizePolicyNumber(override);
      if (!normalized) {
        return { assignments: [], error: `Nomor polis untuk baris ${row.rowNo} tidak valid.` };
      }
      policyNumber = normalized;
    } else {
      policyNumber = `${base}-${String(i + 1).padStart(3, '0')}`;
    }

    const key = policyNumber.toUpperCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      return {
        assignments: [],
        error: `Nomor polis ${policyNumber} dipakai lebih dari sekali (baris ${previous} dan ${row.rowNo}).`,
      };
    }
    seen.set(key, row.rowNo);
    assignments.push({ itemId: row.id, rowNo: row.rowNo, policyNumber });
  }

  return { assignments };
}

/**
 * Row ids whose policy copy expires before `todayIso` (YYYY-MM-DD).
 * A copy valid through today is still valid — the same boundary the
 * submission path uses. Rows without an expiry are not flagged.
 */
export function expiredPolicyCopyRowIds(rows: PolicyNumberRow[], todayIso: string): string[] {
  const today = String(todayIso).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return [];
  return rows
    .filter((r) => {
      const expiry = typeof r.policyCopyExpiry === 'string' ? r.policyCopyExpiry.slice(0, 10) : null;
      if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return false;
      return expiry < today;
    })
    .map((r) => r.id);
}

/**
 * Human-readable warning for rows whose policy copy expired before issuance.
 * Returns null when there is nothing to warn about. Issuance proceeds — the
 * wording must make clear that the batch is NOT blocked.
 */
export function describeExpiredPolicyCopies(rowNos: number[], maxListed = 10): string | null {
  const rows = (Array.isArray(rowNos) ? rowNos : [])
    .filter((n): n is number => Number.isFinite(n))
    .map((n) => Number(n));
  if (rows.length === 0) return null;
  const listed = rows.slice(0, maxListed).join(', ');
  const more = rows.length > maxListed ? ', …' : '';
  return `Copy polis sudah kedaluwarsa untuk baris ${listed}${more}. Penerbitan tetap dilanjutkan; minta klien mengunggah ulang copy polis terbaru.`;
}

/**
 * Compare the batch header total against the rows that were persisted.
 * Money is numeric in Postgres, so a sub-rupiah float drift is expected;
 * half a rupiah of tolerance is far below any real pricing error while
 * still catching a missing or duplicated row.
 */
export function reconcileBatchTotal(
  batchTotal: number,
  itemTotals: Array<number | string>,
): { balanced: boolean; expected: number; difference: number } {
  const expected = itemTotals.reduce<number>((sum, value) => {
    const n = Number(value);
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);
  const actual = Number.isFinite(batchTotal) ? batchTotal : 0;
  const difference = actual - expected;
  return { balanced: Math.abs(difference) <= 0.5, expected, difference };
}
