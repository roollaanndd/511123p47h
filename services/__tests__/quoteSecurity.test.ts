import { describe, expect, it } from 'vitest';
import { validateQuoteSaveInput } from '../../supabase/functions/_shared/quoteSecurity';

describe('agent quote save input validation', () => {
  it('normalizes a valid optional-customer quote payload', () => {
    const result = validateQuoteSaveInput({
      product_type: 'car',
      premium_estimate: 1_250_000,
      client_id: null,
      client_name: '  ',
      quote_data: { province: 'DKI Jakarta' },
      status: 'CONVERTED',
      agent_id: 'client-controlled-agent-id',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.productType).toBe('CAR');
    expect(result.value.premiumEstimate).toBe(1_250_000);
    expect(result.value.clientId).toBeNull();
    expect(result.value.clientName).toBe('');
    expect(result.value.quoteData).toEqual({ province: 'DKI Jakarta' });
  });

  it('rejects unsupported product types and invalid premium values', () => {
    expect(validateQuoteSaveInput({
      product_type: 'UNSUPPORTED',
      premium_estimate: 100,
    })).toMatchObject({ ok: false, status: 400 });

    expect(validateQuoteSaveInput({
      product_type: 'CAR',
      premium_estimate: Number.NaN,
    })).toMatchObject({ ok: false, status: 400 });

    expect(validateQuoteSaveInput({
      product_type: 'CAR',
      premium_estimate: -1,
    })).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects malformed and oversized quote data', () => {
    expect(validateQuoteSaveInput({
      product_type: 'CAR',
      premium_estimate: 100,
      quote_data: [],
    })).toMatchObject({ ok: false, status: 400 });

    expect(validateQuoteSaveInput({
      product_type: 'CAR',
      premium_estimate: 100,
      quote_data: { note: 'x'.repeat(65 * 1024) },
    })).toMatchObject({ ok: false, status: 413 });
  });

  it('rejects malformed client references and names', () => {
    expect(validateQuoteSaveInput({
      product_type: 'CAR',
      premium_estimate: 100,
      client_id: { id: 'foreign-client' },
    })).toMatchObject({ ok: false, status: 400 });

    expect(validateQuoteSaveInput({
      product_type: 'CAR',
      premium_estimate: 100,
      client_name: { name: 'injected' },
    })).toMatchObject({ ok: false, status: 400 });
  });
});
