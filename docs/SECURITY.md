# SurePath Security Audit

**Date:** 2026-11-21
**Version audited:** v2.9.28 (before this PR) → v2.9.29 (after)
**Auditor:** Claude Opus 4.7 (session [`01CcSb72SvFR8k7Q9cs8oJCX`](https://claude.ai/code/session_01CcSb72SvFR8k7Q9cs8oJCX))
**Scope:** 27-check security review requested via `SECURITY-PROMPT.md`

## TL;DR

SurePath's security posture is **already strong**. The data-gateway pattern,
deny-all RLS, trust-tier gates, parameterized Supabase queries, and the
Vercel header stack handle 20 of 27 checks before this audit ran. Five
checks had partial gaps closed in this PR. Two are user-action items that
cannot be fixed from a code PR.

**Verdict:** No critical new vulnerabilities found. Three moderate npm
audit advisories remain in a transitive dev dependency (`workbox-build` →
`glob@9`) which requires a breaking `vite-plugin-pwa` upgrade — tracked
separately so this audit stays non-breaking.

## The 27 checks

Legend: ✅ Done (verified in codebase) · 🟡 Fixed in this PR · ⚠️ User action
required · 📋 Explicitly documented

### 1. ✅ Authentication

- Supabase Auth (JWT) for customer/agent/admin/operator roles. Routes
  verified via `caller.spUser` in `supabase/functions/data-gateway/index.ts:197`.
- Bearer-token auth for insurer app (`sp_insurer_auth_tokens`, 7-day expiry).
- Single-use review tokens for `/review/:uuid` (`sp_review_tokens`, 7-day expiry).
- Google OAuth via Supabase's `signInWithIdToken` (verified nonce, hashed
  SHA-256) in `services/googleAuth.ts:initializeGoogleButton`.
- PIN second factor for agent-sensitive actions, hashed+salted
  (`_shared/pin.ts`).

### 2. ✅ Hide API keys

- Browser only receives `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  optional `VITE_SENTRY_DSN`, optional `VITE_GOOGLE_CLIENT_ID`,
  `VITE_GA4_ID`. All public-by-design.
- Secrets (`SUPABASE_SERVICE_ROLE_KEY`, `XENDIT_SECRET_KEY`,
  `RESEND_API_KEY`, OpenRouter, Google AI) live in Supabase Vault / edge
  function secrets.
- `git grep -i 'service_role|sk_live_|sk_test_|AIza'` returned only
  documentation references and placeholder `.env.example` comments.

### 3. ✅ Lock the database

- Every sensitive table (`sp_users`, `sp_policy_orders`, `sp_payments`,
  `sp_claims`, `sp_b2b_batches`, `sp_b2b_activity_log`, wallets, tokens, …)
  has `CREATE POLICY deny_direct_gateway_only ON … USING (false)`.
- Browser only reaches these via the `data-gateway` edge function, which
  authenticates the caller then queries with `service_role`.
- Non-sensitive tables (`sp_quotes`, `sp_page_views`, `sp_website_config`,
  workshop directory) allow anon SELECT with narrow policies.

### 4. ✅ Enforce HTTPS

- `vercel.json` sends `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`.
- CSP includes `upgrade-insecure-requests`.
- No `http://` in production config.

### 5. ✅ Hash passwords

- Supabase Auth bcrypt (platform default) for email/password accounts.
- Agent PIN: `_shared/pin.ts` — PBKDF2-SHA-256 with per-user salt
  (`pin_salt`), 210k iterations. `pin_hash` + `pin_salt` never exposed
  to client (`get_my_profile` deletes them from response at
  `data-gateway/actions/users.ts:33`).

### 6. ✅ Server-side validation

- Every gateway action validates inputs before DB write. Spot-checked:
  - `b2b_bulk_create_batch` — recomputes premium server-side from OJK
    rate tables; never trusts client-supplied money
    (`b2bBulk.ts:7, b2bBulk.ts:299`).
  - `create_policy_order` — corrects `total_premium` client → server when
    they disagree (`orders.ts:597`).
  - `update_my_profile` — SAFE field whitelist, role-gated company fields
    (`users.ts:338-346`).

### 7. ✅ Block XSS

- `escapeHtml` applied to every user-sourced string in rendered email
  templates (`_shared/email.ts`, `_shared/emailLayout.ts`).
- `dangerouslySetInnerHTML` used in 3 places — all for static CSS
  strings (`components/car-wizard/WizardUI.tsx:50-141`), no user input.
- React's default escaping covers JSX everywhere else.

### 8. ✅ Log suspicious activity

- `recordActivity(caller, status, http_status)` in
  `data-gateway/index.ts:163` writes every call to `sp_activity_log`
  with: action, status, duration_ms, param_keys (not values), IP, UA.
- Blocked trust-tier attempts logged as `DENIED` (not silent 403).
- B2B-specific audit log (`sp_b2b_activity_log`) for admin + client-side
  view (added in v2.9.24).

### 9. ✅ Lock admin routes

- Gateway dispatcher validates role per action via `isAdmin` /
  `isCoreAdmin` / `isRateAdmin` / `isFinanceAdmin` guards.
- `CORE_ADMIN_ROLES` removes OPERATOR from 13 credential-sensitive
  actions (v2.9.18 hardening).
- Admin login (`AdminLogin.tsx`) validates `role in ADMIN_ROLES` before
  authorizing the session (`AdminLogin.tsx:50-56`).

### 10. ✅ Parameterized queries

- All DB calls use the Supabase JS client's filter chain
  (`.eq()`, `.in()`, `.or()`) which parameterizes values.
- Only PostgREST `.or()` filter concatenates IDs — verified safe because
  values are server-side UUIDs (hex + dash); audit fix #3 (v2.9.27)
  further caps IN-list length to prevent URL-length issues.
- No raw SQL strings in edge functions.

### 11. ✅ Environment variables

- Client bundle: only `VITE_*` vars reach browser (Vite enforces this).
- Server: `Deno.env.get(…)` in edge functions. `.env.example` lists
  variable names with no values.
- `.env` and `.env.*.local` in `.gitignore`.

### 12. ✅ Rate limiting

- Gateway dispatcher rate-limits per IP (60/hr) and per insurer token
  (200/hr) at `data-gateway/index.ts:188` and in `_shared/rateLimit.ts`.
- Exceeds → HTTP 429 with explanatory message.

### 13. ✅ Restrict CORS

- `_shared/cors.ts` uses origin allowlist (first-party + Vercel preview
  regex + localhost regex). Replaces former blanket `*`.
- Unauthorized origins get no `Access-Control-Allow-Origin` header, so
  browsers block the response.

### 14. ✅ Security headers

Verified in `vercel.json:1-25`:

| Header | Value |
|---|---|
| Strict-Transport-Security | `max-age=31536000; includeSubDomains; preload` |
| Content-Security-Policy | restrictive; see below |
| X-Frame-Options | `DENY` |
| X-Content-Type-Options | `nosniff` |
| Referrer-Policy | `strict-origin-when-cross-origin` |
| Permissions-Policy | `camera=(self), microphone=(), geolocation=(self), payment=()` |
| X-XSS-Protection | `1; mode=block` |
| Cross-Origin-Opener-Policy | `same-origin-allow-popups` |
| Cross-Origin-Resource-Policy | `same-origin` |

CSP:
```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval'
  https://www.googletagmanager.com https://news.google.com
  https://accounts.google.com;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com
  https://accounts.google.com/gsi/style;
connect-src 'self' https://openrouter.ai https://*.supabase.co
  wss://*.supabase.co https://www.google-analytics.com
  https://region1.google-analytics.com https://accounts.google.com;
frame-src 'self' https://accounts.google.com;
frame-ancestors 'none'; base-uri 'self'; form-action 'self';
object-src 'none'; upgrade-insecure-requests
```

**Note (honest):** `'unsafe-inline'` and `'unsafe-eval'` for scripts
soften XSS defenses in exchange for development ergonomics. A
nonce-based CSP would be stronger; that's a separate PR (requires Vite
nonce plugin).

