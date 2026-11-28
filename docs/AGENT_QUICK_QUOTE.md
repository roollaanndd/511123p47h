# Agent Quick Quote — Scope and Guardrails

## Purpose

The Agent Quote Builder supports a low-friction, indicative quote without forcing an agent to create or select a permanent CRM customer record.

## Quick quote flow

1. Select a motor product and choose **Create a quote**.
2. Select an active insurer partner that has an active product configuration for the selected vehicle type. The partner must have a configured official logo asset before a quotation PDF can be generated.
3. Enter the vehicle details and select the registration province from the STNK. The province determines the OJK rate zone; an empty province must never silently be treated as a valid quote input.
4. Enter quick customer details (existing customer, new CRM customer, or one-time customer).
5. Select Comprehensive or TLO, then choose optional coverage extensions.
6. Review the detailed tariff, fees, insurer-configured policy cost/stamp duty, and commission-funded discount ceiling. The chosen insurer is rechecked for coverage and maximum vehicle age before the quote can be saved or printed.
7. Save the quote as a draft, print the insurer-branded PDF, or share the quotation.

A quick quote does not create a customer CRM record, policy, certificate, payment obligation, or commission. A saved-but-unsent quote is stored as `DRAFT`.

## Application and issuance boundary

A customer profile is not a prerequisite for an indicative estimate. It is not optional where the selected insurer's application flow requires customer identity, KYC, consent, supporting documents, vehicle survey, underwriting, payment, or other acceptance conditions.

Actual purchase must use the existing product-specific application wizard. Policy status and commission must be created only by the authorized issuance/approval lifecycle after the insurer's acceptance and required payment/issuance events. The quote builder must not directly insert an ACTIVE policy or commission. The `save_quote` gateway action is agent-only, derives `agent_id` from the authenticated caller, validates product/premium/payload, rate-limits writes, and verifies ownership of any attached CRM customer. Registered agents may save indicative drafts; the existing order-creation gateway continues to enforce agent verification before an application can be submitted. An unverified agent's draft quote is not evidence of appointment, insurer authorization, or authority to bind cover. It always persists a saved quote as `DRAFT`.

## Insurer and pricing disclosure

The quick quote is an estimate only. Vehicle base pricing uses the active OJK rate set (or the compiled SEOJK fallback when no active set is available); insurer product configuration contributes eligibility, policy cost, stamp duty, commission rate, and discount ceiling. The repository does not currently contain a separate proprietary rating table for each insurer, so this flow must not claim to reproduce an insurer's private underwriting rate or represent the estimate as an insurer-confirmed final premium. The selected insurer's approved rates, underwriting decision, eligibility, wording, exclusions, documents, and final premium must be confirmed in the relevant application/insurer workflow. The PDF uses the selected insurer's configured logo_url as its document identity on every page, labels the document as an indicative insurer quotation, and fails closed if that asset is missing or cannot be loaded. Admins must ensure each configured logo URL points to the insurer's official approved asset. The quotation remains subject to insurer acceptance and is not a policy or proof of cover.

The current quote builder's local calculation is not a substitute for server-side premium validation or an insurer-specific product requirements engine. This document does not certify insurer compliance or security.

## Separate pricing-integrity follow-up

The existing `create_policy_order` gateway recalculates the payable total from submitted premium components, but the inspected implementation does not independently derive the OJK base premium from authoritative rate tables in that action. Therefore this Quick Quote change must not be described as making all purchase pricing tamper-proof. A separate, insurer-approved server-side rating implementation is required before treating the premium calculation as fully authoritative. Do not invent or infer insurer-specific rates, eligibility, discounts, or underwriting rules in this change.

## Regression checks

- OJK zone mapping is tested for representative provinces in `services/__tests__/surepath.test.ts`.
- Vehicle quick quote requires a supported registration province before proceeding or generating a quotation slip.
- The Agent Quote Builder must not call direct policy-creation or commission-creation APIs.


## B2B quotation parity

B2B has three distinct quote paths and must not be forced through the agent's single-vehicle OJK calculator:

- **B2B Unit Order:** uses the dedicated B2B fleet rating engine for one vehicle. The quote PDF can be downloaded before batch submission. An insurer must be selected for insurer-branded output; the selected insurer's official logo is mandatory. No Zurich/default insurer is invented when no insurer is selected.
- **B2B Bulk Import:** keeps the detailed per-unit Excel quotation and adds an insurer-branded PDF executive summary. The PDF totals come from the same client-side fleet engine used for the review screen; every unit is recalculated by the gateway when the batch is submitted. The PDF is explicitly indicative and is not a policy or proof of cover.
- **Corporate B2B submissions:** the submission form currently captures aggregate fleet information and other underwritten products, not a complete rated per-unit schedule. Admin/operations must select an active insurer and enter the premium returned by the insurer/underwriter. The gateway resolves the official insurer name and HTTPS logo from `sp_insurers`, rejects inactive insurers or missing logos, and stores the resolved logo metadata in the quote's coverage JSON. The customer PDF uses that logo; internal metadata is hidden from customer coverage details.

For fleet submissions that do not include a validated unit schedule, do not calculate an OJK rate from aggregate fleet value. Use B2B Unit Order or Bulk Import for per-vehicle calculations and server-side repricing.

### B2B insurer authorization boundary

The B2B insurer picker returns active insurers and their configured display logos. An active record and logo do **not** prove that an insurer has approved every B2B product line, risk class, or customer segment. Operations must confirm product authorization and placement authority against the current insurer agreement before issuing a quote. The server validates active status and the configured HTTPS logo, but it does not infer product authorization from `is_active`.


## Corporate B2B insurer routing

Corporate B2B submissions now support an explicit admin-to-insurer underwriting assignment:

- Admins assign a submission to an active insurer only after confirming product-specific insurer authorization has been verified. Active status and a configured logo are not treated as proof of underwriting authority.
- Assignments are stored in `sp_b2b_submission_insurers`, a gateway-only table with RLS enabled and direct `anon`/`authenticated` grants revoked.
- Insurers authenticate through their existing token flow and can only list or respond to assignments belonging to their own insurer ID.
- The insurer portal supports quotation submission, requests for information, and declines. Premium, validity date, coverage notes, and terms are supplied by the insurer; SurePath does not infer them.
- A submitted insurer quotation is stored in the existing `sp_b2b_quotes` table. The assignment ID and server-resolved insurer identity/logo are written into reserved metadata so the client quote view and PDF adapter can use the same record.
- Admin submission cards display assignment status and received offer details. The corporate client quote view and submission status refresh periodically while open.
- Supporting submission documents are exposed to the assigned insurer only through server-generated signed URLs with a five-minute expiry.
- Admin and client notifications are emitted when an insurer requests information, declines, or submits a quotation.

The first version uses an explicit admin attestation for product-specific insurer authorization. It does not yet implement automated insurer appetite/rate matching; that requires a maintained insurer-product authorization matrix and verified underwriting rules.
