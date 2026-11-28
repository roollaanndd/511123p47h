/**
 * Insurer-specific quote adjustments for the agent's indicative motor quotation.
 *
 * The underlying vehicle tariff is calculated by the shared OJK rate engine.
 * Insurer product configuration then supplies its own policy cost, stamp duty,
 * commission-funded discount ceiling and product eligibility. This mirrors the
 * existing VehicleUnderwritingWizard rules; it does not invent a separate rate.
 */
export interface InsurerQuotePricingConfig {
  base_commission_rate?: number | null;
  max_discount_rate?: number | null;
  policy_cost?: number | null;
  stamp_duty?: number | null;
}

export interface VehiclePremiumInput {
  total: number;
  basePremium: number;
  addonPremium: number;
  adminFee: number;
  stampDuty: number;
  rate: number;
  addonsDetail: Record<string, number>;
}

export interface InsurerQuotePricing {
  tariffPremium: number;
  policyCost: number;
  insurerStampDuty: number;
  grossPremium: number;
  discountCapRate: number;
  discountRate: number;
  discountAmount: number;
  totalPremium: number;
}

const finiteNonNegative = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

/** Keep the quote discount within the same commission-funded cap as underwriting. */
export function getInsurerQuoteDiscountCapPercent(config: InsurerQuotePricingConfig): number {
  const commissionRate = Math.min(0.25, finiteNonNegative(config.base_commission_rate));
  const configuredDiscount = finiteNonNegative(config.max_discount_rate);
  return Math.min(15, Math.max(0, Math.min(configuredDiscount, commissionRate)) * 100);
}

/**
 * Calculates the quote total using the existing OJK engine breakdown plus
 * insurer-configured policy cost and stamp duty. Discount is applied to the
 * tariff premium (the commission-funded component), matching underwriting.
 */
export function calculateInsurerQuotePricing(
  breakdown: VehiclePremiumInput,
  config: InsurerQuotePricingConfig,
  requestedDiscountPercent: number,
): InsurerQuotePricing {
  const tariffPremium = finiteNonNegative(breakdown.total);
  const policyCost = finiteNonNegative(config.policy_cost);
  const insurerStampDuty = finiteNonNegative(config.stamp_duty);
  const discountCapRate = getInsurerQuoteDiscountCapPercent(config) / 100;
  const requestedRate = Math.min(15, Math.max(0, finiteNonNegative(requestedDiscountPercent))) / 100;
  const discountRate = Math.min(requestedRate, discountCapRate);
  const discountAmount = Math.round(tariffPremium * discountRate);
  const grossPremium = tariffPremium + policyCost + insurerStampDuty;

  return {
    tariffPremium,
    policyCost,
    insurerStampDuty,
    grossPremium,
    discountCapRate,
    discountRate,
    discountAmount,
    totalPremium: Math.max(0, grossPremium - discountAmount),
  };
}
