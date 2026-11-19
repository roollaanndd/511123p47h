/**
 * gatewayRbac.test.ts — kunci kebijakan RBAC data-gateway (audit 2026-11-19).
 *
 * Latar belakang: `ADMIN_ROLES` di `data-gateway/index.ts` memuat `OPERATOR`.
 * Itu benar untuk antrean operasional (order, klaim, verifikasi agen), tetapi
 * salah untuk aksi yang menerbitkan/membuka kredensial mitra atau mengubah
 * konfigurasi harga. Sebelum perbaikan, OPERATOR bisa:
 *   - melihat token insurer dalam bentuk plaintext,
 *   - menerbitkan token insurer baru (impersonasi mitra),
 *   - membaca/menulis API key insurer,
 *   - membuat/menghapus insurer dan produknya,
 *   - mengubah set tarif OJK yang aktif.
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

  it('caller selalu membawa isCoreAdmin (dua jalur: publik dan terautentikasi)', () => {
    const hits = index.match(/isCoreAdmin:/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
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
    ['actions/insurers.ts', 'admin_save_ojk_rate_set'],
    ['actions/insurers.ts', 'admin_activate_ojk_rate_set'],
    ['actions/insurers.ts', 'admin_delete_ojk_rate_set'],
    ['actions/admin.ts', 'admin_update_user'],
  ];

  it.each(SENSITIVE)('%s :: %s dijaga isCoreAdmin, bukan isAdmin', (file, action) => {
    const block = caseBlock(read(file), action);
    expect(block).toContain('caller.isCoreAdmin');
    // Guard pertama tidak boleh lagi memakai `isAdmin` saja.
    const guard = block.split('\n').find((l) => l.includes('Forbidden')) ?? '';
    expect(guard).toContain('isCoreAdmin');
  });

  const FINANCE_ONLY = ['admin_financial_reports', 'admin_financial_detail', 'admin_list_commissions'];

  it.each(FINANCE_ONLY)('%s tidak terbuka untuk peran non-finance', (action) => {
    const block = caseBlock(read('actions/admin.ts'), action);
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
    expect(sendLink).not.toContain('caller.isCoreAdmin');
  });

  it('error 500 tidak membocorkan pesan internal', () => {
    expect(index).not.toContain("String((e as Error)?.message ?? e) }, 500");
    expect(index).toContain("error: 'Internal error'");
  });
});
