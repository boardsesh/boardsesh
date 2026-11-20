# First-visit consent notice: current review evidence

Refreshed on 19 November 2026 against main [`0757401e2b`](https://github.com/boardsesh/boardsesh/commit/0757401e2b6d66a96a077bff7432e524210a1025). Candidate source: [`6c9d237e2d`](https://github.com/boardsesh/boardsesh/commit/6c9d237e2d236a2197d581666d7fcfeabec9f873). The original five shortened disclosures are preserved; Simplified Chinese now supplies the same summary and Details keys. No files from unmerged #7870 were imported.

These are development-preview screenshots, not evidence of production release or privacy-owner approval. Before captures temporarily restore only the main consent component and six consent catalogs. Candidate captures use the committed candidate with exactly the same merged homepage, viewport and browser settings. Sources were restored after capture. No app layout or content was restyled for the comparison.

## Matched captures

Phone: **390 × 664**. Desktop: **1440 × 900**. All six current locales have matched before/after images.

| Locale | Phone | Desktop |
| --- | --- | --- |
| English | [Before](before/390-en-US.png) / [Candidate](candidate/390-en-US.png) | [Before](before/1440-en-US.png) / [Candidate](candidate/1440-en-US.png) |
| Spanish | [Before](before/390-es.png) / [Candidate](candidate/390-es.png) | [Before](before/1440-es.png) / [Candidate](candidate/1440-es.png) |
| French | [Before](before/390-fr.png) / [Candidate](candidate/390-fr.png) | [Before](before/1440-fr.png) / [Candidate](candidate/1440-fr.png) |
| German | [Before](before/390-de.png) / [Candidate](candidate/390-de.png) | [Before](before/1440-de.png) / [Candidate](candidate/1440-de.png) |
| Italian | [Before](before/390-it.png) / [Candidate](candidate/390-it.png) | [Before](before/1440-it.png) / [Candidate](candidate/1440-it.png) |
| Simplified Chinese | [Before](before/390-zh-CN.png) / [Candidate](candidate/390-zh-CN.png) | [Before](before/1440-zh-CN.png) / [Candidate](candidate/1440-zh-CN.png) |

The harness hides only `nextjs-portal` and `[data-translation-editor]`: Next.js tooling and the translation launcher gated by `NODE_ENV === 'development'`. Both are absent from production. PNGs are direct browser captures without retouching. Phone contexts use an iPhone Safari user-agent in headless Chromium; this is not a physical Safari test. A deterministic `consentRegion` response selects a prompt region; other consent behavior uses the actual provider and cookie code. Tracker requests are intercepted during capture.

## Geometry against #7845

Raw DOM measurements: [geometry.json](geometry.json).

| Locale | Before phone card | Candidate phone card | Card + bottom gutter | Candidate desktop card |
| --- | --- | --- | --- | --- |
| English | 443.6 px | 183 px | 199 px | 183 px |
| Spanish | 464.6 px | 204 px | 220 px | 183 px |
| French | 485.6 px | 204 px | 220 px | 183 px |
| German | 464.6 px | 183 px | 199 px | 183 px |
| Italian | 464.6 px | 204 px | 220 px | 183 px |
| Simplified Chinese | 401.6 px | 183 px | 199 px | 162 px |

Every candidate phone card is 358 px wide with 16 px gutters. The card plus bottom gutter is **199–220 px**, below the **260 px** target. Both answers are equal-width **44 px** controls on one row. All six headings and primary store buttons are inside the first viewport and clear of the notice. The old notice covers every phone store button. Every desktop candidate is **420 px** wide at bottom-left, clear of both store buttons. No candidate has horizontal document overflow or clipped card content.

Doubling notice text font sizes and line heights makes cards grow naturally to 253.2–346.4 px. All six stay inside the viewport without horizontal overflow. This CSS text stress check is not native browser zoom. No hardware safe-area inset was active; physical-device safe-area behavior remains unverified. These captures use the merged homepage at the base commit above; the separately proposed longer hero subhead still needs a combined integration check.

## Disclosure and actual consent flows

[English Details](candidate/390-en-US-details.png) retains the full analytics and Meta/Reddit paragraphs and the privacy-policy link. `body` and `adMeasurement` match current main exactly in all six locales. Opening Details does not answer the notice or authorize analytics; Close returns to the unanswered notice.

The six browser tests pass against this running worktree: Details; Allow and withdrawal; No thanks and later Allow; an outside-region default followed by withdrawal; failed-region fallback; outside-region Global Privacy Control. The browser tests check real UI/cookie persistence, including explicit grant/denial values and footer changes. Provider tests assert the analytics authorization state. This does not claim delivery to vendor endpoints. An initial local browser run had one click blocked by Next.js development chrome; hiding only that chrome made all six pass. The test source was restored after this local harness adjustment.

## Validation and review status

`vp run typecheck`: **65/65 tasks successful**, after a frozen install. Focused integration tests: **29 passed**. Six-locale catalog completeness: **230 passed**. Scoped lint/format and both translation guards pass; normal commit hooks pass. After committing the source, restoring main's original banner makes the compact-disclosure and horizontal-choice guards fail (**2 failed**); restoring the candidate passes. Full CI and two distinct post-publication Astra reviews (code quality and design) must assess the refreshed published head.

The backup ref `codex/7845-consent-backup-20261119` preserves the pre-refresh candidate. Rebase onto main was conflict-free. Technical readiness follows normal CI and review checks; privacy-owner approval of the exact copy is required **before shipping**, and is not an extra requirement to keep a technically ready PR in draft.

- [x] Heading and primary store button clear at 390 × 664 in six locales.
- [x] Phone card plus gutter below 260 px; equal answers on one row.
- [x] Desktop card clear of store buttons at 1440 × 900.
- [x] Current six locales complete; existing regional/account authority retained.
- [ ] Privacy owner approves the exact shortened disclosure and translations before shipping.

## Post-publication policy-navigation correction

Astra found that opening the policy from Details navigated beneath the persistent, focus-trapped dialog. Source verification confirmed that `ConsentBanner` lives in the shared site layout. The policy link now calls `closeChoices` through Next.js `onNavigate`; `LocaleLink` forwards that prop to NextLink. The installed Next.js implementation does not call this callback for modified/new-tab activations, so those keep the existing dialog open. No consent answer is written by navigation.

The follow-up has **30 consent tests and 10 profile tests passing**. After committing the fix, removing only the navigation handler makes the new dialog/cookie/authorization guard fail; byte-exact restoration passes. A literal Simplified Chinese alternate was also added to the existing profile metadata expectation, fixing the independently confirmed CI failure without changing canonical, indexing or privacy assertions.

A permanent browser guard now follows the policy link and requires the policy heading to be visible, the dialog absent and the consent cookie unset. **That new browser guard has not run yet**: it awaits the shared browser-QA slot. The six previously reported browser flows and these screenshots were observed before this navigation-only correction; the rendered notice layout and disclosure strings are unchanged. Independent reviewers must assess the published follow-up and the pending browser result before readiness.

## Merge order and wording reconciliation with #7870

[#7870](https://github.com/boardsesh/boardsesh/pull/7870) remains a separate, open draft proposing worldwide opt-in, dismissal, and different disclosure copy. This PR keeps main's existing regional prompts, region defaults, GPC and saved/account authority. It does not add a third choice or change consent scope.

If this compact-layout PR lands first, #7870 must rebase and preserve the compact geometry, equal choices and full Details while reconciling its new policy and dismissal controls. If #7870 lands first, rebase this PR and review every summary and Details translation against that policy before publishing a reconciled candidate. Neither merge order permits blindly restoring older disclosure paragraphs or treating technical approval as exact-copy shipping sign-off.
