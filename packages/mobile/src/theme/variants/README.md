# UI variants (Material 3 ↔ Apple HIG / Liquid Glass)

The mobile app renders in two design languages and keeps both: `liquidGlass`
(Apple HIG / iOS 26 Liquid Glass) and `material` (Material 3 / Android). The user
can force either in Settings, so **variant is a runtime choice, not the platform**.

This directory is the home for the small set of building blocks that keep variant
differences out of render bodies. The goal: every variant difference is **data in
a typed map resolved once by the provider**; the only `variant === '…'` left is in
the provider, swap routers, and `selectByVariant` maps.

## Four orthogonal axes — never conflate them

| Axis                                  | Question                           | Read from                                                                                                                                                                                     |
| ------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Aesthetic variant**              | Which design language?             | `theme.variant` (`'liquidGlass' \| 'material'`) — user can force it                                                                                                                           |
| **B. Colour scheme**                  | Light or dark?                     | `theme.colorScheme`                                                                                                                                                                           |
| **C. Effective rendering capability** | What can this device render _now_? | `useEffectiveSurfaceMode()` (glass/blur/material/solid), `useNativeTabBar()` — "which impl is actually on screen", e.g. an iOS < 26 Liquid-Glass device degrades to `blur` and the JS tab bar |
| **D. Raw platform**                   | A literal OS / native-API fact?    | `Platform.OS`                                                                                                                                                                                 |

**Governing rule for `Platform.OS`:** allowed **only** when the truth it expresses
stays true if the user force-switches variants (HealthKit, BLE permissions, native
Maps, Share payloads, gorhom containers, `KeyboardAvoidingView`). If flipping the
variant toggle _should_ change the behaviour, it is **axis A** — read `theme.variant`
or a token, never `Platform.OS`. (This is the bug class fixed in `SectionHeader` /
`FeedSectionLabel`: `Platform.OS === 'ios'` stood in for "is this the HIG look".)

**Axis C is not axis A.** `AccessoryBarSurface` correctly consults both
(`mode === 'material' || variant === 'material'`) — leave it. Do not back any
variant primitive with surface mode.

## Decision tree — what to reach for

1. Capability/rendering difference (glass vs blur; native vs JS tab bar)? → **axis C** hooks. Never key on `variant`.
2. A whole component subtree differs (different RN/Paper elements)? → **component swap** (`createVariantComponent` for small twins; an explicit `index.tsx` router for large folder-split twins).
3. A single value differs and has a **stable, designer-facing name** (action-icon colour policy, chart palette, caption style)? → **token**: add a `…ByVariant` map / resolver in `variant-tokens.ts`, resolve in the provider, read `theme.X`.
4. A layout metric tied to chrome arbitration (reserves, insets, footer padding)? → push into `computeBottomChromeMetrics` and read a named field.
5. Whether a feature/section shows at all, or where it's laid out? → a flag in the `variantFeatures` registry (read via `theme.features`), consumed by a named component (e.g. `ScreenTitle`) — never a bare `variant === 'material' ? null`.
6. A genuinely local, positional one-off? → `selectByVariant(variant, { liquidGlass, material })`.

## The primitives

- **`selectByVariant(variant, { liquidGlass, material })`** — declarative value pick. Maps are `Record<UiVariant, T>`, so a new variant is a compile error at every call site. Prefer a token (step 3) for anything with a name.
- **`useVariantValue({ liquidGlass, material })`** — `selectByVariant` bound to the live `theme.variant`, for a component that doesn't already destructure the theme. Same exhaustiveness + memoisation rules.
- **`createVariantComponent(name, { liquidGlass, material })`** — one public component from two impls with an identical prop API. Renders the chosen impl as JSX so each gets its own fiber/hook list (a live variant flip unmounts one and mounts the other). React 19 `ref` forwards through `{...props}`.
- **`variant-tokens.ts`** — the per-variant token resolvers (`resolveActionColors`, `resolveChartColors`, `sectionCaptionByVariant`, `applySectionCaption`). Shared by the provider and the test mock (`src/test/theme-mock.ts`) so they can't drift.
- **`variant-features.ts`** — the `variantFeatures` registry (`Record<UiVariant, VariantFeatures>`) for content/layout feature gaps (`inBodyLargeTitle`, `filtersInTopChrome`); resolved once as `theme.features`.
- **`assertNever`** (`src/lib/assert-never.ts`) — exhaustiveness guard for the few `switch (variant)` sites in the provider.

## Rules that keep it working

- **Component swaps:** only wrap components whose two impls are already fully-distinct subtrees. A router flips the element _type_ on a variant change, so any `useState` / shared value / scroll / focus held **above** the variant split is lost on flip. Keep those as in-body `selectByVariant`. Never wrap an open-state sheet. Reanimated shared values / gestures must live **inside** each impl.
- **a11y parity:** both impls of a swapped component must keep identical accessibility semantics (role/label/live-region). The shared `*.types.ts` contract won't catch a11y drift — check it by hand.
- **Memoisation:** never pass an inline object literal to `selectByVariant`/`useVariantValue` when the result feeds a `React.memo` child or a `useMemo`/gesture dep — define the map as a module-scope `const`.
- **Synchronous first paint:** every provider-resolved token must derive purely from already-resolved `variant`/`colorScheme`/`systemColors`/`brandColors` inside the single `theme` `useMemo` — never an async/effect path.

## Adding a third variant — the punch-list

Widen `UiVariant` in `../resolve-ui-variant.ts` and the compiler enumerates the work:
every `…ByVariant` map, the `variantFeatures` registry, every `selectByVariant`/`createVariantComponent`
call, and every swap router fails to compile until handled. A **manual** checklist covers the capability
sites the type system can't reach: `resolveSystemColors` and `useEffectiveSurfaceMode`
(guarded by `assertNever`), `theme.m3` (a Paper palette only meaningful on Material), and
axis-D `Platform.OS` sites.

## Scope

Variant is **mobile-only** — no `packages/shared/*-react` package and nothing on web reads
it, so there's nothing to extract per the monorepo's "extract don't duplicate" rule. There is
no visual-regression harness, so the non-default variant (Material-on-iOS, Glass-on-Android) is
covered by manual screenshots, not snapshots.

## Enforcement

A grep/lint gate keeps `variant === '…'` out of `src/components/**` render bodies (allowed only
in `*/index.tsx` routers, `*.glass.tsx`/`*.material.tsx` impls, and `theme/`/`providers/`, plus
the annotated `AccessoryBarSurface` dual-axis exception). It lands as a warning and flips to an
error once the migration reaches zero offenders.
