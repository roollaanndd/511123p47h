// Direktori bengkel rekanan (ZURICH, OONA, Intra Asia, MAG).
//
// Tiga hal yang diuji di sini:
//   1. Integritas data lampiran — angka, kategori, dan penomoran tidak boleh
//      berubah diam-diam saat parser atau lampiran diperbarui.
//   2. Filter/sort murni — sorting kota, brand, dan kategori adalah syarat
//      produk, dan kategori MAG Authorized vs Umum tidak boleh melebur.
//   3. Gerbang aksi — data ini bukan aset statis publik di bundle. Pembacanya
//      harus lolos allowlist peran eksplisit, BUKAN `caller.isAdmin`.
import { describe, expect, it, vi } from 'vitest';
import {
  filterWorkshopPartners,
  normalizeWorkshopQuery,
  sortWorkshopPartners,
  workshopFacets,
  type WorkshopPartner,
} from '../../supabase/functions/_shared/workshopDirectory.ts';
import { WORKSHOP_PARTNERS } from '../../supabase/functions/data-gateway/data/workshopPartners.ts';
import {
  WORKSHOP_DIRECTORY_ACTION,
  WORKSHOP_DIRECTORY_ROLES,
  handleWorkshopPartnersAction,
} from '../../supabase/functions/data-gateway/actions/workshopPartners.ts';

type Row = Record<string, unknown>;

const count = (rows: readonly WorkshopPartner[], key: keyof WorkshopPartner, value: string) =>
  rows.filter(r => String(r[key]) === value).length;

function makeCtx(role: string | null, params: Row = {}, opts: { rateLimit?: boolean } = {}) {
  const ctx = {
    db: {},
    params,
    caller: {
      authId: 'caller-auth',
      email: `${(role ?? 'anon').toLowerCase()}@surepath.id`,
      spUser: role ? { id: 'caller-1', role } : null,
      role,
      // Sengaja true: kalau aksi ini pernah digerbang isAdmin, tes penolakan
      // di bawah akan gagal.
      isAdmin: true,
      isCoreAdmin: role === 'MASTER_ADMIN' || role === 'ADMIN',
      isRateAdmin: false,
      isFinanceAdmin: false,
      userMetadata: null,
      ownerId: 'caller-1',
      ownerIds: ['caller-1'],
      emailConfirmedAt: null,
    },
    reqIp: null,
    reqUserAgent: null,
    sendTelegram: vi.fn(),
    logActivity: vi.fn(),
    checkRateLimit: vi.fn(async () => opts.rateLimit ?? true),
    RESEND_KEY: '',
  };
  return ctx as never;
}

const sample = (over: Partial<WorkshopPartner>): WorkshopPartner => ({
  id: 'x', insurerCode: 'MAG', insurerName: 'MAG', sourceFile: 'x', sourceKind: 'x',
  sourceRef: 'x', sourceNo: '1', sourceCategory: 'x', categoryGroup: 'umum',
  city: 'Bandung', province: 'Jawa Barat', region: '', name: 'Bengkel A',
  address: 'Jl. A', phone: '', email: '', contact: '', brandLabel: 'Toyota',
  brandKey: 'toyota', ...over,
});

