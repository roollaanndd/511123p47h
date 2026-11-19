// ─────────────────────────────────────────────────────────────────────────────
// Direktori bengkel rekanan — tipe, metadata, dan logika filter/sort murni.
//
// File ini sengaja bebas Deno/Supabase: ia dipakai edge function, test Node,
// dan (khusus tipe/meta) frontend. Data mentahnya TIDAK ada di sini — ia
// hidup di data-gateway/data/workshopPartners.ts dan hanya keluar lewat aksi
// gateway yang digerbang peran. Menaruh dataset di bundle frontend akan
// menjadikan daftar kontak bengkel aset statis publik (dan mustahil diperbarui
// tanpa deploy ulang semua portal).
// ─────────────────────────────────────────────────────────────────────────────

export type WorkshopInsurerCode = 'ZURICH' | 'OONA' | 'INTRA_ASIA' | 'MAG';
export type WorkshopInsurerFilter = WorkshopInsurerCode | 'ALL';
export type WorkshopCategoryGroup = 'authorized' | 'umum' | 'other';
export type WorkshopCategoryFilter = WorkshopCategoryGroup | 'all';
export type WorkshopSortBy = 'name' | 'city' | 'province' | 'brand' | 'category' | 'insurer';
export type WorkshopSortDir = 'asc' | 'desc';

export interface WorkshopPartner {
  id: string;
  insurerCode: WorkshopInsurerCode;
  insurerName: string;
  sourceFile: string;
  sourceKind: string;
  sourceRef: string;
  sourceNo: string;
  sourceCategory: string;
  categoryGroup: WorkshopCategoryGroup;
  city: string;
  province: string;
  region: string;
  name: string;
  address: string;
  phone: string;
  email: string;
  contact: string;
  /** Teks kategori apa adanya dari lampiran — dipertahankan, bukan diterjemahkan. */
  brandLabel: string;
  /** Versi brandLabel yang sudah dinormalkan, HANYA untuk sorting. */
  brandKey: string;
}

export interface WorkshopDirectoryQuery {
  insurer: WorkshopInsurerFilter;
  categoryGroup: WorkshopCategoryFilter;
  search: string;
  sortBy: WorkshopSortBy;
  sortDir: WorkshopSortDir;
}

export interface WorkshopFacets {
  total: number;
  insurers: Record<WorkshopInsurerFilter, number>;
  categories: Record<WorkshopCategoryFilter, number>;
}

export const WORKSHOP_INSURERS: ReadonlyArray<{
  code: WorkshopInsurerCode;
  name: string;
  label: string;
}> = [
  { code: 'ZURICH',     name: 'Zurich Insurance',                    label: 'ZURICH' },
  { code: 'OONA',       name: 'OONA Insurance',                      label: 'OONA' },
  { code: 'INTRA_ASIA', name: 'PT Asuransi Intra Asia',              label: 'Intra Asia' },
  { code: 'MAG',        name: 'PT Asuransi Multi Artha Guna Tbk (MAG)', label: 'MAG' },
];

export const WORKSHOP_CATEGORY_LABELS: Record<WorkshopCategoryGroup, string> = {
  authorized: 'Authorized',
  umum: 'Umum',
  other: 'Lainnya',
};

const INSURER_CODES = new Set<string>(WORKSHOP_INSURERS.map(i => i.code));
const GROUP_VALUES = new Set<string>(['authorized', 'umum', 'other']);
const SORT_VALUES = new Set<string>(['name', 'city', 'province', 'brand', 'category', 'insurer']);

/** Urutan kategori untuk sorting: authorized → umum → other (bukan alfabet). */
const GROUP_RANK: Record<WorkshopCategoryGroup, number> = { authorized: 0, umum: 1, other: 2 };
const INSURER_RANK: Record<WorkshopInsurerCode, number> = { ZURICH: 0, OONA: 1, INTRA_ASIA: 2, MAG: 3 };

const collator = new Intl.Collator('id-ID', { sensitivity: 'base', numeric: true });
const MAX_SEARCH = 120;

// Bentuk hasil sengaja satu interface, bukan union `ok: true | false`.
// tsconfig repo ini tidak menyalakan `strict`, sehingga TypeScript TIDAK
// menyempitkan union diskriminan boolean — memakai union di sini membuat
// pemanggil gagal tsc meski logikanya benar (terbukti saat verifikasi).
export interface WorkshopQueryResult {
  ok: boolean;
  error: string;
  query: WorkshopDirectoryQuery;
}

export interface WorkshopPage {
  limit: number;
  offset: number;
}

export interface WorkshopPageResult {
  ok: boolean;
  error: string;
  page: WorkshopPage;
}

const EMPTY_QUERY: WorkshopDirectoryQuery = {
  insurer: 'ALL', categoryGroup: 'all', search: '', sortBy: 'name', sortDir: 'asc',
};

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 2000;

