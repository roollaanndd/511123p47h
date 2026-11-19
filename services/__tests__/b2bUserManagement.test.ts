// Kelola pengguna B2B dari dashboard admin.
//
// Regression tests untuk empat kontrak yang menentukan apakah fitur ini aman:
//
//   1. Gerbang per-kapabilitas, BUKAN `caller.isAdmin`. ADMIN_ROLES di
//      data-gateway/index.ts juga memuat OPERATOR, FINANCE*, dan
//      INSURANCE_ADMIN; mengubah profil/KYC korporat bukan pekerjaan mereka.
//      Hard delete lebih sempit lagi: MASTER_ADMIN saja.
//   2. Whitelist field. Role, verified, email, dan status tidak boleh ikut
//      berubah lewat payload edit — itu jalur privilege escalation.
//   3. Deactivate bukan penghapusan: akun diberi cap waktu dan bisa diaktifkan
//      kembali. Hard delete dicegah selama masih ada batch (CASCADE menghapus
//      seluruh polis massal) dan wajib konfirmasi email.
//   4. Audit ditulis SEBELUM penghapusan dan tidak memuat nilai KTP/NPWP.
import { describe, it, expect, vi } from 'vitest';
import { handleMitraAccountsAction } from '../../supabase/functions/data-gateway/actions/mitraAccounts.ts';

type Row = Record<string, any>;
type Write = { table: string; op: string; row?: Row; filters: Row };

const B2B_TARGET: Row = {
  id: 'b2b-1',
  email: 'pic@korporat.com',
  name: 'Budi Santoso',
  phone: '081234567890',
  role: 'B2B_CLIENT',
  company_name: 'PT Korporat Sejahtera',
  company_reg_no: '1234567890123',
  company_industry: 'MULTIFINANCE',
  company_npwp: '123456789012345',
  company_address: 'Jl. Merdeka No. 1, Jakarta',
  pic_ktp: '1234567890123456',
  verified: true,
  b2b_deactivated_at: null,
  b2b_deactivated_by: null,
  b2b_profile_version: 3,
  created_at: '2026-01-01T00:00:00Z',
};

function makeDb(opts: { target?: Row | null; batches?: Row[] } = {}) {
  const writes: Write[] = [];
  const authCalls: Array<{ fn: string; arg: unknown }> = [];
  const target = opts.target === undefined ? B2B_TARGET : opts.target;

  function from(table: string) {
    const state: { mode: string; filters: Row; row?: Row; done: boolean; single: boolean; limit: number | null; result?: any } = {
      mode: 'select', filters: {}, done: false, single: false, limit: null,
    };
    const finish = () => {
      if (state.done) return state.result;
      state.done = true;
      const filters = { ...state.filters };
      if (state.mode === 'insert') writes.push({ table, op: 'insert', row: state.row, filters });
      if (state.mode === 'update') writes.push({ table, op: 'update', row: state.row, filters });
      if (state.mode === 'delete') writes.push({ table, op: 'delete', filters });

      let data: any = null;
      if (state.mode === 'select') {
        if (table === 'sp_b2b_batches') {
          const rows = opts.batches ?? [];
          data = state.limit == null ? rows : rows.slice(0, state.limit);
        } else if (table === 'sp_users') {
          data = state.single ? target : (target ? [target] : []);
        }
      } else if (state.mode === 'update') {
        // Optimistic lock: versi yang tidak cocok harus terasa seperti 0 baris.
        const expected = filters.b2b_profile_version;
        const versionMatches = expected === undefined || expected === target?.b2b_profile_version;
        data = versionMatches ? { ...target, ...state.row } : null;
      }
      state.result = { data, error: null };
      return state.result;
    };

    const chain: any = {
      select() { if (state.mode === 'select') state.mode = 'select'; return chain; },
      eq(key: string, value: unknown) { state.filters[key] = value; return chain; },
      limit(n: number) { state.limit = n; return chain; },
      maybeSingle() { state.single = true; return Promise.resolve(finish()); },
      single() { state.single = true; return Promise.resolve(finish()); },
      update(row: Row) { state.mode = 'update'; state.row = row; return chain; },
      delete() { state.mode = 'delete'; return chain; },
      insert(row: Row) { state.mode = 'insert'; state.row = row; return chain; },
      then(resolve: (v: any) => void) { resolve(finish()); return chain; },
    };
    return chain;
  }

  return {
    writes,
    authCalls,
    from,
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          authCalls.push({ fn: 'deleteUser', arg: id });
          return { data: null, error: null };
        },
      },
    },
  };
}