describe('integritas dataset direktori bengkel', () => {
  it('memuat seluruh 1982 baris dari lima lampiran', () => {
    expect(WORKSHOP_PARTNERS).toHaveLength(1982);
    expect(count(WORKSHOP_PARTNERS, 'insurerCode', 'ZURICH')).toBe(497);
    expect(count(WORKSHOP_PARTNERS, 'insurerCode', 'OONA')).toBe(692);
    expect(count(WORKSHOP_PARTNERS, 'insurerCode', 'INTRA_ASIA')).toBe(108);
    expect(count(WORKSHOP_PARTNERS, 'insurerCode', 'MAG')).toBe(685);
  });

  it('mempertahankan pembagian kategori tiap asuransi', () => {
    const by = (insurer: string, group: string) =>
      WORKSHOP_PARTNERS.filter(r => r.insurerCode === insurer && r.categoryGroup === group);
    expect(by('ZURICH', 'authorized')).toHaveLength(338);
    expect(by('ZURICH', 'umum')).toHaveLength(91);
    expect(by('ZURICH', 'other')).toHaveLength(68);
    expect(by('OONA', 'authorized')).toHaveLength(459);
    expect(by('OONA', 'umum')).toHaveLength(233);
    expect(by('INTRA_ASIA', 'umum')).toHaveLength(108);
    expect(by('MAG', 'authorized')).toHaveLength(353);
    expect(by('MAG', 'umum')).toHaveLength(332);
  });

  it('id unik, nama/kota/brandKey terisi', () => {
    expect(new Set(WORKSHOP_PARTNERS.map(r => r.id)).size).toBe(WORKSHOP_PARTNERS.length);
    for (const row of WORKSHOP_PARTNERS) {
      expect(row.name, row.id).toBeTruthy();
      expect(row.city, row.id).toBeTruthy();
      expect(typeof row.brandKey, row.id).toBe('string');
    }
  });

  it('penomoran OONA dan MAG lengkap tanpa lubang atau duplikat', () => {
    for (const kind of ['sheet:Sheet1', 'pdf:authorized', 'pdf:umum']) {
      const numbers = WORKSHOP_PARTNERS
        .filter(r => r.sourceKind === kind)
        .map(r => Number(r.sourceNo));
      expect(numbers.length, kind).toBeGreaterThan(0);
      expect(new Set(numbers).size, kind).toBe(numbers.length);
      expect(Math.min(...numbers), kind).toBe(1);
      expect(Math.max(...numbers), kind).toBe(numbers.length);
    }
  });

  it('MAG Authorized dan MAG Umum tetap dua kumpulan terpisah', () => {
    const auth = WORKSHOP_PARTNERS.filter(r => r.sourceKind === 'pdf:authorized');
    const umum = WORKSHOP_PARTNERS.filter(r => r.sourceKind === 'pdf:umum');
    const authIds = new Set(auth.map(r => r.id));
    expect(umum.every(r => !authIds.has(r.id))).toBe(true);
    expect(auth.find(r => r.sourceNo === '100')?.province).toBe('DKI Jakarta');
    expect(auth.find(r => r.sourceNo === '100')?.city).toBe('JAKARTA TIMUR');
    expect(umum.find(r => r.sourceNo === '100')?.province).toBe('Jawa Barat');
  });

  it('kategori sumber OONA dipetakan konsisten', () => {
    const dealer = WORKSHOP_PARTNERS.find(r => r.sourceKind === 'sheet:Sheet1' && r.sourceNo === '49');
    const panel = WORKSHOP_PARTNERS.find(r => r.sourceKind === 'sheet:Sheet1' && r.sourceNo === '47');
    expect(dealer?.sourceCategory).toBe('Dealer');
    expect(dealer?.categoryGroup).toBe('authorized');
    expect(panel?.sourceCategory).toBe('OONA Panel');
    expect(panel?.categoryGroup).toBe('umum');
  });
});

describe('normalizeWorkshopQuery', () => {
  it('memakai nilai bawaan ketika parameter kosong', () => {
    const result = normalizeWorkshopQuery({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.query).toEqual({
        insurer: 'ALL', categoryGroup: 'all', search: '', sortBy: 'name', sortDir: 'asc',
      });
    }
  });

  it('menerima nilai yang sah dan memangkas spasi pencarian', () => {
    const result = normalizeWorkshopQuery({
      insurer: 'MAG', categoryGroup: 'authorized', search: '  Toyota Bandung  ',
      sortBy: 'city', sortDir: 'desc',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.query.search).toBe('Toyota Bandung');
  });

  it('menolak nilai di luar allowlist dan pencarian berlebih', () => {
    expect(normalizeWorkshopQuery({ insurer: 'ALL; DROP TABLE' }).ok).toBe(false);
    expect(normalizeWorkshopQuery({ categoryGroup: 'rahasia' }).ok).toBe(false);
    expect(normalizeWorkshopQuery({ sortBy: 'sourceFile' }).ok).toBe(false);
    expect(normalizeWorkshopQuery({ sortDir: 'sideways' }).ok).toBe(false);
    expect(normalizeWorkshopQuery({ search: 'a'.repeat(121) }).ok).toBe(false);
  });
});

describe('filter dan sort direktori', () => {
  it('filter asuransi, kategori, dan teks bekerja bersama', () => {
    const query = normalizeWorkshopQuery({
      insurer: 'MAG', categoryGroup: 'authorized', search: 'toyota',
    });
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    const rows = filterWorkshopPartners(WORKSHOP_PARTNERS, query.query);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.insurerCode === 'MAG' && r.categoryGroup === 'authorized')).toBe(true);
    expect(rows.every(r => JSON.stringify(r).toLowerCase().includes('toyota'))).toBe(true);
  });

  it('mengurutkan kota, brand, dan kategori secara deterministik tanpa mengubah input', () => {
    const rows = [
      sample({ id: 'b', city: 'Surabaya', brandKey: 'honda', categoryGroup: 'umum', name: 'Bengkel B' }),
      sample({ id: 'a', city: 'Bandung', brandKey: 'toyota', categoryGroup: 'authorized', name: 'Bengkel A' }),
      sample({ id: 'c', city: 'Jakarta', brandKey: 'daihatsu', categoryGroup: 'other', name: 'Bengkel C' }),
    ];
    const input = [...rows];

    const byCity = sortWorkshopPartners(rows, {
      insurer: 'ALL', categoryGroup: 'all', search: '', sortBy: 'city', sortDir: 'asc',
    });
    expect(byCity.map(r => r.id)).toEqual(['a', 'c', 'b']);

    const byBrand = sortWorkshopPartners(rows, {
      insurer: 'ALL', categoryGroup: 'all', search: '', sortBy: 'brand', sortDir: 'asc',
    });
    expect(byBrand.map(r => r.id)).toEqual(['c', 'b', 'a']);

    // Urutan kategori: authorized → umum → other (bukan alfabet).
    const byCategory = sortWorkshopPartners(rows, {
      insurer: 'ALL', categoryGroup: 'all', search: '', sortBy: 'category', sortDir: 'asc',
    });
    expect(byCategory.map(r => r.id)).toEqual(['a', 'b', 'c']);

    const desc = sortWorkshopPartners(rows, {
      insurer: 'ALL', categoryGroup: 'all', search: '', sortBy: 'city', sortDir: 'desc',
    });
    expect(desc.map(r => r.id)).toEqual(['b', 'c', 'a']);
    expect(rows).toEqual(input);
  });

  it('menghitung facet dari seluruh data, bukan hasil filter', () => {
    const facets = workshopFacets(WORKSHOP_PARTNERS);
    expect(facets.total).toBe(1982);
    expect(facets.insurers.ALL).toBe(1982);
    expect(facets.insurers.MAG).toBe(685);
    expect(facets.categories.all).toBe(1982);
    expect(facets.categories.authorized).toBe(338 + 459 + 353);
  });
});

