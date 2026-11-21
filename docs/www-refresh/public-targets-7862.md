# Public climb targets — #7862

Campaign: `bugbash7844`, epic #7844. Evidence collected November 20, 2026. App-source checkpoint: `91e8a87483d0f1c688ac08d1ab505155a9401dde`; baseline: main `f4f504253dff167918796b41ca805d2cc7e48549`.

## Changes and decisions

- The real Home and board breadcrumb anchors now have minimum 44×44px hit areas. The climb-facts setter anchor uses MUI styling through `LocaleLink`. Breadcrumb flex items stay bounded, long tokens wrap, and the current crumb remains plain `aria-current="page"` text.
- The same measured floor covers list pagination, setter pagination and related links, setter Share, footer links, the footer brand and the app CTA. These changes address measured controls in the audited journey.
- The compact language trigger and fallback have a 44px floor. All six menu rows retain MUI's 48px phone height; the desktop floor is 44px.
- Settled hover measurements justified changing the existing shared non-contained primary-button rule to use the existing `--color-primary-hover` foreground for enabled primary controls. Contained, disabled and other-colour buttons are excluded. The palette and hover backgrounds are preserved.
- Existing localized destinations, JSON-LD and page hierarchy are preserved. There are no new routes, user-facing strings, metadata or sitemap entries. The earlier angle-pill and public neutral-token changes remain covered by their existing source guards.

## Verification

