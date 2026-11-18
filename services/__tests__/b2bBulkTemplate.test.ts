// Contract tests for the official B2B bulk import Excel template (v2.9.12).
//
// The template's ONLY job is to eliminate guesswork: its header row must use
// the parser's own FIELD_LABELS verbatim, so autoMapColumns resolves every
// column 1:1 and the client never has to map anything manually. If someone
// edits a label in the parser (or the template) out of sync, upload UX
// silently degrades — these tests pin the sync.

import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { FIELD_LABELS, REQUIRED_FIELDS, autoMapColumns } from '../b2bBulkParser';
import { buildBulkTemplateWorkbook, BULK_TEMPLATE_FILENAME } from '../b2bBulkTemplate';

const readTemplate = (): { headers: string[]; rows: unknown[][] } => {
  const wb = buildBulkTemplateWorkbook();
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const all = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
  return { headers: all[0].map(h => String(h ?? '')), rows: all.slice(1) };
};

describe('B2B bulk Excel template', () => {
  it('has a header row using the parser FIELD_LABELS verbatim', () => {
    const { headers } = readTemplate();
    const labels = Object.values(FIELD_LABELS);
    for (const label of labels) {
      expect(headers, `header "${label}" missing`).toContain(label);
    }
    expect(headers).toHaveLength(labels.length);
  });

  it('auto-maps every field 1:1 from the template headers alone', () => {
    const { headers } = readTemplate();
    const mapping = autoMapColumns(headers);
    for (const [field, col] of Object.entries(mapping)) {
      expect(col, `field ${field} should map from template headers`).not.toBeNull();
    }
  });

  it('covers every REQUIRED field with a value in at least one example row', () => {
    const { headers, rows } = readTemplate();
    for (const field of REQUIRED_FIELDS) {
      const label = FIELD_LABELS[field];
      const col = headers.indexOf(label);
      expect(col).toBeGreaterThanOrEqual(0);
      const filled = rows.some(row => row[col] !== null && row[col] !== undefined && row[col] !== '');
      expect(filled, `required field ${field} (${label}) must be filled in an example row`).toBe(true);
    }
  });

  it('ships example rows for the client to overwrite (not an empty grid)', () => {
    const { rows } = readTemplate();
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('uses a stable, Indonesian file name', () => {
    expect(BULK_TEMPLATE_FILENAME).toBe('Template_Impor_Massal_SurePath.xlsx');
  });
});
