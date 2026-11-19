// direktori bengkel rekanan — satu aksi baca, digerbang eksplisit.
//
// Datasetnya modul statis di edge function (bukan tabel baru, bukan aset di
// bundle frontend). Itu berarti tidak ada RLS untuk diandalkan: satu-satunya
// pengaman adalah allowlist peran di sini. Sengaja TIDAK memakai
// `caller.isAdmin` — OPERATOR/FINANCE juga bernilai isAdmin di index.ts, dan
// audit 2026-10-23 sudah menunjukkan apa yang terjadi kalau gerbangnya
// ditinggalkan ke flag itu.
import type { GatewayContext, ActionResult } from './types.ts';
import { WORKSHOP_PARTNERS } from '../data/workshopPartners.ts';
import {
  filterWorkshopPartners,
  normalizeWorkshopPage,
  normalizeWorkshopQuery,
  sortWorkshopPartners,
  workshopFacets,
} from '../../_shared/workshopDirectory.ts';

export const WORKSHOP_DIRECTORY_ACTION = 'list_workshop_partners';

/** Baca saja; tidak ada alasan peran keuangan/agen mengakses daftar kontak ini. */
export const WORKSHOP_DIRECTORY_ROLES = ['MASTER_ADMIN', 'ADMIN', 'INSURANCE_ADMIN', 'B2B_CLIENT'] as const;

const json = (body: unknown, status = 200): ActionResult => ({ status, body });

export async function handleWorkshopPartnersAction(
  action: string,
  ctx: GatewayContext,
): Promise<ActionResult | null> {
  if (action !== WORKSHOP_DIRECTORY_ACTION) return null;

  const { params, caller, checkRateLimit } = ctx;
  if (!WORKSHOP_DIRECTORY_ROLES.includes(caller.role as (typeof WORKSHOP_DIRECTORY_ROLES)[number])) {
    return json({ error: 'Forbidden: direktori bengkel tidak tersedia untuk peran ini.' }, 403);
  }

  // Baca statis tetap dibatasi: satu klien tidak boleh meminta seluruh dataset
  // berulang kali tanpa batas. Gagal tertutup mengikuti _shared/rateLimit.ts.
  const bucket = caller.spUser?.id || caller.authId;
  if (!(await checkRateLimit(`workshop:${bucket}`, 300))) {
    return json({ error: 'Terlalu banyak permintaan direktori. Coba lagi nanti.' }, 429);
  }

  const parsed = normalizeWorkshopQuery(params);
  if (!parsed.ok) return json({ error: `Parameter direktori tidak valid: ${parsed.error}` }, 400);
  const page = normalizeWorkshopPage(params);
  if (!page.ok) return json({ error: `Parameter direktori tidak valid: ${page.error}` }, 400);

  const matched = filterWorkshopPartners(WORKSHOP_PARTNERS, parsed.query);
  const sorted = sortWorkshopPartners(matched, parsed.query);
  const rows = sorted.slice(page.page.offset, page.page.offset + page.page.limit);

  // `facets` dipakai tab asuransi (selalu global). `categoryCounts` dipakai
  // chip kategori dan HARUS mengikuti asuransi yang sedang dipilih — kalau
  // tidak, tab MAG akan menampilkan jumlah kategori ZURICH/OONA juga.
  const insurerScoped = parsed.query.insurer === 'ALL'
    ? WORKSHOP_PARTNERS
    : WORKSHOP_PARTNERS.filter(r => r.insurerCode === parsed.query.insurer);

  return json({
    data: {
      rows,
      total: sorted.length,
      facets: workshopFacets(WORKSHOP_PARTNERS),
      categoryCounts: workshopFacets(insurerScoped).categories,
      query: parsed.query,
      page: page.page,
    },
  });
}
