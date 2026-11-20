# Public climb targets — #7862

Campaign: `bugbash7844`, epic #7844. Evidence collected November 20, 2026. App-source checkpoint: `91e8a87483d0f1c688ac08d1ab505155a9401dde`; baseline: main `f4f504253dff167918796b41ca805d2cc7e48549`.

## Changes and decisions

- The real Home and board breadcrumb anchors now have minimum 44×44px hit areas. The climb-facts setter anchor uses MUI styling through `LocaleLink`. Breadcrumb flex items stay bounded, long tokens wrap, and the current crumb remains plain `aria-current="page"` text.
- The same measured floor covers list pagination, setter pagination and related links, setter Share, footer links, the footer brand and the app CTA. These changes address measured controls in the audited journey.
- The compact language trigger and fallback have a 44px floor. All six menu rows retain MUI's 48px phone height; the desktop floor is 44px.
- Settled hover measurements justified changing the existing shared non-contained primary-button rule to use the existing `--color-primary-hover` foreground for enabled primary controls. Contained, disabled and other-colour buttons are excluded. The palette and hover backgrounds are preserved.
- Existing localized destinations, JSON-LD and page hierarchy are preserved. There are no new routes, user-facing strings, metadata or sitemap entries. The earlier angle-pill and public neutral-token changes remain covered by their existing source guards.

## Verification

The committed eight runtime files were temporarily overlaid with their baseline versions from `f4f504253d`; the audit helper stayed at `91e8a87483`. The runtime files were then restored byte for byte to the committed app-source checkpoint before the after runs.

1. The [baseline guard log](public-targets-7862/red-root.log) records the fixture passing and both real journeys failing on the Home breadcrumb's 16px anchor height. This proves the actual guard detects the original deficit at both widths.
2. The [baseline capture log](public-targets-7862/baseline-root.log) records two completed capture sets in 33.9 seconds. The [after capture log](public-targets-7862/after-root.log) records two sets in 21.6 seconds. A completed baseline collection is evidence collection, not an accessibility pass.
3. The [restored guard log](public-targets-7862/green-no-dev-overlays-root.log) records 3/3 passing in 28.7 seconds: the deliberate audit fixture and the 390px and 1440px list → climb → setter journeys. The journeys check actual destinations, enabled target geometry, settled hover contrast, keyboard focus, one visible H1 and no horizontal overflow. The DOM-only long-token stress also passes.
4. An initial restored phone attempt could not open the language menu because the Next.js development badge intercepted its click. The guard now hides only the Next.js development portal and translation-editor controls before each test; the final run above passed. Those same development controls were hidden consistently in all before/after PNGs.
5. The app-source checkpoint passed `vp run typecheck`: 65/65 workspace tasks, including the production build and package TypeScript checks. The final branch pipeline is run separately before publication.
6. The new automatic PR check reuses that production Next build and a disposable database from the existing digest-pinned development image. All 22 Chromium checks passed in 35.3 seconds with zero retries, including a real public playlist and both entity journeys. Two workflow-routing contract tests, scoped lint and shell syntax passed. The existing manual/nightly E2E workflows are unchanged. Hosted cache restoration remains subject to the published PR's CI run.

## Durable browser evidence

All captures use Chromium, the same seeded routes and matched 390×900 or 1440×900 viewports. The journey is the default Kilter list → `Floats Your Boat` → `/setter/will_avelar`. The raw receipts record source identities, URLs, geometry, effective colours, unresolved samples and control states. The [after summary](public-targets-7862/after-summary-root.json) is a compact index of the after measurements.

| Viewport | List | Climb | Setter | Raw receipts |
| --- | --- | --- | --- | --- |
| 390×900 | [Before](public-targets-7862/baseline-390-list.png) · [After](public-targets-7862/after-390-list.png) | [Before](public-targets-7862/baseline-390-climb.png) · [After](public-targets-7862/after-390-climb.png) | [Before](public-targets-7862/baseline-390-setter.png) · [After](public-targets-7862/after-390-setter.png) | [Before JSON](public-targets-7862/baseline-390.json) · [After JSON](public-targets-7862/after-390.json) |
| 1440×900 | [Before](public-targets-7862/baseline-1440-list.png) · [After](public-targets-7862/after-1440-list.png) | [Before](public-targets-7862/baseline-1440-climb.png) · [After](public-targets-7862/after-1440-climb.png) | [Before](public-targets-7862/baseline-1440-setter.png) · [After](public-targets-7862/after-1440-setter.png) | [Before JSON](public-targets-7862/baseline-1440.json) · [After JSON](public-targets-7862/after-1440.json) |

