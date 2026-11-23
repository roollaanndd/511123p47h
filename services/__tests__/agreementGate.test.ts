/**
 * agreementGate.test.ts — regresi 2026-11-23.
 *
 * Keluhan owner:
 *   1. "Saat mau masuk admin dashboard muncul perjanjian — padahal itu hanya
 *      untuk app mitra."
 *   2. "Kalau sudah sign/approve, jangan ditanya dan dibuatkan lagi — kecuali
 *      ada pembaruan perjanjian."
 *
 * Akar masalahnya satu: `get_my_agreement` dulu hanya bisa menjawab "ada" atau
 * "tidak ada". Admin (yang memang tidak punya rekaman) dan mitra yang
 * pengecekannya gagal sama-sama menerima `data: null`, lalu AgentPortal
 * menampilkan gerbang Perjanjian Kemitraan kepada keduanya.
 *
 * Sekarang jawabannya tiga keadaan: `required` (berlaku atau tidak untuk peran
 * ini), `data` (rekaman versi aktif), dan error sungguhan bila query gagal.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
  callGateway: vi.fn(),
}));

import { callGateway } from '../db';
import { getMyAgreementStatus, getMyAgreement } from '../agreements';

const gw = vi.mocked(callGateway);
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const AGREEMENT = {
  id: 'agr-1',
  agent_id: 'agent-1',
  agreement_no: 'SP-AGR-1',
  doc_version: 'v1.0-2026',
  full_name: 'Nama Mitra',
  ktp_number: '3200000000000001',
  accepted_at: '2026-11-01T00:00:00Z',
};

describe('getMyAgreementStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('admin/operator: required=false, tidak pernah menampilkan gerbang', async () => {
    gw.mockResolvedValueOnce({ data: null, required: false, active_version: null });

    const status = await getMyAgreementStatus();

    expect(status.required).toBe(false);
    expect(status.agreement).toBeNull();
    expect(status.error).toBeNull();
  });

  it('mitra yang sudah menandatangani versi aktif: rekaman dikembalikan', async () => {
    gw.mockResolvedValueOnce({ data: AGREEMENT, required: true, active_version: 'v1.0-2026' });

    const status = await getMyAgreementStatus();

    expect(status.required).toBe(true);
    expect(status.agreement?.agreement_no).toBe('SP-AGR-1');
    expect(status.activeVersion).toBe('v1.0-2026');
    expect(status.error).toBeNull();
  });

  it('mitra yang belum menandatangani: required tapi tanpa rekaman', async () => {
    gw.mockResolvedValueOnce({ data: null, required: true, active_version: 'v2.0-2026' });

    const status = await getMyAgreementStatus();

    expect(status.required).toBe(true);
    expect(status.agreement).toBeNull();
    expect(status.activeVersion).toBe('v2.0-2026');
  });

  it('pengecekan gagal TIDAK dilaporkan sebagai "belum menandatangani"', async () => {
    gw.mockResolvedValueOnce({ error: 'Gateway timeout' });

    const status = await getMyAgreementStatus();

    expect(status.error).toBe('Gateway timeout');
    // Tetap true supaya pemanggil lama tidak menganggap "tidak berlaku",
    // tetapi AgentPortal memakai `error` untuk tidak menahan aplikasi.
    expect(status.required).toBe(true);
    expect(status.agreement).toBeNull();
  });

  it('server lama tanpa `required` tetap fail-closed', async () => {
    gw.mockResolvedValueOnce({ data: null });

    const status = await getMyAgreementStatus();

    expect(status.required).toBe(true);
  });

  it('getMyAgreement() lama tetap mengembalikan rekaman atau null', async () => {
    gw.mockResolvedValueOnce({ data: AGREEMENT, required: true, active_version: 'v1.0-2026' });
    await expect(getMyAgreement()).resolves.toMatchObject({ agreement_no: 'SP-AGR-1' });

    gw.mockResolvedValueOnce({ data: null, required: true, active_version: 'v1.0-2026' });
    await expect(getMyAgreement()).resolves.toBeNull();
  });
});

describe('sumber: cakupan peran dan perilaku gerbang', () => {
  it('gateway hanya mewajibkan perjanjian untuk peran AGENT', () => {
    const src = read('supabase/functions/data-gateway/actions/users.ts');
    const start = src.indexOf("case 'get_my_agreement'");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = src.slice(start, start + 1800);
    expect(block).toContain("role !== 'AGENT'");
    expect(block).toContain('required: false');
    expect(block).toContain('active_version: docVersion');
  });

  it('AgentPortal tidak menahan aplikasi saat pengecekan gagal', () => {
    const src = read('components/agent/AgentPortal.tsx');
    const start = src.indexOf('getMyAgreementStatus()');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = src.slice(start, start + 900);
    expect(block).toContain('if (!status.required)');
    expect(block).toContain('if (status.error)');
    // error → lanjut (true), bukan memaksa tanda tangan
    expect(block).toMatch(/status\.error\)[\s\S]{0,200}setAgreementOk\(true\)/);
  });
});
