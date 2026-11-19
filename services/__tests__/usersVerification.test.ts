// Regression: tombol Approve/Revoke di Manajemen Mitra harus memakai aksi
// `admin_verify_agent` yang diaudit. Sejak v1.44.0 gateway sengaja membuang
// field `verified` dari `admin_update_user` (pentest M2), jadi pemanggil lama
// menerima 400 "No valid fields to update" dan approval tidak pernah tersimpan.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  supabase: { auth: { getSession: vi.fn(() => Promise.resolve({ data: { session: null } })) } },
  callGateway: vi.fn(async () => ({ data: null })),
}));

import { callGateway } from '../db';
import { updateAgentVerification } from '../users';

const gw = vi.mocked(callGateway);

describe('updateAgentVerification', () => {
  beforeEach(() => vi.clearAllMocks());

  it('approve memanggil admin_verify_agent, bukan admin_update_user', async () => {
    gw.mockResolvedValueOnce({ data: { id: 'a1', verified: true } });

    await expect(updateAgentVerification('a1', true)).resolves.toBe(true);

    expect(gw).toHaveBeenCalledTimes(1);
    expect(gw).toHaveBeenCalledWith('admin_verify_agent', { agent_id: 'a1', approve: true });
    expect(gw).not.toHaveBeenCalledWith(
      'admin_update_user',
      expect.objectContaining({ verified: expect.anything() }),
    );
  });

  it('revoke mengirim approve:false', async () => {
    gw.mockResolvedValueOnce({ data: { id: 'a1', verified: false } });

    await expect(updateAgentVerification('a1', false)).resolves.toBe(true);

    expect(gw).toHaveBeenCalledWith('admin_verify_agent', { agent_id: 'a1', approve: false });
  });

  it('error gateway dikembalikan sebagai false', async () => {
    gw.mockResolvedValueOnce({ error: 'No valid fields to update' });

    await expect(updateAgentVerification('a1', true)).resolves.toBe(false);
  });
});
