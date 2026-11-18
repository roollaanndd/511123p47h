// b2bBulkTemplate — Template Excel untuk impor massal armada (v2.9.12).
//
// Sebelumnya klien harus menebak format kolom (parser memang fuzzy, tapi
// tetap menebak). Template ini memakai LABEL kolom yang PERSIS sama dengan
// FIELD_LABELS parser, jadi auto-map menemukan semuanya 1:1 tanpa pemetaan
// manual. Murni pembuatan file — tidak ada logika premi di sini.

import * as XLSX from 'xlsx';
import { FIELD_LABELS } from './b2bBulkParser';

type TemplateField = keyof typeof FIELD_LABELS;

// Urutan kolom: identitas nasabah dulu, kontrak, angka, lalu kendaraan,
// lalu kolom referensi (zona/premi dari file lama) di paling kanan.
const TEMPLATE_ORDER: TemplateField[] = [
  'nasabahName', 'nasabahKtp', 'nasabahPhone', 'nasabahAddress',
  'contractNo', 'contractDate', 'tenorMonths', 'financingValue',
  'jenisBrg', 'make', 'typeName', 'modelYear', 'otr',
  'plateNo', 'chassisNo', 'engineNo', 'bpkbNo',
  'regionText', 'referenceZone', 'referenceTotalPremium',
];

// Dua baris contoh (dihapus pengguna saat mengisi). jenisBrg memakai label
// yang sama dengan pilihan kelas di layar tinjau: MOTOR / MOBIL / ALAT BERAT.
const EXAMPLE_ROWS: unknown[][] = [
  [
    'Budi Santoso', '3175012345670001', '081234567890', 'Jl. Contoh No. 1, Jakarta',
    'KTR-2026-001', '2026-01-10', 12, 45000000,
    'MOTOR', 'Honda', 'Beat 110', 2024, 19500000,
    'B 1234 XYZ', 'MHKAB1234A567890', 'GC1EA1234A5678', 'BPKB-001',
    'Jakarta', 1, null,
  ],
  [
    'PT Contoh Sejahtera', '3175019876540002', '082198765432', 'Jl. Contoh No. 2, Bandung',
    'KTR-2026-002', '2026-01-15', 24, 150000000,
    'MOBIL', 'Toyota', 'Avanza 1.5', 2023, 245000000,
    'B 5678 DEF', 'MHKCD5678B901234', '1NZFE5678B9012', 'BPKB-002',
    'Bandung', 2, null,
  ],
];

const COLUMN_WIDTHS: Array<{ wch: number }> = TEMPLATE_ORDER.map(f => {
  switch (f) {
    case 'nasabahAddress': return { wch: 32 };
    case 'nasabahName': case 'typeName': case 'regionText': return { wch: 22 };
    case 'financingValue': case 'otr': case 'referenceTotalPremium': return { wch: 18 };
    case 'chassisNo': case 'engineNo': return { wch: 20 };
    default: return { wch: 16 };
  }
});

export const BULK_TEMPLATE_FILENAME = 'Template_Impor_Massal_SurePath.xlsx';

export function buildBulkTemplateWorkbook(): XLSX.WorkBook {
  const headers = TEMPLATE_ORDER.map(f => FIELD_LABELS[f]);
  const rows = [headers, ...EXAMPLE_ROWS];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = COLUMN_WIDTHS;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  return wb;
}

export function downloadBulkTemplate(): void {
  XLSX.writeFile(buildBulkTemplateWorkbook(), BULK_TEMPLATE_FILENAME);
}
