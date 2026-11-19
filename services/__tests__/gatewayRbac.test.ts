/**
 * gatewayRbac.test.ts — kunci kebijakan RBAC data-gateway (audit 2026-11-19).
 *
 * Latar belakang: `ADMIN_ROLES` di `data-gateway/index.ts` memuat `OPERATOR`.
 * Itu benar untuk antrean operasional (order, klaim, verifikasi agen), tetapi
 * salah untuk aksi yang menerbitkan/membuka kredensial mitra atau mengubah
 * konfigurasi harga. Sebelum perbaikan, OPERATOR bisa:
 *   - melihat token insurer dan token review dalam bentuk plaintext,
 *   - menerbitkan token insurer baru (impersonasi mitra),
 *   - membaca/menulis API key insurer,
 *   - membuat/menghapus insurer dan produknya,
 *   - mengubah set tarif OJK yang aktif,
 *   - mencetak koin agen (rp_value = coins * 1000).
 *
 * Tes ini bukan tes perilaku (butuh Deno + Supabase). Ia mengunci BENTUK guard
 * di sumber, sehingga regresi "guard dilonggarkan lagi" langsung gagal di CI.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const GATEWAY = join(process.cwd(), 'supabase/functions/data-gateway');

function read(rel: string): string {
  return readFileSync(join(GATEWAY, rel), 'utf8');
}

/** Ambil blok `case '<action>': { ... }` sampai `case` berikutnya. */
function caseBlock(source: string, action: string): string {
  const start = source.indexOf(`case '${action}'`);
  expect(start, `case ${action} tidak ditemukan`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + 1);
  const next = rest.indexOf('case \'');
  return next === -1 ? rest : rest.slice(0, next);
}

