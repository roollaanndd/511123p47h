/**
 * pathyErrorLog.test.ts — regresi 2026-11-23.
 *
 * Keluhan: "Pathy sering error", dengan pesan AUTH ("Sesi kamu sudah berakhir").
 * Masalahnya bukan cuma bug-nya, tapi ketiadaan jejak: kalau JWT ditolak
 * platform Supabase, edge function tidak pernah dijalankan sehingga
 * console.error di dalamnya pun tidak dieksekusi. Yang tersisa di browser
 * hanyalah satu kalimat tanpa kode.
 *
 * Perbaikannya dua arah:
 *   1. klien mencatat kode/status ke `sp_pathy_errors` lewat klien anon TANPA
 *      sesi (klien ber-sesi akan ditolak PGRST301 justru saat JWT kedaluwarsa);
 *   2. edge function mencatat status upstream OpenRouter lewat service_role,
 *      dengan `sp_activity_log` sebagai sink cadangan bila migrasi belum jalan.
 *
 * Tes ini mengunci bentuk itu di sumber, mengikuti pola gatewayRbac.test.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('beacon diagnosa di klien (services/website.ts)', () => {
  const src = read('services/website.ts');

  it('memakai klien anon tanpa sesi untuk menulis jejak', () => {
    expect(src).toContain("from('sp_pathy_errors')");
    expect(src).toMatch(/persistSession:\s*false/);
    expect(src).toMatch(/autoRefreshToken:\s*false/);
  });

  it('mencatat AUTH beserta status 401 dan detail dari server', () => {
    const start = src.indexOf("if (res.status === 401)");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = src.slice(start, start + 600);
    expect(block).toContain("code: 'AUTH'");
    expect(block).toContain('httpStatus: 401');
    expect(block).toContain('detail');
  });

  it('mencoba refresh sesi sekali sebelum menyimpulkan sesi berakhir', () => {
    expect(src).toContain('refreshSession()');
    const refreshAt = src.indexOf('refreshSession()');
    const authAt = src.indexOf("throw new PathyError('AUTH'");
    expect(refreshAt).toBeGreaterThanOrEqual(0);
    expect(authAt).toBeGreaterThan(refreshAt);
  });

  it('membedakan timeout/jaringan dari kegagalan upstream', () => {
    expect(src).toContain("code: e2?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK'");
  });
});

describe('sink server (edge functions)', () => {
  const helper = read('supabase/functions/_shared/pathyErrors.ts');

  it('helper tidak pernah melempar dan punya sink cadangan', () => {
    expect(helper).toContain("from('sp_pathy_errors')");
    expect(helper).toContain("from('sp_activity_log')");
    expect(helper).toContain('PATHY_ERROR');
    expect(helper).toContain('catch (e)');
  });

  it('pathy-agent mencatat status upstream OpenRouter', () => {
    const src = read('supabase/functions/pathy-agent/index.ts');
    expect(src).toContain("from '../_shared/pathyErrors.ts'");
    expect(src).toContain("source: 'agent'");
    expect(src).toContain("code: 'UPSTREAM_ERROR'");
    expect(src).toContain('httpStatus: res.status');
  });

  it('proxy dan ai-proxy ikut mencatat', () => {
    const proxy = read('supabase/functions/pathy-agent-proxy/index.ts');
    const aiProxy = read('supabase/functions/ai-proxy/index.ts');
    expect(proxy).toContain("source: 'proxy'");
    expect(proxy).toContain("code: 'UPSTREAM_ERROR'");
    expect(aiProxy).toContain("source: 'ai-proxy'");
    expect(aiProxy).toContain("code: 'UPSTREAM_ERROR'");
  });
});

describe('migrasi tabel diagnosa', () => {
  const path = 'supabase/migrations/20261123100000_pathy_error_log.sql';

  it('ada, dengan RLS insert khusus source=client dan baca khusus admin', () => {
    expect(existsSync(join(ROOT, path))).toBe(true);
    const sql = read(path);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.sp_pathy_errors');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain("WITH CHECK (source = 'client')");
    expect(sql).toContain('USING (is_admin())');
    // Tidak ada isi percakapan yang disimpan — hanya kode/status.
    expect(sql).not.toContain('message_body');
  });
});
