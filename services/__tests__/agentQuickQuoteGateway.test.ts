import { describe, expect, it, vi } from 'vitest';
import { handleMiscAction } from '../../supabase/functions/data-gateway/actions/misc';

const makeContext = (overrides: Record<string, any> = {}) => {
  const insertedRows: Record<string, any>[] = [];
  const db = {
    from: vi.fn((table: string) => ({
      insert: (row: Record<string, any>) => {
        insertedRows.push({ table, ...row });
        return {
          select: () => ({
            single: async () => ({ data: { id: 'quote-1', ...row }, error: null }),
          }),
        };
      },
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
    })),
  };

  return {
    insertedRows,
    ctx: {
      db,
      params: {
        agent_id: 'attacker-controlled-agent',
        client_id: null,
        client_name: '',
        product_type: 'CAR',
        status: 'CONVERTED',
        premium_estimate: 1250000,
        quote_data: { province: 'DKI Jakarta' },
      },
      caller: {
        authId: 'auth-agent',
        email: 'agent@example.com',
        spUser: { id: 'agent-profile', role: 'AGENT', verified: true },
        role: 'AGENT',
        isAdmin: false,
        isCoreAdmin: false,
        isRateAdmin: false,
        isFinanceAdmin: false,
        userMetadata: null,
        ownerId: 'canonical-agent-id',
        ownerIds: ['canonical-agent-id', 'auth-agent'],
        emailConfirmedAt: '2026-01-01T00:00:00.000Z',
      },
      reqIp: null,
      reqUserAgent: null,
      sendTelegram: vi.fn(),
      logActivity: vi.fn(),
      checkRateLimit: vi.fn(async () => true),
      RESEND_KEY: '',
      ...overrides,
    },
  };
};

describe('save_quote gateway security', () => {
  it('derives agent ownership from the authenticated caller and stores a draft', async () => {
    const { ctx, insertedRows } = makeContext();
    const result = await handleMiscAction('save_quote', ctx as any);

    expect(result?.status).toBe(200);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].agent_id).toBe('canonical-agent-id');
    expect(insertedRows[0].agent_id).not.toBe('attacker-controlled-agent');
    expect(insertedRows[0].status).toBe('DRAFT');
  });

  it('rejects callers who are not agents', async () => {
    const customer = makeContext();
    customer.ctx.caller.spUser = { id: 'customer-1', role: 'CUSTOMER', verified: true };
    const result = await handleMiscAction('save_quote', customer.ctx as any);
    expect(result?.status).toBe(403);
    expect(customer.insertedRows).toHaveLength(0);
  });

  it('allows an unverified agent to save an indicative quote but keeps it as a draft', async () => {
    const { ctx, insertedRows } = makeContext();
    ctx.caller.spUser.verified = false;
    const result = await handleMiscAction('save_quote', ctx as any);
    expect(result?.status).toBe(200);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].status).toBe('DRAFT');
  });

  it('rejects unsupported product types and malformed premium values', async () => {
    const badProduct = makeContext();
    badProduct.ctx.params.product_type = 'UNSUPPORTED';
    const productResult = await handleMiscAction('save_quote', badProduct.ctx as any);
    expect(productResult?.status).toBe(400);

    const badPremium = makeContext();
    badPremium.ctx.params.premium_estimate = Number.NaN;
    const premiumResult = await handleMiscAction('save_quote', badPremium.ctx as any);
    expect(premiumResult?.status).toBe(400);
  });

  it('does not attach another agent customer record', async () => {
    const { ctx, insertedRows } = makeContext();
    ctx.params.client_id = 'foreign-client-id';
    const result = await handleMiscAction('save_quote', ctx as any);
    expect(result?.status).toBe(404);
    expect(insertedRows).toHaveLength(0);
  });

  it('rejects oversized quote payloads before database writes', async () => {
    const { ctx, insertedRows } = makeContext();
    ctx.params.quote_data = { note: 'x'.repeat(65 * 1024) };
    const result = await handleMiscAction('save_quote', ctx as any);
    expect(result?.status).toBe(413);
    expect(insertedRows).toHaveLength(0);
  });
});