describe('data-gateway RBAC', () => {
  const index = read('index.ts');

  it('peran inti hanya MASTER_ADMIN dan ADMIN (OPERATOR tidak ikut)', () => {
    const m = index.match(/const CORE_ADMIN_ROLES\s*=\s*\[([^\]]+)\]/);
    expect(m, 'CORE_ADMIN_ROLES tidak dideklarasikan').not.toBeNull();
    const roles = m![1].split(',').map((r) => r.trim().replace(/^'|'$/g, '')).filter(Boolean);
    expect(roles).toEqual(['MASTER_ADMIN', 'ADMIN']);
    expect(roles).not.toContain('OPERATOR');
  });

  it('kedua jalur pembentukan caller mengisi isCoreAdmin dan isRateAdmin', () => {
    // Jalur publik (tanpa sesi): keduanya false.
    expect(index).toContain('isCoreAdmin: false, isRateAdmin: false');
    // Jalur terautentikasi: diturunkan dari daftar peran.
    expect(index).toContain('isCoreAdmin: CORE_ADMIN_ROLES.includes');
    expect(index).toContain('isRateAdmin: RATE_ADMIN_ROLES.includes');
    // Field wajib ada di tipe GatewayContext, kalau tidak `deno check` gagal.
    const types = read('actions/types.ts');
    expect(types).toContain('isCoreAdmin: boolean');
    expect(types).toContain('isRateAdmin: boolean');
  });

  const SENSITIVE: Array<[string, string]> = [
    ['actions/insurers.ts', 'admin_list_insurer_tokens'],
    ['actions/insurers.ts', 'admin_generate_insurer_token'],
    ['actions/insurers.ts', 'admin_revoke_insurer_token'],
    ['actions/insurers.ts', 'admin_get_insurer_api_config'],
    ['actions/insurers.ts', 'admin_save_insurer_api_config'],
    ['actions/insurers.ts', 'admin_create_insurer'],
    ['actions/insurers.ts', 'admin_update_insurer'],
    ['actions/insurers.ts', 'admin_delete_insurer'],
    ['actions/insurers.ts', 'admin_save_insurer_product'],
    ['actions/insurers.ts', 'admin_delete_insurer_product'],
    // Token review = kunci /review/:uuid (setujui/tolak polis atas nama insurer).
    ['actions/insurers.ts', 'admin_list_review_tokens'],
    ['actions/admin.ts', 'admin_update_user'],
  ];

  // Rate OJK mengubah harga semua produk; INSURANCE_ADMIN memegang menu itu,
  // jadi ia tetap boleh — yang dicabut adalah OPERATOR/peran lain.
  const RATE_ONLY: Array<[string, string]> = [
    ['actions/insurers.ts', 'admin_save_ojk_rate_set'],
    ['actions/insurers.ts', 'admin_activate_ojk_rate_set'],
    ['actions/insurers.ts', 'admin_delete_ojk_rate_set'],
  ];

  it.each(RATE_ONLY)('%s :: %s dijaga isRateAdmin', (file, action) => {
    const block = caseBlock(read(file), action);
    expect(block).toContain('caller.isRateAdmin');
  });

  it.each(SENSITIVE)('%s :: %s dijaga isCoreAdmin, bukan isAdmin', (file, action) => {
    const block = caseBlock(read(file), action);
    expect(block).toContain('caller.isCoreAdmin');
    // Guard pertama tidak boleh lagi memakai `isAdmin` saja.
    const guard = block.split('\n').find((l) => l.includes('Forbidden')) ?? '';
    expect(guard).toContain('isCoreAdmin');
  });

  const FINANCE_ONLY: Array<[string, string]> = [
    ['actions/admin.ts', 'admin_financial_reports'],
    ['actions/admin.ts', 'admin_financial_detail'],
    ['actions/admin.ts', 'admin_list_commissions'],
    ['actions/wallet.ts', 'award_coins'],
  ];

  it.each(FINANCE_ONLY)('%s :: %s tidak terbuka untuk peran non-finance', (file, action) => {
    const block = caseBlock(read(file), action);
    expect(block).toContain('caller.isFinanceAdmin');
  });

  it('aksi antrean operator tetap memakai isAdmin (tidak ikut dipersempit)', () => {
    const agents = read('actions/agents.ts');
    expect(agents).toContain('admin_verify_agent');
    // Operator memang mengirim tautan review insurer — aksi ini harus tetap
    // terbuka untuk OPERATOR, jadi sengaja TIDAK memakai isCoreAdmin.
    const orders = read('actions/orders.ts');
    const sendLink = caseBlock(orders, 'admin_send_insurer_review_link');
    expect(sendLink).toContain('caller.isAdmin');
  });

  it('tautan review hanya dikembalikan ke peran inti', () => {
    const orders = read('actions/orders.ts');
    const sendLink = caseBlock(orders, 'admin_send_insurer_review_link');
    // Token review tidak boleh ikut di respons tanpa syarat.
    expect(sendLink).not.toContain('success: true, review_url: reviewUrl');
    expect(sendLink).toContain('caller.isCoreAdmin ? { review_url: reviewUrl }');
    // Metadata notifikasi admin juga tidak boleh membawa token.
    expect(sendLink).not.toContain('review_url: reviewUrl, insurer_email');
  });

  it('semua aksi yang dipakai portal operator tidak dikunci isCoreAdmin', () => {
    const operator = readFileSync(join(process.cwd(), 'services/operatorService.ts'), 'utf8');
    const actions = [...operator.matchAll(/'(admin_[a-z0-9_]+)'/g)].map((m) => m[1]);
    expect(actions.length).toBeGreaterThan(5);
    for (const action of new Set(actions)) {
      const files = ['admin', 'agents', 'orders', 'claims', 'wallet', 'notifications', 'insurers', 'misc'];
      for (const f of files) {
        const src = read(`actions/${f}.ts`);
        if (!src.includes(`case '${action}'`)) continue;
        const block = caseBlock(src, action);
        // Yang dilarang adalah GERBANG masuk berbasis peran inti. Pemakaian
        // isCoreAdmin untuk meredaksi respons (mis. tautan review) tetap sah.
        const guard = block.split('\n').find((l) => l.includes('Forbidden')) ?? '';
        expect(guard, `${action} tidak boleh digerbangi isCoreAdmin`).not.toContain('isCoreAdmin');
      }
    }
  });

  it('verifikasi agen hanya untuk akun berperan AGENT dan bukan diri sendiri', () => {
    const agents = read('actions/agents.ts');
    const block = caseBlock(agents, 'admin_verify_agent');
    expect(block).toContain("!== 'AGENT'");
    expect(block).toContain('caller.ownerId');
  });

  it('error 500 tidak membocorkan pesan internal', () => {
    expect(index).not.toContain("String((e as Error)?.message ?? e) }, 500");
    expect(index).toContain("error: 'Internal error'");
  });
});