The original red/green comparison temporarily overlaid eight committed runtime files with baseline `f4f504253d`; the helper stayed at `91e8a87483`. The runtime files were restored byte for byte before the after runs. [Draft PR #7939](https://github.com/boardsesh/boardsesh/pull/7939) was published at `f4914fad26ca22c18ed69a9b0e2cc33518110d88` before the guard corrections below.

1. The [original baseline guard](public-targets-7862/red-root.log) records the fixture passing and both real journeys failing on the Home breadcrumb's 16px height. The original [baseline](public-targets-7862/baseline-root.log) and [after](public-targets-7862/after-root.log) capture sets completed in 33.9 and 21.6 seconds. Successful baseline collection is not an accessibility pass.
2. The [original restored guard](public-targets-7862/green-no-dev-overlays-root.log) passed 3/3 in 28.7 seconds after hiding only Next.js and translation-editor development controls. This removed a development badge intercepting the language trigger. The same two controls are hidden in all screenshot sets.
3. The post-publication code review found three guard gaps. The [published-helper red proof](public-targets-7862/guard-review/focus-clipping-red.log) reproduces a fully clipped 2px, 21:1 outline incorrectly passing. The current fixture rejects that ring and accepts a padded visible ring. Setter visits now require the real Share button, first linked climb and next-page anchor. The filesystem-backed workflow contract is selected explicitly for `rootCi` changes: its added selection test [failed against the old workflow](public-targets-7862/guard-review/workflow-selection-red.log), while the [current contract run](public-targets-7862/guard-review/workflow-selection-green.log) passed all three tests in 285ms.
4. The stronger [first cold production run](public-targets-7862/guard-review/production-cold.log) passed 20/22; both setter visits lacked linked climbs. [Readiness log excerpts](public-targets-7862/guard-review/fixture-readiness.log) record the server-rendered unlinked-climb fallback while the board catalogue cache filled, and the queued refresh of 47 configurations in 20.632 seconds. The harness now polls the real Kilter data before browser tests, without UI retries or synthetic rows. A fresh database refreshed 47 configurations in 20.119 seconds, then the [production browser run](public-targets-7862/guard-review/production-warm.log) passed 22/22 in 34.2 seconds with zero retries, including the negative/positive focus fixture, populated setter journeys and real playlist.
5. Published checkpoint `f4914fad26` passed `vp run typecheck`: 65/65 workspace tasks, including the production build and package TypeScript checks. The latest guard/CI corrections postdate that run. Their final exact-source pipeline and two updated review verdicts remain pending; this note does not claim they have passed.

## Durable browser evidence

The primary climb comparison below uses matched Chromium development stacks at 390×900 and 1440×900, on the same `Floats Your Boat` route. Each main board image returned HTTP 200 `image/webp`, successfully decoded at 1080×1170 and produced zero browser errors. The source URL includes `include_background=1`. This verifies the main hero art only; beta media, third-party images and thumbnails are outside the decoder check.

| Viewport | Primary climb comparison | Decode receipts |
| --- | --- | --- |
| 390×900 | [Before](public-targets-7862/decoded-climb/baseline-390-climb.png) · [After](public-targets-7862/decoded-climb/after-390-climb.png) | [Before JSON](public-targets-7862/decoded-climb/baseline-390.json) · [After JSON](public-targets-7862/decoded-climb/after-390.json) |
| 1440×900 | [Before](public-targets-7862/decoded-climb/baseline-1440-climb.png) · [After](public-targets-7862/decoded-climb/after-1440-climb.png) | [Before JSON](public-targets-7862/decoded-climb/baseline-1440.json) · [After JSON](public-targets-7862/decoded-climb/after-1440.json) |

The decoded baseline runtime Git source is `6e696a6f04fc6ff527508c3080b26421e686a68a`: its product difference from baseline `f4f504253d` is Help-only, and all climb UI is byte-identical to that baseline. The candidate runtime Git source is `f4914fad26ca22c18ed69a9b0e2cc33518110d88`, whose app UI is byte-identical to `91e8a87483`. The JSON `buildId` values identify production artifacts left by prior full typechecks, not these development runtime build identities.

The current populated-setter [capture runner](public-targets-7862/guard-review/settled-setter.log) passed 2/2 in 6.7 seconds. It verifies 83 phone/88 desktop targets, Share at 44×44px, next-page at 86.23×44px, and the first climb link at 342×117.80px phone / 720×140.19px desktop. Both receipts report zero undersized enabled targets, zero overflow and no browser errors. These captures support text/control inspection only; setter image decoding was not checked.

| Viewport | Current setter control capture | Raw receipt |
| --- | --- | --- |
| 390×900 | [After](public-targets-7862/settled-setter/after-390-setter.png) | [After JSON](public-targets-7862/settled-setter/after-390.json) |
| 1440×900 | [After](public-targets-7862/settled-setter/after-1440-setter.png) | [After JSON](public-targets-7862/settled-setter/after-1440.json) |

The following original screenshots and receipts are retained as historical evidence. They waited for fonts, not image decoding; their climb PNGs are superseded by the decoded comparison above, and their setter populations are not equivalent. The seeded journey was the default Kilter list → `Floats Your Boat` → `/setter/will_avelar`. The [original after summary](public-targets-7862/after-summary-root.json) indexes the earlier geometry/contrast measurements.

| Viewport | List | Climb | Setter | Raw receipts |
| --- | --- | --- | --- | --- |
| 390×900 | [Before](public-targets-7862/baseline-390-list.png) · [After](public-targets-7862/after-390-list.png) | [Before](public-targets-7862/baseline-390-climb.png) · [After](public-targets-7862/after-390-climb.png) | [Before](public-targets-7862/baseline-390-setter.png) · [After](public-targets-7862/after-390-setter.png) | [Before JSON](public-targets-7862/baseline-390.json) · [After JSON](public-targets-7862/after-390.json) |
| 1440×900 | [Before](public-targets-7862/baseline-1440-list.png) · [After](public-targets-7862/after-1440-list.png) | [Before](public-targets-7862/baseline-1440-climb.png) · [After](public-targets-7862/after-1440-climb.png) | [Before](public-targets-7862/baseline-1440-setter.png) · [After](public-targets-7862/after-1440-setter.png) | [Before JSON](public-targets-7862/baseline-1440.json) · [After JSON](public-targets-7862/after-1440.json) |

All six original after visits recorded zero undersized enabled audited targets, zero resolved non-exempt text contrast failures, zero horizontal overflow, one visible H1 and zero browser page errors. The audited link/button counts include main content, header and footer: 85/113/83 for phone list/climb/setter and 90/118/88 for desktop. The opened portal menu is checked separately. The eight original keyboard-driven samples met the computed 2px outline and 3:1 contrast requirements; those receipts predate the clipping-aware guard. The current production run checks the stronger focus requirement.

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

- The baseline setter audit captured 32 phone/37 desktop targets, while the after audit captured 83/88. The baseline PNGs contain 50 climb rows, but the old raw audit does not establish an equivalent populated page. The later isolated cold run demonstrates that an empty backend configuration result can produce a server-rendered fallback without climb links; there are no contemporaneous logs proving the exact cause of the older capture. Do not attribute that difference to client hydration alone. The old evidence supports individual deficits, not matched target populations. The current guard requires the real populated controls, and the settled after receipts supersede the old setter control captures. A new baseline setter scratch capture failed serialization before measurement and is not passing evidence.
- The native disabled Previous button still measures 2.7006:1. Only text inside native `button:disabled` uses the [WCAG inactive-control exception](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). Adjacent metadata, enabled controls and `aria-disabled` text remain subject to 4.5:1.
- Two phone/eight desktop header text samples per visit remain unresolved because of the filtered background. Image, gradient, filter and opacity cases are explicitly unresolved where effective contrast cannot be established. Unknown samples do not receive passing results; neither do unknown focus backgrounds.
- This is evidence for the seeded Chromium journey and explicit stress states, not full-site, physical-device Safari or assistive-technology coverage. The original font-wait-only desktop climb PNGs have incomplete board art, and the original phone baseline is blank; they establish neither a renderer regression nor image readiness. The new decoded comparison resolves the main climb hero-art gap only. Setter screenshots support text/controls, not image readiness. The seeded discussion is empty, so comment avatar/author targets remain unmeasured. Earlier November 19 observations came from a shared development preview whose temporary receipts are no longer available; no acceptance claim relies on them.
- Acceptance still requires two distinct post-publication Astra reviews, covering code and design. The five rubric checks are contrast, tap targets, focus/destinations, phone wrapping and hierarchy, each scored 0–2. The required score is at least 8/10 **and** every enabled audited target must meet 44×44px and every resolved non-exempt readable-text sample must meet 4.5:1. No score overrides either threshold. This record assigns no review score; final source validation and the published reviews remain required before readiness.

## Auth compatibility fixture timing (#7942)

The required auth check failed on two different fixtures at the same commit. The first run admitted all nine callers but counted two primary reads. The retry passed that test and rejected an expired challenge fixture whose two independently calculated timestamps were five minutes and one millisecond apart. [First run](https://github.com/boardsesh/boardsesh/actions/runs/44760543645/job/136371717016) · [Retry](https://github.com/boardsesh/boardsesh/actions/runs/44760543645/job/136378065119)

Astra recommended addressing both in one isolated test commit. The burst fixture releases nine genuinely verified JWT results together before the coalescer claims its batch. It checks all nine returned identities and exactly one primary read. The challenge fixture derives both timestamps from one instant and the existing five-minute lifetime. The database enforces the deadline on both updates, and the test checks the hourly and daily limits against real rows. [Tracking issue](https://github.com/boardsesh/boardsesh/issues/7942)
