# Agent Quick Quote — Scope and Guardrails

## Purpose

The Agent Quote Builder supports a low-friction, indicative quote without forcing an agent to create or select a permanent CRM customer record.

## Quick quote flow

1. Select a product and choose **Create a quote**.
2. Enter product details.
3. For motor products, select the vehicle registration province from the STNK. The province determines the OJK rate zone; an empty province must never silently be treated as a valid quote input.
4. Review the indicative estimate.
5. Optionally enter a prospective customer's name, then save, print, or share the estimate.

A quick quote does not create a customer CRM record, policy, certificate, payment obligation, or commission. A saved-but-unsent quote is stored as `DRAFT`.

## Application and issuance boundary

A customer profile is not a prerequisite for an indicative estimate. It is not optional where the selected insurer's application flow requires customer identity, KYC, consent, supporting documents, vehicle survey, underwriting, payment, or other acceptance conditions.

Actual purchase must use the existing product-specific application wizard. Policy status and commission must be created only by the authorized issuance/approval lifecycle after the insurer's acceptance and required payment/issuance events. The quote builder must not directly insert an ACTIVE policy or commission. The `save_quote` gateway action is agent-only, derives `agent_id` from the authenticated caller, validates product/premium/payload, rate-limits writes, and verifies ownership of any attached CRM customer. It always persists a saved quote as `DRAFT`.

## Insurer and pricing disclosure

The quick quote is an estimate only. The selected insurer's product rules, current approved rates, underwriting decision, eligibility, wording, exclusions, documents, and final premium must be confirmed in the relevant application/insurer workflow. Do not attribute a quote to a specific insurer unless that insurer/product has actually been selected and its terms/rates are being used.

The current quote builder's local calculation is not a substitute for server-side premium validation or an insurer-specific product requirements engine. This document does not certify insurer compliance or security.

## Separate pricing-integrity follow-up

The existing `create_policy_order` gateway recalculates the payable total from submitted premium components, but the inspected implementation does not independently derive the OJK base premium from authoritative rate tables in that action. Therefore this Quick Quote change must not be described as making all purchase pricing tamper-proof. A separate, insurer-approved server-side rating implementation is required before treating the premium calculation as fully authoritative. Do not invent or infer insurer-specific rates, eligibility, discounts, or underwriting rules in this change.

## Regression checks

- OJK zone mapping is tested for representative provinces in `services/__tests__/surepath.test.ts`.
- Vehicle quick quote requires a supported registration province before proceeding or generating a quotation slip.
- The Agent Quote Builder must not call direct policy-creation or commission-creation APIs.
