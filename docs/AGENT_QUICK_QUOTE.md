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

The quick quote is an estimate only. Vehicle base pricing uses the active OJK rate set (or the compiled SEOJK fallback when no active set is available); insurer product configuration contributes eligibility, policy cost, stamp duty, commission rate, and discount ceiling. The repository does not currently contain a separate proprietary rating table for each insurer, so this flow must not claim to reproduce an insurer's private underwriting rate or represent the estimate as an insurer-confirmed final premium. The selected insurer's approved rates, underwriting decision, eligibility, wording, exclusions, documents, and final premium must be confirmed in the relevant application/insurer workflow. The PDF uses the selected insurer's configured logo_url as its document identity on every page and fails closed if that asset is missing or cannot be loaded. Admins must ensure each configured logo URL points to the insurer's official approved asset. The quotation remains subject to insurer acceptance and is not a policy or proof of cover.

The current quote builder's local calculation is not a substitute for server-side premium validation or an insurer-specific product requirements engine. This document does not certify insurer compliance or security.

## Separate pricing-integrity follow-up

The existing `create_policy_order` gateway recalculates the payable total from submitted premium components, but the inspected implementation does not independently derive the OJK base premium from authoritative rate tables in that action. Therefore this Quick Quote change must not be described as making all purchase pricing tamper-proof. A separate, insurer-approved server-side rating implementation is required before treating the premium calculation as fully authoritative. Do not invent or infer insurer-specific rates, eligibility, discounts, or underwriting rules in this change.

## Regression checks

- OJK zone mapping is tested for representative provinces in `services/__tests__/surepath.test.ts`.
- Vehicle quick quote requires a supported registration province before proceeding or generating a quotation slip.
- The Agent Quote Builder must not call direct policy-creation or commission-creation APIs.