function makeCtx(role: string, params: Row = {}, dbOpts: Parameters<typeof makeDb>[0] = {}) {
  const db = makeDb(dbOpts);
  return {
    db,
    ctx: {
      db,
      params,
      caller: {
        authId: 'caller-auth',
        email: `${role.toLowerCase()}@surepath.id`,
        spUser: { id: 'caller-1', role },
        role,
        // Sengaja true untuk semua peran: tes penolakan harus gagal kalau
        // suatu hari aksi ini digerbang isAdmin.
        isAdmin: true,
        isFinanceAdmin: true,
        userMetadata: null,
        ownerId: 'caller-1',
        ownerIds: ['caller-1'],
        emailConfirmedAt: null,
      },
      reqIp: '203.0.113.10',
      reqUserAgent: 'vitest',
      sendTelegram: vi.fn(),
      logActivity: vi.fn(),
      checkRateLimit: vi.fn(async () => true),
      RESEND_KEY: '',
    } as never,
  };
}

const NON_ADMINS = ['OPERATOR', 'FINANCE', 'FINANCE_MANAGER', 'FINANCE_DIRECTOR', 'INSURANCE_ADMIN', 'AGENT', 'B2B_CLIENT'];

describe('admin_get_b2b_user', () => {
  for (const role of NON_ADMINS) {
    it(`menolak ${role} meski isAdmin true`, async () => {
      const { ctx } = makeCtx(role, { user_id: 'b2b-1' });
      const res = await handleMitraAccountsAction('admin_get_b2b_user', ctx);
      expect(res?.status).toBe(403);
    });
  }

  it('mengembalikan field KYC hanya untuk target B2B_CLIENT', async () => {
    const { ctx } = makeCtx('ADMIN', { user_id: 'b2b-1' });
    const res = await handleMitraAccountsAction('admin_get_b2b_user', ctx);
    expect(res?.status).toBe(200);
    const data = (res?.body as Row).data;
    expect(data.company_npwp).toBe(B2B_TARGET.company_npwp);
    expect(data.pic_ktp).toBe(B2B_TARGET.pic_ktp);
    expect(data.b2b_profile_version).toBe(3);
  });

  it('menolak target yang bukan B2B_CLIENT', async () => {
    const { ctx } = makeCtx('ADMIN', { user_id: 'x' }, { target: { ...B2B_TARGET, role: 'AGENT' } });
    const res = await handleMitraAccountsAction('admin_get_b2b_user', ctx);
    expect(res?.status).toBe(404);
  });
});

