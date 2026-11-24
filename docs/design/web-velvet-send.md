# Web (consuming Velvet Send)

How `packages/web` consumes the Velvet Send tokens. It moved here from [ai-design-guidelines.md](ai-design-guidelines.md), which describes the system itself.

The main web UI renders Velvet Send in **dark only**, on the same neutral **Graphite** surfaces as the app's
Material variant: www and the Expo browser app at `/app` share one page, one card and one set of labels, so
there is no seam between them. Violet is for action and state only: links and text actions, the one filled
CTA, focus, and the tonal container under a selected or current item. Kiosk screens have a scoped
Light / Dark choice, described below; it does not change the main web UI. Wiring notes specific to web:

- **One scheme for the main web UI.** There is no site-wide light palette, no `darkTokens`, no colour-mode
  provider and no site-wide theme toggle — they came out with the climbing UI (#4467) and the collapse that
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
  darkest step and `neutral[900]` the lightest. 50–300 are surfaces: `#1A1A1A` / `#262626` / `#2E2E2E`
  (the app's `containers.base` / `high` / `highest`) and a web-owned decorative `#3E3E3E`. 400–900 bear
  text and collapse onto the app's three label tiers: 400 is the tertiary label `#8F8F8F` (4.68:1 on
  `#262626`; keep it off `neutral[200]`, where it is 4.20:1), 500–600 the secondary label `#B0B0B0`, and
  700–900 the label `#EDEDED`. Pure white is not a step: it is 1.17:1 against `#EDEDED`. The numeric
  keys are a known wart — renaming them to semantic names is a follow-up.
- **Shared source of truth.** The brand palette, surface anchors and colour helpers (`brandColors`,
  `brandColorsDark`, `materialSurfaces`, `materialSurfaceContainers`, `materialTonalContainers`,
  `materialOutline`, `marketingSurfaces`, `withAlpha`, `blendOpaque`) live in `@boardsesh/velvet-tokens`.
  Web reads the dark halves; **`brandColors` (light) must not be deleted as dead code** — mobile
  re-exports it and still renders light. Change a brand or surface hex there, not in each app.
- **www is on the app's Graphite surfaces.** `theme-config.ts` imports the page, card, elevated surface,
  labels, separator, fill, outline and tonal container from `@boardsesh/velvet-tokens` instead of
  holding its own literals, and `velvet-tokens-parity.test.ts` asserts the web ladder IS
  `materialSurfaces.dark`. Web still owns what the app has no use for: `primaryHover`, the hover washes,
  `selectedHover`, `surfaceOverlay`, `neutral[300]`, `text.disabled`, overlays and status washes. Video
  renders under `packages/web/scripts/render-*` must not read `semantic.background`: the footage was cut
  on the violet `#110A20` stage, so a render reads a frozen stage colour (and `marketingSurfaces` for its
  ink and accent) until the videos are re-shot. `scripts/frame-screenshots.ts` reads the live
  `materialSurfaces`, so store frames show the current app.
- **The hero video sits in a card.** Until it is re-cut on Graphite, the showcase video's baked
  `#110A20` stage would read as a page-colour mismatch on `#0E0E0E`. It sits in a `#1E1E1E` card with a
  16px radius, a clip and a 1px `--capture-frame` edge (`rgba(255,255,255,0.14)`), so the stage reads as
  footage. App captures use the same edge, so an iOS capture's black screen never reads as a hole.
- **Two synced sources.** `app/theme/theme-config.ts` feeds MUI + direct imports; `app/components/index.css`
  feeds the CSS custom properties read by the `.module.css` files. Every shared colour changes in BOTH —
  the parity test enforces it, plus the MUI split and WCAG contrast.
- **Foreground/fill split — load-bearing forever.** MUI `palette.primary.main` is the FOREGROUND violet
  `#9784FF` (links, text/outlined buttons, selection controls); the FILL ships through an augmented
  `primaryFill` channel (`#7855FF`) used only by filled buttons/FAB. **Never collapse them**: white on
  `#9784FF` is 2.97:1. `primary.contrastText` is the DARK ink (`#16111F`) for the same reason. A dedicated
  test asserts the two are different colours, because with one scheme nothing else says so.
- **The filled CTA stays on low ground.** `#7855FF` keeps a 3:1 edge on `surfaceElevated` `#262626`
  (3.27:1) but not on `neutral[200]` `#2E2E2E` (2.94:1), so a filled button never sits above the elevated
  surface. The parity test pins both numbers.
- **Selected is the tonal container.** `semantic.selected` is the opaque M3 `secondaryContainer`
  `#34276B` with `onSelected` ink `#E1E0FF` on it (9.89:1). Never put the foreground violet on it
  (4.28:1). Its edge is 1.52:1 on the page and 1.31:1 on the card, so a selected toggle also needs a
  non-colour cue (a check). Hover washes, badge grounds and decorative fills have their own roles
  (`hover`, `buttonHover`, `fillSubtle` / `fill` / `fillStrong`), and MUI `action.selected`
  (`selectedRow`) is the neutral fill: MUI paints it under every default filled `<Chip>`, a selected
  `PaginationItem` and the highlighted Autocomplete option, so it must never be violet.
- **Where violet goes, and the recipes that keep it there.** Inline links and text actions
  (`#9784FF`; MUI `Link` defaults to `underline="always"` with a 3px offset, because the underline,
  not the hue, tells a link from body copy), ONE filled `#7855FF` CTA per region (`brandCtaSx`), the
  focus ring, the tonal selected state, the current page's 2px underline in the header, on-states and
  map pins. Everything else is grey:
  - Secondary buttons: `brandCtaOutlinedSx` and MUI `variant="outlined"` primary are a transparent
    pill with the `#EDEDED` label (weight 600 in the recipe), the `--control-border` edge and the
    `--semantic-button-hover` layer on hover. Only a primary `variant="text"` button lifts to violet
    on hover.
  - Filter chips: `filterChipSx`, full pills (buttons are 10px, see below), 44px tall. Rest is transparent with the
    `--control-border` edge and `#EDEDED` ink at weight 500. Selected is `--semantic-selected` with
    `--semantic-on-selected` ink and a leading `SelectedCheck` (`components/ui/selected-check.tsx`);
    no ring. The check is `aria-hidden`; the control announces the state, and which attribute
    depends on what the element is: `aria-pressed` only on a real button (a toggle), `aria-current`
    on a link (the board-type chips, the radius links once a place is picked, the current menu
    locale), and a checkbox's own checked state on the narrower filter tiers.
  - Toggles, segments, pagination and the current menu item: the theme gives `MuiToggleButton` and
    `MuiMenuItem` the same tonal selected state, the gym directory pager draws it by hand, and the
    public toggle groups (the gyms radius, the support cadence and currency, the iOS/Android preview
    switch) and the language menu's current locale add the check. A toggle's hover wash is gated to
    `(hover: hover)` so a tap on a phone does not leave it behind.
  - Nav, footer and breadcrumb links: `#B0B0B0`, lifting to `#EDEDED` with an underline on hover
    (`quietLinkSx` in `components/ui/quiet-link.ts` for breadcrumbs). The header's current page is
    `#EDEDED` with a 2px `#9784FF` underline, never a pill or bar.
- **Input fields.** The `--input-*` family in `index.css` (bg / bg-hover / bg-focused / text / placeholder
  / border / border-hover) is the source of truth for form fields; the MUI theme and the `.module.css`
  files both read it. Fields ride the raised Graphite surface (`semantic.inputSurface`, `#262626`), one
  step above the card, with the label ink `#EDEDED`, the secondary-label placeholder `#B0B0B0`, the
  opaque `#8A8A8A` outline at rest (`#EDEDED` on hover) and a 2px `#9784FF` focus outline (5.09:1 on the
  field). The three `bg` vars hold the same value today on purpose — the border carries hover, the ring
  carries focus — and stay separately named so that can be retuned in one place.
- **The surface ladder is how depth works.** `background #0E0E0E` → `surface #1E1E1E` →
  `surfaceElevated #262626`, with one hairline (`--separator`). On near-black a drop shadow does almost
  nothing; a card is a lighter grey (1.16:1 on the page, plus the hairline), not a shadowed panel. The
  parity test asserts the luminance order.
- **Two border tokens, and you pick by ROLE not by looks.** `--separator`
  (`rgba(255,255,255,0.12)`) is DECORATIVE: dividers, hairlines, rules, image frames, the edge of a
  non-interactive card or badge. `--control-border` (`#8A8A8A`, the M3 outline) is the visual boundary
  of an INTERACTIVE thing: outlined buttons, chips, toggles, pagination pills. WCAG 1.4.11 wants ≥3:1
  for those, and `--separator` composites to 1.36–1.46:1 on our surfaces, so it cannot serve — which
  matters because these controls' fill is `surface` on `background` (1.16:1), i.e. the border is the
  only affordance. `--control-border` is **opaque on purpose**: a translucent border's contrast
  depends on its backdrop, so it can pass on the page and fail on a card and no single test can pin
  it. Opaque makes it one fact — 5.59:1 on `background`, 4.83:1 on `surface`, 4.38:1 on
  `surfaceElevated` and 3.93:1 on `neutral[200]` (worst case). The parity test fences both tokens on
  every surface step, including that `--separator` stays *below* 3:1 — that is its job, not a bug to
  fix.

**Shared across web and mobile:** the brand palette + colour helpers (`@boardsesh/velvet-tokens`) and the
climbing **grade colours** (`@boardsesh/board-constants`). Both are platform-agnostic and stay shared.

## Kiosk appearance

Each gym kiosk can use **Light** or **Dark**, selected in its editor. The choice lives in that kiosk's
persisted `layout.theme` (`light` or `dark`), alongside its boards and leaderboard settings. New kiosks,
older layouts without the field, and invalid theme values read as `dark`. This is an explicit screen
setting, independent of the viewer's OS appearance and other kiosks at the same gym.

The public server render and the editor's live preview use the same scoped kiosk theme. Switch the
whole palette together: background, raised panels, text, borders, overlays and attribution. Resolve gym
accents against the selected surfaces and adjust contrast in either direction as needed; a pale accent
that works on dark cannot be assumed readable on white. Preserve uploaded logos' colours and alpha.
Dark lettering in a logo may need Light appearance to stay readable; do not recolour the logo itself.

Board rasters follow the same selection. Pass `boardFieldColorForScheme(layout.theme)` from
`@boardsesh/board-look` to the renderer's `field_color` for both the server seed and live updates.
The shared Aura look already turns off the dark veil against the white Light field. The editor
preview must update its rasters when the unsaved theme changes, including when the wall is clear.

Keep the exception inside the kiosk theme scope. The manage page remains dark, and the gym-level
`brandBackgroundColor` does not choose a kiosk's appearance. No global theme provider, OS-driven CSS
branching or arbitrary custom background picker is needed.


## Public page frame

Public pages share a 1136px content grid within the 1200px padded frame. Long copy uses a 720px reading measure aligned to the same left edge as the logo; compact screens use the shared 24px gutters (16px below 360px). PageShell owns page width and fixed-header clearance. Cards use surface and surfaceElevated, never the page root. Help and long-form reading surfaces use the same page tokens as everything else (`--semantic-background`, `--semantic-surface`, `--neutral-900`, `--neutral-500`, `--neutral-200`); the separate `--read-*` set is gone.

Display headings use the bundled Geist variable font through next/font/local. Its SIL Open Font License is adjacent to the font files. Body text retains the system font. H1 is 44px/32px, H2 30px/24px and the home Display is 64px/40px, with 1.1 heading line-height. Action controls keep at least 44px touch targets. Use the shared brand button recipes (`brandCtaSx`, `brandCtaOutlinedSx`); only the page's primary action is filled.

Button corners are 10px (`borderRadius.button`), the same as inputs and the segmented toggle, and cards are 12px. Chips and filters stay full pills: the round end marks a tag, not an action. Until 2026-11 every button was a full pill too, and beside the cards and inputs a 48px control with round ends and a hairline outline read as a capsule rather than a button. The mobile app keeps its capsules because there they are Liquid Glass and Material system controls; www has no glass to carry that shape.
