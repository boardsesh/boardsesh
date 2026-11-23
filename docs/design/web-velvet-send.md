# Web (consuming Velvet Send)

How `packages/web` consumes the Velvet Send tokens. It moved here from [ai-design-guidelines.md](ai-design-guidelines.md), which describes the system itself.

The web app renders Velvet Send in **dark only**. Wiring notes specific to web:

- **One scheme, no branching.** `packages/web` has no light palette, no `darkTokens`, no colour-mode
  provider and no theme toggle — they came out with the climbing UI (#4467) and the collapse that
  followed. `themeTokens` in `app/theme/theme-config.ts` *is* the dark set, `mui-theme.ts` exports a
  single `darkTheme`, and `index.css` has one `:root` block. Two fences in
  `app/theme/__tests__/velvet-tokens-parity.test.ts` keep it that way: one fails if an
  `html[data-theme=…]` or `prefers-color-scheme` block reappears in the CSS, the other if `:root`
  loses `color-scheme: dark` (which is what makes scrollbars, `<select>` popups, date pickers and
  autofill draw dark — nothing else does).
- **Direct token reads are now correct.** A `themeTokens.colors.*` or `themeTokens.neutral.*` read
  used to render the *light* value regardless of scheme, so the guidance was to route everything
  through a CSS var. That is no longer true — the constants and the vars hold the same values. Use
  whichever fits: `themeTokens` in TS/`sx`, `var(--color-primary)` and friends in `.module.css`.
- **Read the neutral ramp darkest-first.** On a dark scheme the ramp inverts: `neutral[50]` is the
  darkest step (`#1E1434`) and `neutral[900]` the lightest (`#F3EFFA`). 50–300 are surfaces; 400–900
  bear text. The numeric keys are a known wart — renaming them to semantic names is a follow-up.
- **Shared source of truth.** The brand palette, surface anchors and colour helpers (`brandColors`,
  `brandColorsDark`, `materialSurfaces`, `marketingSurfaces`, `withAlpha`, `blendOpaque`) live in
  `@boardsesh/velvet-tokens`. Web reads only `brandColorsDark`; **`brandColors` (light) must not be
  deleted as dead code** — mobile re-exports it and still renders light. Change a brand hex there, not
  in each app.
- **www keeps its violet surfaces on purpose.** The app's Material surfaces went neutral grey
  ("Graphite"); the web page → card → elevated ladder in `theme-config.ts` did not, and
  `velvet-tokens-parity.test.ts` asserts the two stay different. The `packages/web/scripts/render-*`
  video scripts read `marketingSurfaces` (the frozen pre-Graphite app values) so they match the footage
  already cut; `scripts/frame-screenshots.ts` reads the live `materialSurfaces`, so store frames show the
  current app.
- **Two synced sources.** `app/theme/theme-config.ts` feeds MUI + direct imports; `app/components/index.css`
  feeds the CSS custom properties read by the `.module.css` files. Every shared colour changes in BOTH —
  the parity test enforces it, plus the MUI split and WCAG contrast.
- **Foreground/fill split — load-bearing forever.** MUI `palette.primary.main` is the FOREGROUND violet
  `#9784FF` (links, text/outlined buttons, selection controls); the FILL ships through an augmented
  `primaryFill` channel (`#7855FF`) used only by filled buttons/FAB. **Never collapse them**: white on
  `#9784FF` is 2.97:1. `primary.contrastText` is the DARK ink (`#16111F`) for the same reason. A dedicated
  test asserts the two are different colours, because with one scheme nothing else says so.
- **Input fields.** The `--input-*` family in `index.css` (bg / bg-hover / bg-focused / text / placeholder
  / border / border-hover) is the source of truth for form fields; the MUI theme and the `.module.css`
  files both read it. Fields ride the elevated violet (`semantic.inputSurface`, `#2F234A`) with a 2px
  foreground-violet focus outline. The three `bg` vars hold the same value today on purpose — the border
  carries hover, the ring carries focus — and stay separately named so that can be retuned in one place.
- **The surface ladder is how depth works.** `background #110A20` → `surface #251B3A` →
  `surfaceElevated #2F234A`, with one hairline (`--separator`). On near-black a drop shadow does almost
  nothing; a card is a lighter violet, not a shadowed panel. The parity test asserts the luminance order.
- **Two border tokens, and you pick by ROLE not by looks.** `--separator`
  (`rgba(185,170,215,0.2)`) is DECORATIVE: dividers, hairlines, rules, image frames, the edge of a
  non-interactive card or badge. `--control-border` (`#837A9C`) is the visual boundary of an
  INTERACTIVE thing: outlined buttons, chips, toggles, pagination pills. WCAG 1.4.11 wants ≥3:1 for
  those, and `--separator` composites to 1.43–1.50:1 on our surfaces, so it cannot serve — which
  matters because these controls' fill is `surface` on `background` (1.19:1), i.e. the border is the
  only affordance. `--control-border` is **opaque on purpose**: a translucent border's contrast
  depends on its backdrop, so it can pass on the page and fail on a card and no single test can pin
  it. Opaque makes it one fact — 3.58:1 on `surfaceElevated` (worst case), 4.03:1 on `surface`,
  4.81:1 on `background`. Don't reach for `neutral[400]` here; it lands at 2.72:1 on `surfaceElevated`.
  The parity test fences both tokens, including that `--separator` stays *below* 3:1 — that is its
  job, not a bug to fix.

**Shared across web and mobile:** the brand palette + colour helpers (`@boardsesh/velvet-tokens`) and the
climbing **grade colours** (`@boardsesh/board-constants`). Both are platform-agnostic and stay shared.


## Public page frame

Public pages share a 1136px content grid within the 1200px padded frame. Long copy uses a 720px reading measure aligned to the same left edge as the logo; compact screens use the shared 24px gutters (16px below 360px). PageShell owns page width and fixed-header clearance. Cards use surface and surfaceElevated, never the page root. Help and long-form reading surfaces may use the existing graphite reading tokens with a violet header; marketing and directories use the background token.

Display headings use the bundled Geist variable font through next/font/local. Its SIL Open Font License is adjacent to the font files. Body text retains the system font. H1 is 44px/32px, H2 30px/24px and the home Display is 64px/40px, with 1.1 heading line-height. Action controls keep at least 44px touch targets. Use the shared brand button recipes (`brandCtaSx`, `brandCtaOutlinedSx`); only the page's primary action is filled.

Button corners are 10px (`borderRadius.button`), the same as inputs and the segmented toggle, and cards are 12px. Chips and filters stay full pills: the round end marks a tag, not an action. Until 2026-11 every button was a full pill too, and beside the cards and inputs a 48px control with round ends and a hairline outline read as a capsule rather than a button. The mobile app keeps its capsules because there they are Liquid Glass and Material system controls; www has no glass to carry that shape.