describe('admin_update_b2b_user — whitelist dan validasi', () => {
  for (const role of NON_ADMINS) {
    it(`menolak ${role} meski isAdmin true`, async () => {
      const { ctx } = makeCtx(role, { user_id: 'b2b-1', expected_version: 3, name: 'Budi' });
      const res = await handleMitraAccountsAction('admin_update_b2b_user', ctx);
      expect(res?.status).toBe(403);
    });
  }

  it('menolak payload yang tidak mengandung field yang bisa diedit', async () => {
    const { ctx } = makeCtx('ADMIN', { user_id: 'b2b-1', expected_version: 3, role: 'MASTER_ADMIN' });
    const res = await handleMitraAccountsAction('admin_update_b2b_user', ctx);
    expect(res?.status).toBe(400);
    expect((res?.body as Row).code).toBe('NO_EDITABLE_FIELDS');
  });

  it('tidak pernah menulis role, verified, email, atau status dari payload', async () => {
    const { db, ctx } = makeCtx('MASTER_ADMIN', {
      user_id: 'b2b-1',
      expected_version: 3,
      name: 'Budi Updated',
      company_npwp: '123456789012345',
      role: 'MASTER_ADMIN',
      verified: false,
      email: 'pwned@example.com',
      b2b_deactivated_at: '2020-01-01T00:00:00Z',
    });
    const res = await handleMitraAccountsAction('admin_update_b2b_user', ctx);
    expect(res?.status).toBe(200);

    const update = db.writes.find(w => w.op === 'update' && w.table === 'sp_users');
    expect(update?.row).toMatchObject({ name: 'Budi Updated', b2b_profile_version: 4 });
    for (const forbidden of ['role', 'verified', 'email', 'b2b_deactivated_at', 'b2b_deactivated_by', 'is_suspended']) {
      expect(update?.row).not.toHaveProperty(forbidden);
    }
    // Filter versi ikut dipakai sebagai optimistic lock.
    expect(update?.filters.b2b_profile_version).toBe(3);
  });

  it('menolak versi yang sudah usang tanpa mengaudit atau mengubah data', async () => {
    const { db, ctx } = makeCtx('ADMIN', { user_id: 'b2b-1', expected_version: 2, name: 'Budi' });
    const res = await handleMitraAccountsAction('admin_update_b2b_user', ctx);
    expect(res?.status).toBe(409);
    expect((res?.body as Row).code).toBe('VERSION_CONFLICT');
    // UPDATE tetap dikirim ke DB dengan filter versi (0 baris yang terkena),
    // tetapi tidak boleh ada jejak audit yang menyarankan edit berhasil.
    expect(db.writes.find(w => w.op === 'update')?.filters.b2b_profile_version).toBe(2);
    expect(db.writes.some(w => w.op === 'insert')).toBe(false);
  });

  it('menolak KTP bukan 16 digit dan NPWP bukan 15/16 digit', async () => {
    const ktp = makeCtx('ADMIN', { user_id: 'b2b-1', expected_version: 3, pic_ktp: '123' });
    expect((await handleMitraAccountsAction('admin_update_b2b_user', ktp.ctx))?.status).toBe(400);
    expect((await handleMitraAccountsAction('admin_update_b2b_user', ktp.ctx))?.body).toMatchObject({ code: 'INVALID_PIC_KTP' });

    const npwp = makeCtx('ADMIN', { user_id: 'b2b-1', expected_version: 3, company_npwp: 'abc' });
    expect((await handleMitraAccountsAction('admin_update_b2b_user', npwp.ctx))?.body).toMatchObject({ code: 'INVALID_COMPANY_NPWP' });
  });

  it('mengaudit nama field saja — bukan nilai KTP/NPWP', async () => {
    const { db, ctx } = makeCtx('ADMIN', {
      user_id: 'b2b-1',
      expected_version: 3,
      pic_ktp: '9999999999999999',
      company_npwp: '999999999999999',
    });
    await handleMitraAccountsAction('admin_update_b2b_user', ctx);
    const audit = db.writes.find(w => w.op === 'insert' && w.table === 'sp_b2b_activity_log');
    expect(audit?.row?.action).toBe('b2b_user_profile_updated');
    expect(JSON.stringify(audit?.row)).not.toContain('9999999999999999');
    expect(JSON.stringify(audit?.row)).not.toContain('999999999999999');
    expect(audit?.row?.detail?.changed_fields).toEqual(expect.arrayContaining(['pic_ktp', 'company_npwp']));
  });
});

describe('admin_set_b2b_user_active', () => {
  for (const role of NON_ADMINS) {
    it(`menolak ${role} meski isAdmin true`, async () => {
      const { ctx } = makeCtx(role, { user_id: 'b2b-1', active: false });
      const res = await handleMitraAccountsAction('admin_set_b2b_user_active', ctx);
      expect(res?.status).toBe(403);
    });
  }

  it('menandai nonaktif dengan cap waktu dan actor, bukan menghapus baris', async () => {
    const { db, ctx } = makeCtx('ADMIN', { user_id: 'b2b-1', active: false });
    const res = await handleMitraAccountsAction('admin_set_b2b_user_active', ctx);
    expect(res?.status).toBe(200);

    const update = db.writes.find(w => w.op === 'update' && w.table === 'sp_users');
    expect(update?.row?.b2b_deactivated_by).toBe('caller-1');
    expect(typeof update?.row?.b2b_deactivated_at).toBe('string');
    expect(update?.row?.b2b_profile_version).toBe(4);
    expect(db.writes.some(w => w.op === 'delete')).toBe(false);
    expect(db.authCalls).toHaveLength(0);
  });

  it('menolak aksi yang tidak mengubah status', async () => {
    const active = makeCtx('ADMIN', { user_id: 'b2b-1', active: true });
    expect((await handleMitraAccountsAction('admin_set_b2b_user_active', active.ctx))?.body).toMatchObject({ code: 'ALREADY_ACTIVE' });

    const inactive = makeCtx('ADMIN', { user_id: 'b2b-1', active: false },
      { target: { ...B2B_TARGET, b2b_deactivated_at: '2026-06-01T00:00:00Z' } });
    expect((await handleMitraAccountsAction('admin_set_b2b_user_active', inactive.ctx))?.body).toMatchObject({ code: 'ALREADY_DEACTIVATED' });
  });

  it('mengaktifkan kembali dengan menghapus cap waktu', async () => {
    const { db, ctx } = makeCtx('ADMIN', { user_id: 'b2b-1', active: true },
      { target: { ...B2B_TARGET, b2b_deactivated_at: '2026-06-01T00:00:00Z', b2b_deactivated_by: 'caller-1' } });
    const res = await handleMitraAccountsAction('admin_set_b2b_user_active', ctx);
    expect(res?.status).toBe(200);
    const update = db.writes.find(w => w.op === 'update' && w.table === 'sp_users');
    expect(update?.row?.b2b_deactivated_at).toBe(null);
    expect(update?.row?.b2b_deactivated_by).toBe(null);
    expect(db.writes.find(w => w.op === 'insert')?.row?.action).toBe('b2b_user_reactivated');
  });
});

