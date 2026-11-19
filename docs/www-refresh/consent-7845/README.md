# First-visit consent notice: review evidence

Captured on 19 November 2026 in a local website-refresh integration preview, using fresh anonymous browser contexts and local development data. The consent component and five consent catalogs came from [`6b89a652b9`](https://github.com/boardsesh/boardsesh/commit/6b89a652b93ae9c53e77dcba04393303d4317842); the surrounding website was preview commit [`80998282b8`](https://github.com/boardsesh/boardsesh/commit/80998282b86bfdfa5c6cd91e64cfcce382706348). The candidate was overlaid only for capture, then removed and the preview restored. These are development-preview screenshots, not evidence of a production release.

## Geometry at the default text size

Phone viewport: **390 × 664**. Desktop viewport: **1440 × 900**. Phone contexts used an iPhone Safari user-agent in headless Chromium; this is not a physical Safari test. Measurements come from DOM rectangles in [geometry.json](geometry.json).

| Locale / viewport | Before card | Candidate card | Candidate choices |
| --- | --- | --- | --- |
| English / phone | 374 × 443.6 px | 358 × 183 px | 163 × 44 px each, same row |
| Spanish / phone | — | 358 × 204 px | 163 × 44 px each, same row |
| French / phone | — | 358 × 204 px | 163 × 44 px each, same row |
| German / phone | — | 358 × 183 px | 163 × 44 px each, same row |
| Italian / phone | — | 358 × 204 px | 163 × 44 px each, same row |
| English / desktop | 600 × 311.6 px | 420 × 183 px | 194 × 44 px each, same row |

The candidate has 16 px left, right and bottom gutters on phones. Its card plus the measured bottom gutter covers **199–220 px**, below the 260 px target. No hardware safe-area inset was active in this capture; the CSS safe-area rule still needs physical-device review. The English phone's “Get the free app” button was covered before and unobscured afterward. The desktop candidate sits at x=16, y=701 with no overlap of the measured hero store button. Hero-button overlap was measured for English only; translated screenshots are provided for visual review. Every recorded page had horizontal document width equal to the viewport, and every default-size card had equal scroll/client height.

| English comparison | Before | Candidate |
| --- | --- | --- |
| Phone | [390 × 664](before/390-en-US.png) | [390 × 664](candidate/390-en-US.png) |
| Desktop | [1440 × 900](before/1440-en-US.png) | [1440 × 900](candidate/1440-en-US.png) |

Other phone candidates: [Spanish](candidate/390-es.png), [French](candidate/390-fr.png), [German](candidate/390-de.png), [Italian](candidate/390-it.png).

The screenshot harness hid only `nextjs-portal`, which contains Next.js development chrome and is absent from production. Application source and styles were unchanged by that exclusion. PNGs are direct browser captures without image retouching.

## Disclosure, choice and enlarged-text checks

[English Details capture](candidate/390-en-US-details.png): Details opened the existing Privacy choices dialog with the unchanged full analytics and Meta/Reddit paragraphs. Closing it and selecting No thanks saved an explicit denial cookie. The consent integration suite separately verifies both explicit answers and that opening Details does not grant analytics.

A CSS text stress check doubled the notice heading, paragraph and button font sizes **and line heights**. Candidate card heights were 253.2 px English, 346.4 px Spanish, 295.2 px French, 304.4 px German and 346.4 px Italian. All remained inside the 390 × 664 viewport with no horizontal overflow. This tests enlarged CSS text, **not native browser zoom**, and the normal-size 260 px target is not applied to enlarged text.

## Validation and release gates

Source commit `6b89a652b9` passed the [CI aggregate](https://github.com/boardsesh/boardsesh/actions/runs/44422028795/job/135220717892), including typecheck, web Docker and test jobs. Local validation passed 26 consent integration tests, 176 catalog-completeness tests, scoped lint/format and both translation checks. Restoring the old banner made the compact-disclosure and horizontal-choice guards fail; restoring the candidate passed them. A later evidence-only commit must get its own CI result; it does not alter the consent source.

**Keep PR #7881 draft.** The privacy owner must approve the exact shortened English disclosure and all translations. Coordinate with still-open [#7870](https://github.com/boardsesh/boardsesh/pull/7870), which also changes the consent notice and disclosures; this candidate preserves current regional behavior and does not include that PR. Screenshots and green checks do not replace that approval.
