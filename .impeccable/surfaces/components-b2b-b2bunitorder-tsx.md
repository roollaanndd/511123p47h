---
version: 1
slug: "components-b2b-b2bunitorder-tsx"
primary_target: "components/b2b/B2BUnitOrder.tsx"
related_targets: ["components/b2b/B2BPlansAdmin.tsx","components/admin/InsurerAdmin.tsx"]
---

Scope: B2B insurer picker + B2B plan cards (Operate surface). Audience: corporate client choosing fleet protection on a desktop/laptop, in a focused task. Job: compare real insurers and plans, then commit a preference. Proof/content: real sp_insurers + sp_b2b_plans records only. Constraints: no invented insurers/prices; keyboard + hover states; admin is source of truth; no green gradient.

THESIS: The picker becomes a tactile clay shelf — soft, pressed porcelain tiles with real depth and per-insurer character — not another flat green-glass card grid. A hover is a physical interaction: the tile lifts, its edge catches light, and a detail face unique to that insurer eases into view.

OWN-WORLD: warm neutral stone ground; tiles are clay bodies with rounded 20–24px corners, a light top rim, a broad low-offset shadow, and a pressed inset when selected. Each insurer carries its own admin-set accent and icon; each plan carries its own accent. Type is the product sans, 700 for names, 11px floor for meta. Depth comes from offset + blur shadows, never a zero-offset colored halo.

STORY: The client immediately sees which insurers are real options and what makes each different. Hover or keyboard focus rewards curiosity with specifics. The chosen tile stays visibly pressed and named. Admin edits color, icon, order, featured flag and highlight bullets; the picker simply reflects that truth.

FIRST VIEWPORT: A quiet heading "Pilih asuransi" with one line of subcopy, then a 2–3 column clay grid. Each tile: logo/icon, insurer name, code, one-line role, select affordance. On hover/focus the tile lifts ~6px, the accent rim brightens, and a detail ribbon expands with 3 admin-written bullets. Selected tile is pressed, not glowing.

FORM: claymorphism, user-pinned, seed: none (pinned) — "ui nya menjadi claymorphism dan tidak ada gradasi warna hijau melainkan menjadi ui yg lebih proper lagi".

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

---

## Shipped contract (v2.9.15)

- Tokens live in `styles.css` under `/* v2.9.15 — Clay picker B2B */`: `.clay-panel`, `.clay-grid`, `.clay-tile`, `.clay-accent-bar`, `.clay-icon-well`, `.clay-featured`, `.clay-detail`, `.clay-bullet`, `.clay-select-row`, `.clay-check`. No gradient, no backdrop blur, no emerald tint on either picker.
- `--clay-accent` is injected per tile from admin data through `normalizeAccent()`. Invalid hex falls back to neutral `#64748B`; no insurer color is invented by the client.
- Hover/focus lift is `translateY(-6px)` with offset+blur shadows; `:focus-visible` keeps an accent outline. Detail ribbon opens on `:hover`, `:focus-visible`, `[aria-pressed="true"]`, and is always visible under `@media (hover: none)`. Reduced motion disables the transitions.
- Admin truth: `sp_insurers.accent_color/icon/sort_order/highlight_bullets/featured` and `sp_b2b_plans.accent_color/icon/featured`, written only through `data-gateway` actions. Bullets are capped at 5 items × 160 chars; icon keys are an allowlist shared by form, gateway, and migration constraints.
- Non-goals kept: premium math, insurer/product truth, and policy data remain server-owned. This surface only presents admin-authored presentation fields.