describe('admin_delete_b2b_user — pagar hard delete', () => {
  for (const role of ['ADMIN', ...NON_ADMINS]) {
    it(`menolak ${role} — hanya MASTER_ADMIN`, async () => {
      const { ctx } = makeCtx(role, { user_id: 'b2b-1', confirm_email: 'pic@korporat.com' });
      const res = await handleMitraAccountsAction('admin_delete_b2b_user', ctx);
      expect(res?.status).toBe(403);
    });
  }

  it('menolak konfirmasi email yang tidak cocok', async () => {
    const { db, ctx } = makeCtx('MASTER_ADMIN', { user_id: 'b2b-1', confirm_email: 'salah@korporat.com' });
    const res = await handleMitraAccountsAction('admin_delete_b2b_user', ctx);
    expect(res?.status).toBe(400);
    expect((res?.body as Row).code).toBe('CONFIRMATION_MISMATCH');
    expect(db.writes.some(w => w.op === 'delete')).toBe(false);
  });

  it('memblokir penghapusan selama masih ada batch (CASCADE polis massal)', async () => {
    const { db, ctx } = makeCtx('MASTER_ADMIN',
      { user_id: 'b2b-1', confirm_email: 'PIC@KORPORAT.COM' },
      { batches: [{ id: 'batch-1', status: 'ISSUED' }] });
    const res = await handleMitraAccountsAction('admin_delete_b2b_user', ctx);
    expect(res?.status).toBe(409);
    expect((res?.body as Row).code).toBe('ACTIVE_BATCHES');
    expect(db.writes.some(w => w.op === 'delete')).toBe(false);
    expect(db.authCalls).toHaveLength(0);
  });

  it('mencegah penghapusan diri sendiri', async () => {
    const { ctx, db } = makeCtx('MASTER_ADMIN', { user_id: 'caller-1', confirm_email: 'masteradmin@surepath.id' },
      { target: { ...B2B_TARGET, id: 'caller-1', email: 'masteradmin@surepath.id' } });
    const res = await handleMitraAccountsAction('admin_delete_b2b_user', ctx);
    expect(res?.status).toBe(403);
    expect(db.writes.some(w => w.op === 'delete')).toBe(false);
  });

  it('mengaudit lebih dulu lalu menghapus profil dan akun auth', async () => {
    const { db, ctx } = makeCtx('MASTER_ADMIN', { user_id: 'b2b-1', confirm_email: 'pic@korporat.com' });
    const res = await handleMitraAccountsAction('admin_delete_b2b_user', ctx);
    expect(res?.status).toBe(200);

    const ops = db.writes.map(w => `${w.table}:${w.op}`);
    expect(ops).toContain('sp_b2b_activity_log:insert');
    expect(ops).toContain('sp_users:delete');
    expect(ops.indexOf('sp_b2b_activity_log:insert')).toBeLessThan(ops.indexOf('sp_users:delete'));
    expect(db.authCalls.find(c => c.fn === 'deleteUser')?.arg).toBe('b2b-1');
  });
});