/** Halaman dibatasi supaya satu panggilan tidak menyedot seluruh dataset berulang kali. */
export function normalizeWorkshopPage(raw: Record<string, unknown>): WorkshopPageResult {
  const parse = (value: unknown, fallback: number): number | null => {
    if (value === undefined || value === null || value === '') return fallback;
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) return null;
    const num = Number(text);
    return Number.isSafeInteger(num) ? num : null;
  };
  const limit = parse(raw?.limit, DEFAULT_LIMIT);
  const offset = parse(raw?.offset, 0);
  if (limit === null || limit < 1 || limit > MAX_LIMIT) {
    return { ok: false, error: 'INVALID_LIMIT', page: { limit: DEFAULT_LIMIT, offset: 0 } };
  }
  if (offset === null || offset < 0) {
    return { ok: false, error: 'INVALID_OFFSET', page: { limit: DEFAULT_LIMIT, offset: 0 } };
  }
  return { ok: true, error: '', page: { limit, offset } };
}

/**
 * Validasi parameter di batas kepercayaan. Nilai di luar allowlist ditolak,
 * bukan dibungkam menjadi "semua" — demikian kesalahan klien terlihat dan
 * tidak menyamar sebagai hasil kosong.
 */
export function normalizeWorkshopQuery(raw: Record<string, unknown>): WorkshopQueryResult {
  const pick = (key: string): string | undefined => {
    const value = raw?.[key];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') return undefined;
    return value.trim();
  };

  const insurerRaw = pick('insurer');
  const insurer: WorkshopInsurerFilter = !insurerRaw || insurerRaw === 'ALL'
    ? 'ALL'
    : insurerRaw as WorkshopInsurerFilter;
  const fail = (error: string): WorkshopQueryResult => ({ ok: false, error, query: EMPTY_QUERY });

  if (insurer !== 'ALL' && !INSURER_CODES.has(insurer)) return fail('INVALID_INSURER');

  const categoryRaw = pick('categoryGroup');
  const categoryGroup: WorkshopCategoryFilter = !categoryRaw || categoryRaw === 'all'
    ? 'all'
    : categoryRaw as WorkshopCategoryFilter;
  if (categoryGroup !== 'all' && !GROUP_VALUES.has(categoryGroup)) return fail('INVALID_CATEGORY');

  const search = pick('search') ?? '';
  if (search.length > MAX_SEARCH) return fail('SEARCH_TOO_LONG');

  const sortByRaw = pick('sortBy');
  const sortBy = (sortByRaw ?? 'name') as WorkshopSortBy;
  if (!SORT_VALUES.has(sortBy)) return fail('INVALID_SORT');

  const sortDirRaw = pick('sortDir');
  const sortDir = (sortDirRaw ?? 'asc') as WorkshopSortDir;
  if (sortDir !== 'asc' && sortDir !== 'desc') return fail('INVALID_SORT_DIR');

  return {
    ok: true, error: '',
    query: { insurer, categoryGroup, search, sortBy, sortDir },
  };
}

function searchable(row: WorkshopPartner): string {
  return [
    row.name, row.city, row.province, row.region, row.address, row.brandLabel,
    row.brandKey, row.sourceCategory, row.contact, row.phone, row.email, row.insurerName,
  ].join(' ').toLowerCase();
}

export function filterWorkshopPartners(
  rows: readonly WorkshopPartner[],
  query: WorkshopDirectoryQuery,
): WorkshopPartner[] {
  const tokens = query.search.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => {
    if (query.insurer !== 'ALL' && row.insurerCode !== query.insurer) return false;
    if (query.categoryGroup !== 'all' && row.categoryGroup !== query.categoryGroup) return false;
    if (tokens.length === 0) return true;
    const haystack = searchable(row);
    return tokens.every(token => haystack.includes(token));
  });
}

function primaryValue(row: WorkshopPartner, sortBy: WorkshopSortBy): string | number {
  switch (sortBy) {
    case 'name': return row.name;
    case 'city': return row.city;
    case 'province': return row.province;
    case 'brand': return row.brandKey || row.brandLabel;
    case 'category': return GROUP_RANK[row.categoryGroup] ?? 99;
    case 'insurer': return INSURER_RANK[row.insurerCode] ?? 99;
  }
}

function comparePrimary(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/**
 * Sort yang stabil dan deterministik: kunci utama mengikuti arah pilihan,
 * tie-break selalu naik (nama lalu id) supaya urutan tidak berubah-ubah
 * antara dua permintaan dengan filter yang sama.
 */
export function sortWorkshopPartners(
  rows: readonly WorkshopPartner[],
  query: WorkshopDirectoryQuery,
): WorkshopPartner[] {
  const factor = query.sortDir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const main = comparePrimary(primaryValue(a, query.sortBy), primaryValue(b, query.sortBy));
    if (main !== 0) return main * factor;
    const name = collator.compare(a.name, b.name);
    if (name !== 0) return name;
    return collator.compare(a.id, b.id);
  });
}

/** Facet dihitung dari seluruh data agar label tab tidak berubah saat mencari. */
export function workshopFacets(rows: readonly WorkshopPartner[]): WorkshopFacets {
  const insurers: Record<WorkshopInsurerFilter, number> = {
    ALL: rows.length, ZURICH: 0, OONA: 0, INTRA_ASIA: 0, MAG: 0,
  };
  const categories: Record<WorkshopCategoryFilter, number> = {
    all: rows.length, authorized: 0, umum: 0, other: 0,
  };
  for (const row of rows) {
    insurers[row.insurerCode] += 1;
    categories[row.categoryGroup] += 1;
  }
  return { total: rows.length, insurers, categories };
}
