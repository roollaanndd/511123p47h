# B2B Quick Quotation — Implementation Specification

Status: implementation in progress
Target branch: `feat/b2b-quick-quotation`
Base: `main`

## Product intent

Add a fast, client-facing quotation workflow inside the existing B2B portal. This is a quotation tool, not a replacement for B2B Unit Order, Bulk Import, submissions, payments, or policy issuance.

## Non-negotiable constraints

1. Reuse the existing rating engine in `services/b2bFleetRating.ts`; do not introduce a second premium formula.
2. Use the active OJK rate set applied by `services/ojkRates.ts` and the active B2B fleet rate set loaded through `getActiveB2BFleetRateConfig()`.
3. Keep all admin-managed rate configuration in the existing Admin Dashboard and existing tables. No duplicate rate tables or Supabase project.
4. Treat browser calculations as previews only. Any saved or order-converting quotation must be recalculated and validated server-side before it becomes operational.
5. Keep the existing order flow intact. Quick Quotation must not create a batch, invoice, or policy unless the user explicitly converts an accepted quote to an order.
6. Work only on this feature branch. Do not merge to `main` or deploy production as part of feature development.

## Entry point

Add a distinct **Quick Quotation** item under the B2B portal's Create group, separate from **Create order**. It should open an independent quotation screen within the same B2B application shell. Keep existing Unit Order navigation and behavior unchanged.

## User workflow

1. Enter customer/company and vehicle details.
2. Select vehicle class, coverage, territory/zone, vehicle value/OTR, tenor, depreciation, and optional add-ons.
3. Show a live premium preview and a clear itemized breakdown.
4. Choose one of two presentation outputs:
   - Single Vehicle Premium Invoice
   - Multi-Year Insurance Proposal
5. Preview, revise, export, and share the client-facing document.
6. Keep quotation status separate from order status. A later explicit conversion action may create a B2B order through the existing server-side flow.

## Output requirements

The PDF and image export should follow the two supplied SurePath references:
- Single-unit invoice: customer, invoice metadata, vehicle, coverage, itemized premium, discount, policy fee, total payable, payment instructions, notes, and contact footer.
- Multi-year proposal: vehicle summary, depreciation and tenor, rate basis, yearly premium schedule, TPL details, five-year/selected-tenor recap, notes, and contact footer.

The on-screen preview must be interactive: editing an input refreshes the preview and premium figures. PDF and PNG exports must render the same approved preview data; no independent export-only pricing formula.

## Existing rating engine integration

Relevant existing modules discovered:
- `services/b2bFleetRating.ts`: `calcBulkPremium`, `calcFleetAddonPremium`, `selectRate`, active B2B rate config, depreciation schedule, TPL progressive bands.
- `services/ojkRates.ts`: active OJK rate set and zone/category logic.
- `services/b2bBulk.ts`: active B2B fleet rate config retrieval and existing B2B batch service.
- `services/quotationService.ts`: existing quotation snapshot/public-link and PDF workflow.
- `components/b2b/B2BPortal.tsx`: B2B navigation and screen switch.

## Acceptance criteria

- Quick Quotation is visible only in the appropriate B2B client experience; Master Admin monitor mode must not accidentally create client quotes.
- All selected rates/configuration are sourced from the existing active admin-managed rate sets.
- For matching inputs, the premium engine output matches existing B2B unit-order preview calculations.
- TPL is charged according to the existing progressive TPL rate bands and selected limit; it is not silently set to free.
- Policy issuance fee is shown as FREE only when the applicable existing configuration or explicit quote setting says so.
- Discount cap, minimum premium, admin fee, vehicle class rules, and coverage restrictions remain identical to the existing rating engine.
- Multi-year TSI depreciation and premium schedule use the existing engine's compounding behavior and rounding.
- PDF and PNG totals reconcile exactly to the on-screen preview.
- No existing B2B order, batch, payment, or policy workflow is changed.
- TypeScript, lint, unit tests, and build pass before merge.

## Delivery sequence

1. Add the new Quick Quotation screen and isolated navigation entry.
2. Integrate active OJK and B2B fleet configuration with the existing rating engine.
3. Build interactive invoice/proposal previews.
4. Add PDF and PNG export from the same preview model.
5. Add quote save/share and optional conversion to B2B order only after server-side validation is implemented.
6. Add regression tests and submit a pull request for review. No production deployment without approval.
