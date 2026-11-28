import { beforeEach, describe, expect, it, vi } from 'vitest';

const callGateway = vi.fn();
const supabaseFrom = vi.fn();

vi.mock('../db', () => ({
  callGateway,
  supabase: { from: supabaseFrom },
}));

import { saveQuote } from '../commissions';

describe('saveQuote gateway fail-closed behavior', () => {
  beforeEach(() => {
    callGateway.mockReset();
    supabaseFrom.mockReset();
  });

  it('does not fall back to a direct table insert when the gateway rejects a quote', async () => {
    callGateway.mockResolvedValue({
      data: null,
      error: { message: 'Forbidden: verified agent account required' },
    });

    const result = await saveQuote({
      agent_id: 'agent-from-client',
      client_id: null,
      client_name: '',
      product_type: 'CAR',
      status: 'SENT',
      premium_estimate: 1_250_000,
      quote_data: { province: 'DKI Jakarta' },
    });

    expect(result).toBeNull();
    expect(supabaseFrom).not.toHaveBeenCalled();
  });
});