All six after visits have zero undersized enabled audited targets, zero resolved non-exempt text contrast failures, zero horizontal overflow, one visible H1 and zero browser page errors. The audited link/button counts include main content, header and footer: 85/113/83 for phone list/climb/setter and 90/118/88 for desktop. The opened portal menu is checked separately. Eight keyboard-driven focus samples pass the visible 2px outline and 3:1 contrast requirements.

Representative individual target measurements:

| Control | Baseline | After |
| --- | --- | --- |
| Home breadcrumb | 66.94×16px | 66.94×44px |
| Board breadcrumb | 137.09×16px | 137.09×44px |
| Climb-facts setter anchor | 133.36×41px | 165×48px phone; 171×48px desktop |
| Settled setter Share | 43.421875×43.421875px | 44×44px |
| Each language menu row | 128×48px phone; 128×36px desktop | 128×48px phone; 128×44px desktop |

The baseline also records the 32px-high list Next control, 24px-high setter pagination/related links, a 39px-high phone footer brand, a 40px-high footer app CTA, narrow About/Help/Legal anchors and a 32px-high language trigger. Each enabled audited control meets 44×44px after the change. The Share receipts record `transform: none` and opacity 1 on the control and every ancestor in both states; the original fractional box is not attributed to animation.

The five deliberately settled hover comparisons produce the same minimum ratios at both widths:

| Control | Baseline contrast | After contrast |
| --- | --- | --- |
| List Next page | 3.1577:1 | 4.7252:1 |
| Plain list Google Play | 3.1577:1 | 4.7252:1 |
| Footer app CTA | 3.7761:1 | 5.6505:1 |
| Language trigger | 3.7761:1 | 5.6505:1 |
| Branded setter Google Play | 3.9290:1 | 5.8793:1 |

These are computed foreground-over-effective-background measurements after CSS transitions settle. The guard associates every rendered label sample with the actual hovered control; unrelated page text cannot supply its passing result.

## Limits and acceptance

- The baseline setter audit captured 32 phone/37 desktop targets, while the after audit captured 83/88. The baseline PNGs contain 50 climb rows, but the raw audit and screenshot were taken at different SSR/hydration stages. The setter evidence supports the individual measured deficits above; it does not establish equal before/after target populations. Both raw receipts are retained.
- The native disabled Previous button still measures 2.7006:1. Only text inside native `button:disabled` uses the [WCAG inactive-control exception](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). Adjacent metadata, enabled controls and `aria-disabled` text remain subject to 4.5:1.
- Two phone/eight desktop header text samples per visit remain unresolved because of the filtered background. Image, gradient, filter and opacity cases are explicitly unresolved where effective contrast cannot be established. Unknown samples do not receive passing results; neither do unknown focus backgrounds.
- This is evidence for the seeded Chromium journey and explicit stress states. It is not full-site, physical-device Safari, assistive-technology or complete image-rendering coverage: the capture waits for fonts but does not await image decoding. Both desktop climb PNGs show an incomplete board image; the phone baseline is blank while the after capture shows holds. These captures do not establish a renderer regression or complete visual-page validation. The seeded discussion is empty, so comment avatar/author targets remain unmeasured. Earlier November 19 observations came from a shared development preview whose temporary receipts are no longer available; no acceptance claim relies on them.
- Acceptance still requires two distinct post-publication Astra reviews, covering code and design. The five rubric checks are contrast, tap targets, focus/destinations, phone wrapping and hierarchy, each scored 0–2. The required score is at least 8/10 **and** every enabled audited target must meet 44×44px and every resolved non-exempt readable-text sample must meet 4.5:1. No score overrides either threshold. This record assigns no review score; final source validation and the published reviews remain required before readiness.
