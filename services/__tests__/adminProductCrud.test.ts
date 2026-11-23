/**
 * adminProductCrud.test.ts — regresi 2026-11-23.
 *
 * Dua keluhan owner di Admin CMS:
 *   1. "Produk & Tier → Produk": perubahan komisi/diskon/koin tampak tersimpan,
 *      lalu kembali ke nilai lama setelah reload.
 *   2. "Perusahaan Asuransi → Lihat Produk": edit produk tidak tersimpan, hapus
 *      dan tambah tidak benar-benar terjadi, tetapi toast tetap bilang sukses.
 *
 * Akar masalahnya bukan tampilan:
 *   - sp_product_configs hanya punya policy SELECT (20260603_tighten_tier3_rls).
 *     UPDATE langsung mengenai 0 baris TANPA error; INSERT ditolak RLS.
 *   - ProductFormData tidak memuat insurer_id, jadi gateway menolak edit produk
 *     dengan 400 "insurer_id required" — dan UI mengabaikan error itu.
 *
 * Tes ini mengunci bentuk perbaikannya di sumber (butuh Deno + Supabase untuk
 * tes perilaku penuh), mengikuti pola gatewayRbac.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('konfigurasi produk & komisi (sp_product_configs)', () => {
  const ui = read('components/admin/ProductConfigAdmin.tsx');
  const gateway = read('supabase/functions/data-gateway/actions/insurers.ts');

  it('UI menulis lewat data-gateway, bukan langsung ke tabel SELECT-only', () => {
    expect(ui).toContain("callGateway('admin_save_product_config'");
    expect(ui).not.toMatch(/from\('sp_product_configs'\)\s*\.(update|insert|upsert|delete)\(/);
  });

  it('UI menampilkan error simpan, bukan menganggapnya sukses', () => {
    expect(ui).toContain('setSaveError(');
    expect(ui).toContain('result.error');
  });

  it('gateway menyediakan admin_save_product_config dengan guard core admin', () => {
    const start = gateway.indexOf("case 'admin_save_product_config'");
    expect(start, "case 'admin_save_product_config' tidak ditemukan").toBeGreaterThanOrEqual(0);
    const block = gateway.slice(start, start + 900);
    expect(block).toContain('isCoreAdmin');
    // Update harus memastikan ada baris yang benar-benar berubah.
    expect(gateway.slice(start, start + 3400)).toContain("error: 'Konfigurasi produk tidak ditemukan'");
  });
});

describe('produk per insurer (sp_insurer_products)', () => {
  const ui = read('components/admin/InsurerAdmin.tsx');
  const gateway = read('supabase/functions/data-gateway/actions/insurers.ts');

  it('gateway menurunkan insurer_id dari baris yang diedit', () => {
    const start = gateway.indexOf("case 'admin_save_insurer_product'");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = gateway.slice(start, start + 1500);
    expect(block).toContain(".select('insurer_id')");
  });

  it('gateway ikut menyimpan notes produk', () => {
    const start = gateway.indexOf("case 'admin_save_insurer_product'");
    const block = gateway.slice(start, start + 2800);
    expect(block).toContain('payload.notes');
  });

  it('form edit mengirim insurer_id', () => {
    const start = ui.indexOf('const handleEditSave');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(ui.slice(start, start + 600)).toContain('insurer_id: editTarget.insurer_id');
  });

  it('hapus tidak memberi toast sukses saat gateway error', () => {
    const start = ui.indexOf('const handleDelete');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = ui.slice(start, start + 800);
    const errorAt = block.indexOf('if (error)');
    const successAt = block.indexOf("toast.success('Produk dihapus')");
    expect(errorAt).toBeGreaterThanOrEqual(0);
    expect(successAt).toBeGreaterThan(errorAt);
  });

  it('tambah produk berhenti sebelum menutup modal saat gateway error', () => {
    const start = ui.indexOf('const handleAddProduct');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = ui.slice(start, start + 700);
    const errorAt = block.indexOf('if (error)');
    const closeAt = block.indexOf('setShowAddProduct(false)');
    expect(errorAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeGreaterThan(errorAt);
  });
});