describe('list_workshop_partners — gerbang aksi', () => {
  it('hanya memproses aksi yang dikenal', async () => {
    const res = await handleWorkshopPartnersAction('admin_list_users', makeCtx('MASTER_ADMIN'));
    expect(res).toBeNull();
  });

  it('mengizinkan peran dalam allowlist eksplisit', async () => {
    for (const role of WORKSHOP_DIRECTORY_ROLES) {
      const res = await handleWorkshopPartnersAction(WORKSHOP_DIRECTORY_ACTION, makeCtx(role));
      expect(res?.status, role).toBe(200);
      const body = res?.body as { data: { rows: WorkshopPartner[]; total: number; facets: Row } };
      expect(body.data.total).toBe(1982);
      expect(body.data.rows).toHaveLength(1982);
      expect(body.data.facets).toBeTruthy();
    }
  });

  it('menolak peran lain meski isAdmin bernilai true', async () => {
    for (const role of ['OPERATOR', 'FINANCE', 'FINANCE_MANAGER', 'FINANCE_DIRECTOR', 'AGENT', 'CUSTOMER', 'INSURER_ADMIN', 'LAIN']) {
      const res = await handleWorkshopPartnersAction(WORKSHOP_DIRECTORY_ACTION, makeCtx(role));
      expect(res?.status, role).toBe(403);
    }
    expect((await handleWorkshopPartnersAction(WORKSHOP_DIRECTORY_ACTION, makeCtx(null)))?.status).toBe(403);
  });

  it('mengirim baris hasil filter dan sort sesuai parameter', async () => {
    const res = await handleWorkshopPartnersAction(WORKSHOP_DIRECTORY_ACTION, makeCtx('B2B_CLIENT', {
      insurer: 'MAG', categoryGroup: 'umum', sortBy: 'city', sortDir: 'desc', limit: 3,
    }));
    expect(res?.status).toBe(200);
    const body = res?.body as {
      data: {
        rows: WorkshopPartner[];
        total: number;
        categoryCounts: Record<string, number>;
      };
    };
    expect(body.data.total).toBe(332);
    // Jumlah chip dihitung per asuransi, sebelum filter kategori diterapkan —
    // supaya pengguna bisa melihat berapa yang tersedia di chip lain.
    expect(body.data.categoryCounts.umum).toBe(332);
    expect(body.data.categoryCounts.authorized).toBe(353);
    expect(body.data.rows).toHaveLength(3);
    expect(body.data.rows.every(r => r.insurerCode === 'MAG' && r.categoryGroup === 'umum')).toBe(true);
    const cities = body.data.rows.map(r => r.city);
    expect([...cities].sort().reverse()).toEqual(cities);
  });

  it('menolak parameter invalid dengan 400', async () => {
    const res = await handleWorkshopPartnersAction(WORKSHOP_DIRECTORY_ACTION, makeCtx('ADMIN', { insurer: 'RAHASIA' }));
    expect(res?.status).toBe(400);
  });

  it('menggagal tertutup saat kuota habis', async () => {
    const res = await handleWorkshopPartnersAction(WORKSHOP_DIRECTORY_ACTION, makeCtx('ADMIN', {}, { rateLimit: false }));
    expect(res?.status).toBe(429);
  });
});
