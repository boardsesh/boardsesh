# Public climb targets — #7862

Campaign: `bugbash7844`. Source baseline: `0cb7275b4d4b74c51244837141db495caea570f5`.

## Decision

The approved follow-up gives the actual Home and board breadcrumb anchors and the climb-facts setter anchor a minimum 44×44px hit area. MUI supplies the setter anchor styling through LocaleLink. Breadcrumb flex items remain bounded and long tokens wrap; the current crumb remains plain `aria-current="page"` text. Existing localized destinations and JSON-LD are preserved. No new page, user-facing string, colour token or sitemap entry is introduced.

The previous merged work already covers angle pills, heading hierarchy and readable public neutral tokens. The existing `public-reading-tokens.test.ts` checker remains the source-level colour guard; this change does not duplicate it. The `/boards` readability and board-request work belong to separate PRs.

## Browser evidence and status

**Baseline measured; after-state and acceptance remain unverified.** Frozen installation completed in 24.4 seconds before creating `codex/7862-public-touch-targets`. The scoped Vite+ format/lint/type-aware check passed all four touched TypeScript files. The browser audit fixture passed 1/1 in 1.2 seconds. An initial fixture expectation incorrectly treated translucent white over black as the inverse of white over translucent white; the corrected deliberately poor foreground uses 40% opacity and measures below 4.5:1.

The read-only baseline used the coordinator-owned development preview at `https://localhost:3001`, source head `4b4b34f191a1ebea1bf1f64868e0e6bc810ebd16`. A working-tree diff against `0cb7275b4d` was empty for the climb/list/detail/setter/similar-climb, site-chrome, social, theme, index CSS, compact language picker, brand components, store buttons, StartClimbingButton and brand CTA sources. The unrelated `/boards` changes on that preview are outside this audit. The preview source was not changed by the audit.

The extended `public-page-overflow.spec.ts` follows the seeded default board list → actual climb → actual setter at matched 390×900 and 1440×900 viewports. It checks actual anchor geometry, keyboard-driven focus outlines, actual destinations, one visible H1, no horizontal overflow and resolved main-content text contrast of at least 4.5:1. The phone case retains the existing public-playlist journey.

Each page attaches a browser report of every rendered link/button in its content, header and footer, including offscreen elements in normal flow. The audit composites foreground alpha and ancestor background colours. Images, gradients, group opacity and filters remain explicitly unresolved instead of receiving a colour-only pass. Before/after screenshots must use the same seeded route and viewport. A separate DOM-only long-token stress changes breadcrumb text without claiming to represent seeded user content.

The baseline follows the default Kilter list to `Floats Your Boat`, then `/setter/will_avelar`. Both widths have zero overflow, one H1 per page and no browser page errors. Rendered link/button counts are 85/113/83 on phone and 90/118/88 on desktop for list/climb/setter respectively. The existing breadcrumb and setter anchors already receive keyboard-driven solid 2px outlines. The climb's discussion was empty at both widths; comment avatar/author targets remain unverified and are not proposed for an unmeasured source change.

| Confirmed baseline deficit | Phone and desktop measurement |
| --- | --- |
| Three approved anchors | Home 66.94×16px; board 137.09×16px; setter 133.36×41px |
| Pagination and setter actions | List Next 87.67×32px; setter More climbs 86.23×24px; two related links 24px high; setter Share 43.42×43.42px |
| Footer targets | Brand 116.94×39px on phone; app CTA 199.41×40px; About/Help/Legal widths 28.80–36.59px despite 44px height |
| Language controls | Trigger 64×32px; six menu items 128×36px desktop, 128×48px phone |
| Readable contrast | Disabled list Previous label 2.7006:1; outlined Google Play 6.4887:1 idle and 3.9290:1 hovered |

