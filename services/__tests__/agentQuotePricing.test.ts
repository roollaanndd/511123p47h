import { describe, expect, it } from 'vitest';
import {
  calculateInsurerQuotePricing,
  getInsurerQuoteDiscountCapPercent,
} from '../agentQuotePricing';

const breakdown = {
  total: 5_060_000,
  basePremium: 4_500_000,
  addonPremium: 500_000,
  adminFee: 50_000,
  stampDuty: 10_000,
  rate: 0.025,
  addonsDetail: {},
};

describe('insurer-specific agent quote pricing', () => {
  it('caps discount by both insurer configuration and commission rate', () => {
    expect(getInsurerQuoteDiscountCapPercent({
      base_commission_rate: 0.12,
      max_discount_rate: 0.2,
    })).toBe(12);
  });

  it('adds insurer policy cost and stamp duty, then funds discount from tariff premium', () => {
    const result = calculateInsurerQuotePricing(breakdown, {
      base_commission_rate: 0.2,
      max_discount_rate: 0.15,
      policy_cost: 25_000,
      stamp_duty: 10_000,
    }, 15);

    expect(result).toEqual({
      tariffPremium: 5_060_000,
      policyCost: 25_000,
      insurerStampDuty: 10_000,
      grossPremium: 5_095_000,
      discountCapRate: 0.15,
      discountRate: 0.15,
      discountAmount: 759_000,
      totalPremium: 4_336_000,
    });
  });

  it('does not apply a discount when the insurer has no configured allowance', () => {
    const result = calculateInsurerQuotePricing(breakdown, {
      base_commission_rate: 0.1,
      max_discount_rate: 0,
      policy_cost: 0,
      stamp_duty: 0,
    }, 10);
    expect(result.discountAmount).toBe(0);
    expect(result.totalPremium).toBe(5_060_000);
  });

  it('allows up to 25% only when insurer configuration and commission permit it', () => {
    expect(getInsurerQuoteDiscountCapPercent({
      base_commission_rate: 0.25,
      max_discount_rate: 0.25,
    })).toBe(25);
  });

  it('uses the underwriting default stamp duty when none is configured', () => {
    const result = calculateInsurerQuotePricing(breakdown, {
      base_commission_rate: 0.1,
      max_discount_rate: 0,
      policy_cost: 0,
      stamp_duty: null,
    }, 0);
    expect(result.insurerStampDuty).toBe(10_000);
    expect(result.totalPremium).toBe(5_070_000);
  });

  it('normalizes invalid or negative insurer fees to zero', () => {
    const result = calculateInsurerQuotePricing(breakdown, {
      base_commission_rate: 0.1,
      max_discount_rate: 0.05,
      policy_cost: Number.NaN,
      stamp_duty: -100,
    }, 5);
    expect(result.policyCost).toBe(0);
    expect(result.insurerStampDuty).toBe(0);
    expect(result.discountAmount).toBe(253_000);
  });
});