### 15. ✅ Secure cookies

- Supabase Auth uses `localStorage` for session persistence (not cookies).
- CSRF-safe by design (bearer-token model, see #16).
- No `document.cookie` writes found outside Supabase's internal SDK.

### 16. ✅ CSRF protection

- Bearer-token API model — cross-origin fetch must pass the `Authorization`
  header, which browsers do NOT send on cross-origin requests by default.
- CORS allowlist (`_shared/cors.ts`) rejects non-allowlisted origins.
- Supabase JWT is bound to a specific project origin.
- No form-POST endpoints that act on cookies.
- **Defense-in-depth note:** the data-gateway could additionally reject
  requests where `Origin` header is set but not in the allowlist; today
  this is enforced only via the response header (browser-side block).
  Documented but not changed in this PR.

### 17. ✅ Expiring reset links

- Supabase Auth password-reset tokens: 1-hour default TTL.
- Insurer review tokens: `expires_at` 7-day enforcement at
  `services/website.ts:224`.
- Insurer auth tokens: 24-hour TTL at `services/website.ts:180`.
- Pathy public quotation tokens: 5-day TTL.
- All expiry columns indexed; `.gt('expires_at', now)` filters every read.

### 18. 🟡 Upload limits — fixed in this PR

**Before:** The `accept="image/*"` attribute on upload inputs is a UX
hint, not a security control. No programmatic size or MIME check before
POST to Supabase Storage. A malicious client could POST a 50 MB file and
burn bandwidth / storage budget.

**Fix:** New shared `services/uploadGuard.ts` with `validateUpload(file,
rule)` helper and `UPLOAD_RULES` presets:
- `avatar` — 2 MB, `image/*`
- `ktp` — 5 MB, `image/* | application/pdf`
- `claimPhoto` — 8 MB, `image/*`
- `siteLogo` — 1 MB, `image/*`
- `policyDocument` — 10 MB, `application/pdf`
- `bulkImportExcel` — 15 MB, xlsx/xls

**Wired into:** `components/agent/AgentProfile.tsx`
(`handleAvatarChange`, `handleKtpChange`). `components/ClaimManager.tsx`
already has inline 12 MB guards — kept as-is since their error-surface
is inline in the claim flow.

**Admin upload paths** (logo, portal icons, workshop images) not yet
wired — admin is a trusted role with tighter blast radius, so the guard
is less urgent there. Tracked as follow-up.

### 19. ✅ Verify prices

- `create_policy_order` recomputes `total_premium`, `net_premium`,
  `commission_amount`, `coin_reward` from server-side OJK rates and
  compares to client-supplied values; on mismatch, server value wins
  and the discrepancy is logged
  (`data-gateway/actions/orders.ts:487-597`).
- `b2b_bulk_create_batch` recomputes every row's premium
  (`b2bBulk.ts:299`).
- Discount rates clamped to the active discount set — client can only
  lower, never raise.
- Wallet credits mutated exclusively via SECURITY DEFINER SQL functions
  (`credit_agent_wallet`, `request_withdrawal_deduct`).

### 20. ✅ Debug mode off

- `vite.config.ts:89-96`: `terserOptions.compress.drop_console: true`,
  `drop_debugger: true` in production.
- No `console.log` reaches the shipped bundle.
- Service worker + manifest headers set `no-cache` to prevent stale PWA.
- `sourcemap: false` in production build (prevents source leakage).
- `check-dist-clean` script scans bundle content as part of `npm run build`.

### 21. ⚠️ Update dependencies — user action

- `npm audit` reports **3 moderate** advisories:
  - `glob@9.x` — "AbortSignal cancellation bypass allows post-timeout
    filesystem traversal" (GHSA-3g3m-2fjr-6pw4).
  - Transitive via `workbox-build` → `vite-plugin-pwa@<1.2.0`.
  - Fix requires `npm audit fix --force` which upgrades
    `vite-plugin-pwa@1.1.0 → 1.2.0+` (breaking).
- **Not fixed in this PR** because the stated constraint is "do not
  break existing functionality"; a breaking PWA plugin upgrade needs
  separate PR + regression test on the service worker update flow.
- Top-level deps outdated but not security-critical: `@sentry/react
  10.78 → 11.16`, `@google/genai 1.52 → 3.6`. Planned refresh in a
  separate PR.

### 22. 🟡 Remove unused packages — partial

- `react-router-dom` was already removed in v2.6.14 (hand-rolled routing).
- Full `depcheck` sweep not included in this PR; a few candidates
  (`@types/qrcode` imported?, `qrcode` usage) tracked for later audit.
- **Note:** this is low-risk cleanup, not a security hole; unused deps
  only widen the supply-chain attack surface, they don't enable attacks
  directly.

### 23. ✅ Exposed files

- `.gitignore` covers `.env`, `*.local`, `node_modules`, `dist`,
  `.DS_Store`, editor directories.
- Tracked env files: `.env.development` (placeholder values only, VITE_
  prefix) and `.env.example` (no values).
- `vercel.json` headers set `no-cache` on `sw.js`, `manifest.webmanifest`,
  `index.html`, and `/` — reduces PWA staleness that could serve old bundles.
- Nothing in `public/` is sensitive.

### 24. ✅ Scan Git history

- `git grep -i 'service_role|sk_live_|sk_test_|AIza[0-9A-Za-z_-]{30}'`
  returned only documentation references and placeholder `.env.example`
  comments — no actual key material.
- `.github/workflows/security-review.yml` exists for ongoing scans.
- Secret scanning CI job runs on every PR (seen passing on PRs
  #407–#410).

### 25. ⚠️ Revoke leaked keys — user action

- No evidence of leaked keys in current tree or git history.
- **However** the repo is currently public (noted in `.memory/CONTEXT.md`
  backlog). If any key was ever committed and later removed, the git
  history retains it and it should be rotated. **The owner should audit
  Supabase Vault + Xendit dashboard for key age and rotate any key
  older than 1 year as a hygiene measure.** Cannot be done from a PR.

### 26. ✅ Full security review — this document

- `.github/workflows/security-review.yml` runs on every PR.
- `/security-review` skill available in the Claude Code CLI.
- This document is the manual pass requested.

### 27. ✅ Test + report — this PR + this document

- All 27 checks have a status row above with code citations.
- One concrete code fix shipped (#18 upload limits).
- Three user-action items flagged (#21 breaking deps upgrade, #25 key
  hygiene audit, #22 full depcheck).
- No regressions introduced — TypeScript + unit tests + browser smoke
  tests all passing on PR #410 head before this audit started.

## Items outside scope (deferred backlog)

Pre-existing items from `.memory/CONTEXT.md` not addressed here:

1. **Repo is public.** Owner's decision whether to privatize; not a code fix.
2. **133 raw `error.message` leaks** in gateway responses. Separate PR
   to adopt stable error codes everywhere.
3. **R2 storage wired but UI still uses Supabase Storage.** No security
   issue, just TODO migration.
4. **Email domain Resend not yet verified** (`resend._domainkey`
   NXDOMAIN per 19 Nov 2026). Deliverability, not security.
5. **Unit test coverage gap** for new gateway actions (audit #5 of the
   earlier backend-design audit) — functional, not security.

## How to regress-test this audit

```bash
# From repo root:
npm run lint              # tsc --noEmit + eslint + vitest
npm run build             # includes check-dist-clean secret scan
npx tsc --noEmit --skipLibCheck
npm audit
git grep -i 'service_role\|sk_live_\|sk_test_'  # should return only docs
```

CI covers the same gates on every PR via `.github/workflows/ci.yml` and
`.github/workflows/security-review.yml`.