The store hover failure is reproduced deliberately at both widths: `rgb(151, 132, 255)` text over `rgba(199, 184, 232, 0.24)` composited over the actual ancestor backgrounds. It is not inferred from token names. The disabled Previous control is a native disabled Button. Astra recommended, and the coordinator accepted, the inactive-control exception in [W3C's explanation of SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). The raw 2.7006:1 result remains in the report; only text inside a native `button:disabled` is exempt from the 4.5:1 assertion. Ordinary adjacent metadata, enabled buttons and text merely marked `aria-disabled` remain subject to the gate. Two phone/eight desktop header text samples remain unresolved because the header uses a backdrop filter; none is counted as passing. No image/gradient text sample receives a colour-only pass.

Raw baseline receipts and matched screenshots were stored in `/tmp/bugbash7844/7862-bugbash7844/`, including `baseline-all.json`, `baseline-control-states.json` and `baseline-<width>-<page>.png`. The captures identify a development preview and include development overlays; offscreen lazy images are not used as image-loading evidence. An initial standalone tsx harness failed before measurement because of a serialized helper; it was replaced with the Playwright runner. An early setter capture lacked a navigation wait and was discarded; the final receipt explicitly records `/setter/will_avelar`. The final audit runs passed in 14.9 and 7.2 seconds with one browser and one worker, then released the shared validation slot.

Those temporary receipts are no longer available in the current workspace. The earlier measurements above are historical observations, not current acceptance evidence. Fresh matched before/after captures, committed-source red/green guard proof, settled hover/focus measurements and wrapping stress remain required before publication. This source checkpoint does not claim those checks have run.

The first fresh baseline run on November 20 passed the deliberate browser fixture and failed both actual journeys on the Home anchor's 16px height. A separate read-only collection reached the same list, climb and setter at both widths with zero page errors. One desktop idle sample caught a hover-out transition after navigation; it is not accepted as a settled contrast result. The audit now waits for active CSS transitions to finish before sampling. The final committed-source before/after evidence will be collected again with that barrier; the five deliberately settled baseline hover controls already reproduce the earlier failures. The settled Share box is 43.421875px square at both widths, with `transform: none` and opacity 1 on the control and every ancestor; its 8px padding and 27.4286px computed font size are recorded without attributing the deficit to animation.

## Astra-approved source expansion

Astra approved the measured 44px floors and the coordinator accepted the scope. The source now floors local list pagination, setter pagination/related links, setter Share, footer links/brand/app CTA and the compact language trigger/fallback. The menu floor starts at `sm`: the installed MUI `MenuItem` source already sets 48px on phones and changes its minimum to `auto` at that breakpoint. The change preserves phone rows and sets a 44px desktop floor. The setter Share baseline's fractional 43.42px box will be rechecked after settling, including button/ancestor transforms and computed sizing; it is not attributed to a mechanism from its number alone.

The coordinator granted a separate short read-only hover comparison before approving the repair layer. Five settled primary controls fail on the same existing shared background, `rgba(199, 184, 232, 0.24)`, with `rgb(151, 132, 255)` text:

| Representative control | Idle contrast | Hover contrast |
| --- | --- | --- |
| List Next page | 5.4456:1 | 3.1577:1 |
| Plain list Google Play | 5.4456:1 | 3.1577:1 |
| Footer app CTA | 6.3255:1 | 3.7761:1 |
| Language trigger | 6.3255:1 | 3.7761:1 |
| Branded setter Google Play | 6.4887:1 | 3.9290:1 |

That comparison passed as an evidence-collection harness in 6.7 seconds with one browser/worker; its control contrast measurements are failures, not accessibility passes. `baseline-representative-hovers.json` contains the actual computed classes/foreground/background. Common source identity against `0cb7275b4d` remained unchanged on preview head `4b4b34f191a1ebea1bf1f64868e0e6bc810ebd16`; unrelated gallery edits are outside these common components.

The actual hover background comes from the more specific non-contained rule in `mui-theme.ts`, overriding the brand recipe's nominal wash. Astra conditionally recommended a shared foreground fix if plain controls also failed; the comparison confirmed that condition, and the coordinator approved it. The existing non-contained hover rule now lifts foreground to existing `--color-primary-hover` only for `.MuiButton-colorPrimary`. Disabled, contained and non-primary colours are excluded from that foreground override. Existing palette and hover backgrounds are preserved. Token choice alone is not passing evidence: all five final settled ratios still need browser remeasurement.

The repository browser guard now asserts enabled target geometry across content, chrome and the opened portal menu, with all six language rows. It reports computed contrast across those scopes, explicitly preserving unknown filtered/gradient samples. The fixture retains both a poor disabled-button child and poor enabled/ordinary/aria-disabled text to prove the native exception stays narrow. Settled hover foreground/background and actual page contrast are checked together. This expanded guard has not been executed since the source expansion; no browser or compilation job was started while the gallery export held the shared slot.

The coordinator subsequently approved two source-only guard tightenings. Hover checks now associate text samples with the actual control's DOM element and require every rendered label sample to resolve at 4.5:1 or better; unrelated readable page text cannot supply that evidence. Keyboard focus checks now resolve the computed outline colour, composite its alpha over the surrounding background (or the target background for an inset outline), and require a visible keyboard-focused element with a minimum 2px outline and 3:1 contrast. Transparent, faint and opacity-zero outlines fail; unknown image/gradient/filter/opacity backgrounds remain unresolved and cannot prove focus. The same existing fixture now includes a readable label that becomes unresolved on hover, one passing outline and three deliberately failing outlines. Fixture links explicitly inherit their text colour so browser-default link blue does not introduce an unrelated low-contrast sample. These additions are unexecuted; only source inspection and `git diff --check` are permitted while the earlier draft PRs own the serialized validation slot.

## Local rubric

Score each row 0 for failed or unmeasured, 1 for partial evidence and 2 for complete passing evidence on the audited list/climb/setter journey. Acceptance requires at least 8/10 **and** no measured readable-text contrast below 4.5:1 and no enabled link/button hit box below 44×44px. A score cannot override either threshold. Unresolved image/gradient text must be called out separately.

| Check | Required evidence | Status |
| --- | --- | --- |
| Contrast | Computed foreground over effective ancestor background ≥4.5:1 | Baseline hover failure; after-state unmeasured |
| Tap targets | Every enabled audited link/button ≥44×44px | Baseline failures; after-state unmeasured |
| Focus and destinations | Visible keyboard focus and working named destinations | Existing three anchors show focus; list → climb → setter resolves |
| Phone wrapping | Matched phone capture and explicit long-token DOM stress | Actual names fit; long-token after-state unmeasured |
| Hierarchy | One visible H1 with useful subordinate sections | One H1 on all six baseline visits |

## Required verification record

Commit the fix before temporary source mutations. Revert the anchor sizing, run the journey and record its real failing geometry output; restore and rerun. The browser fixture already exercises deliberately poor foreground/background alpha, a 32px target and unresolved gradient handling. A committed-source red proof, final source checks, full repository typecheck, after-state screenshots and long-token stress remain unverified. Run the required full repository typecheck in the serialized validation slot, with normal Git hooks before publication.

Publish as a draft, read the published PR body back, attach before/after browser evidence and request the coordinator's two distinct post-publication Astra reviews: code and design. Do not merge or mark ready without the coordinator.
