// Pure validation for the agent quote-save gateway action.
// Kept free of Deno/Supabase imports so the same rules can be unit-tested in Vitest.

export const ALLOWED_QUOTE_PRODUCTS = new Set([
  'CAR', 'MOTOR', 'MOTORCYCLE', 'TRAVEL', 'PA', 'MPAR',
]);

export interface QuoteSaveInput {
  productType: string;
  premiumEstimate: number;
  quoteData: Record<string, unknown>;
  clientId: string | null;
  clientName: string;
}

export type QuoteSaveValidation =
  | { ok: true; value: QuoteSaveInput }
  | { ok: false; status: number; error: string };

export function validateQuoteSaveInput(params: Record<string, unknown>): QuoteSaveValidation {
  const productType = String(params.product_type ?? '').toUpperCase();
  if (!ALLOWED_QUOTE_PRODUCTS.has(productType)) {
    return { ok: false, status: 400, error: 'Invalid quote product type' };
  }

  const premiumEstimate = Number(params.premium_estimate);
  if (!Number.isFinite(premiumEstimate) || premiumEstimate < 0) {
    return { ok: false, status: 400, error: 'Invalid quote premium estimate' };
  }

  const quoteData = (params.quote_data ?? {}) as unknown;
  if (!quoteData || typeof quoteData !== 'object' || Array.isArray(quoteData)) {
    return { ok: false, status: 400, error: 'Invalid quote data' };
  }

  let quoteDataSize: number;
  try {
    quoteDataSize = new TextEncoder().encode(JSON.stringify(quoteData)).byteLength;
  } catch {
    return { ok: false, status: 400, error: 'Invalid quote data' };
  }
  if (quoteDataSize > 64 * 1024) {
    return { ok: false, status: 413, error: 'Quote data exceeds the 64 KB limit' };
  }

  const rawClientId = params.client_id;
  if (rawClientId != null && rawClientId !== '') {
    if (typeof rawClientId !== 'string' || rawClientId.length > 128) {
      return { ok: false, status: 400, error: 'Invalid client reference' };
    }
  }

  const rawClientName = params.client_name;
  if (rawClientName != null && typeof rawClientName !== 'string') {
    return { ok: false, status: 400, error: 'Invalid client name' };
  }

  return {
    ok: true,
    value: {
      productType,
      premiumEstimate,
      quoteData: quoteData as Record<string, unknown>,
      clientId: typeof rawClientId === 'string' && rawClientId.trim() ? rawClientId.trim() : null,
      clientName: typeof rawClientName === 'string' ? rawClientName.trim().slice(0, 120) : '',
    },
  };
}
