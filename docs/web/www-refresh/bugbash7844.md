# bugbash7844

Unattended website refresh for epic #7844. The owner explicitly waived baseline collection and measurement waiting. Astra recommendations and the evidence behind them are recorded in decisions.md. No agent merges these PRs.

## Changes and acceptance

| Work | Pull request or lane | Remaining acceptance |
| --- | --- | --- |
| #7846 current logbook import guide | #7874, already merged by owner | None; preserved as the starting point |
| #7868 placement and website journey events | #7878 | CI green and Astra re-review passed; later route events ship with their owning pages |
| #7857, #7859, #7856, #7875 API, privacy, funding and unreleased CNC copy | #7879 | CI and Astra re-review passed; browser evidence captured; owner merge |
| #7858 named founder, shared trust FAQ and password/export guidance | #7879 plus homepage integration | A consented founder photograph remains unavailable; no substitute was fabricated |
| #7854, #7853, #7855, #7862, #7863, #7864, #7866, #7867 public-page fixes | #7882 plus #7885 gym data | Astra re-review and 52 integrated browser checks passed; final-head CI and owner visual review/merge |
| #7869 client translation subtree transport | #7882 plus #7883 page opt-ins | Merge/isolation regressions pass; final local production HTML is 37,716 gzip bytes, below 60,000; pre-merge and post-deployment guards both enforce 60,000 bytes |
| #7847 supported-board matrix | #7883 | Catalog, lighting/import support and cached directory counts are source-derived; no new physical controller test claimed |
| #7848 hero | #7883 | Session headline and original playable English hero restored after owner visual feedback; localized real board captures retained; physical lit-board shoot outstanding |
| #7849 homepage hierarchy | #7883 | Spray-wall entry directly after hero; logbook secondary link and dedicated band; no repeated onboarding section |
| #7850 spray-wall page and guide | #7883 plus #7882 | Existing real photo and explicit visibility/training controls; no invented public-wall testimonial |
| #7851 gym and partner routes | #7883 plus #7882 | Claim search and native email intent counted separately from installs and submitted enquiries |
| #7852 header and footer | #7883 | Phone store CTA, crawlable journey links, visible language names, full independence disclosure, no auth-page footer CTA |
| #7860 public figures | #7883 | Times rather than distinct climbs; comparable rounding and definitions; directory coverage distinct from adoption |
| #7861 shared layout and display font | #7883 plus #7882 | Local Geist with OFL, shared logo-aligned page frame, type ramp and pill actions |
| #7865 action names and English website glossary | #7883 | Locale glossaries preserved; the English website exception does not rename native/store copy or exact app controls |
| #7845 compact consent notice | #7881 | Code, geometry and regression tests reviewed; phone cards 183–204px, desktop 420px wide, equal 44px choices; exact-copy approval and #7870 coordination remain |
| #7876 CNC relaunch, #7877 costs and card giving | Explicitly deferred by owner | No implementation or configuration changes |

## Evidence rules

Production screenshots attempted through a normal browser hit a Cloudflare challenge; those are not counted as before evidence. Local screenshots must identify the source commit and viewport. Test reports distinguish real failures, expected regression failures and restored passing runs. The preview can integrate prerequisite branches for browser QA, while each original PR keeps its review history. Deployment or real-person research is not inferred from passing local tests.

Feedback is polled during the campaign. The GitHub credential lacks notifications scope, so creating a server-side notification subscription failed and no credential scope was changed.


## Final verification and handoff

The final application source at `9134f99cad5fb0fe2b2ebc8aab3e0083b85d40c0` passed all 64 required repository typecheck tasks, including the optimized web compilation. Reviewed lane checks include 109 homepage/chrome tests, 85 integration tests, 203 public-page tests, 216 locale checks and 47 real PostgreSQL/Redis cases; these overlap and are not summed. Mandatory hooks passed. Root homepage/video guards produce nine real failures on original source, then all 29 selected tests pass after restoration. Public crop/auth/gym guards produce six failures, then pass; backend privacy/ranking guards produce sixteen failures, then pass.

[Review images and exact browser evidence](screenshots/README.md) distinguish production layout/HTML checks from correctly configured development board-art checks. A local synthetic gym remains available for repeat inspection. No physical controller test, real lit-board shoot or consented founder portrait is claimed.

Merge the independently reviewed prerequisites #7878, #7879, #7882 and #7885 before the stacked #7883. Deploy the additive #7885 backend schema before clients request popularClimb. Keep #7883 draft until its prerequisite bases land; then rebase/retarget to main and recheck the effective diff and CI, accounting for squash merges. Keep #7881 draft for exact-copy privacy-owner approval and coordination with #7870. Keep #7876 and #7877 deferred. Agents never merge.

GitHub feedback was polled throughout the campaign and actionable findings were resolved and re-reviewed. The credential lacks notifications scope, so a server-side subscription could not be created; no permission scope was changed. Final CI and PR states are recorded in the GitHub handoff comments.


The explicitly named `/setter/will_avelar` now has recorded phone/desktop browser checks; Back and Share are below the header and the browser accessibility tree exposes “Back”. A real assistive-technology announcement remains unverified. Physical-phone LCP/time-to-interactive was not measured, and is not inferred from the byte budget. The pre-merge HTML budget gate is implemented on #7883 alongside its matching homepage. It also runs for catalog-only changes, reuses the existing standalone build, requires populated live fixtures and blocks database/vendor connections. Its final local run passed at 36,977 gzip bytes. The public prerequisite narrows both homepage providers and independently passed its 39,159-byte compiled-page measurement.


Final integrated verification at `1e8a59caa775df5c5a07442ee4d5c88df4c55115`: all 64 repository typecheck tasks passed, then the new pre-merge artifact checker passed with twenty deterministic beta fixtures and nonzero usage. The merged terminology policies and catalog completeness pass all 213 selected tests. Twelve final production entity checks pass without overflow or JavaScript page errors; the gym previews are loaded and 320px high. Temporary measurement servers are stopped after capture; the tester preview retains its QA notes.

The public prerequisite includes current-main ancestry, so neither generated changelog path nor its already-landed automation commit is part of #7883's comparison. No generated changelog was hand-edited. Final readiness still requires current-head CI and no unresolved review threads; GitHub handoff comments record those live states.


The repository Playwright public-overflow suite also passes all 20 cases at 390×664: nineteen static routes, including the three new marketing destinations, and one list → climb → setter → playlist journey. No cases were skipped or flaky (52.994 seconds). This extends the existing suite; it does not claim coverage of every public URL. The default anonymous denied-consent state prevents the unrelated long disclosure from intercepting the navigation test.


Final review follow-up: #7882 commit `66d11c63b9` restores `marketing.help.clip` to the four Help routes that render video controls. All forty fresh-provider regressions fail before the fix and pass after it across five locales; Astra approved the committed diff. The integrated source `3a8908870cda82750c8ff34a067ecca13d6b2a2e` passed all 64 typecheck tasks and the 36,976-byte populated artifact budget. Eight English/Spanish fresh browser visits now resolve the controls and fallback text; matching phone before/after images are in the gallery.

The first complete composed CI run also exposed four outdated copy assertions: three Privacy modes retained the old English Spraywall spelling, and the gym-directory test retained the old store-button wording. Only those three literal expectations changed, preserving the privacy, purpose, placement and fallback checks. Astra approved and re-reviewed them; both affected suites pass all 29 tests. The prerequisites retain their own correct standalone wording.


Final completion source `50d1211593194c3a1e076f08742ff49df6637583` includes all five final public review fixes from `d185fcad02`: normal-flow virtual rows, correct gym discussion namespace, auth-login attribution, own-key saved-icon fallback and stable mirrored-edge CSS. Both independent Astra reviews and the placement-union re-review passed. Public tests: 212 across eight files; composed tests: 230 across those files. All 64 typecheck tasks and the 36,975-byte populated homepage guard pass.

Actual browser evidence now includes three JavaScript-disabled before/after row checks with zero overlap after the fix, three bounded forward/reverse scroll traces, two translated empty-gym visits and two sign-in store-link checks. The synthetic crop diagram uses actual helper output and Chromium parsing; it is explicitly separate from real-board imagery. The gallery identifies sources, setup limits and the inconclusive relative-scroll probe. Current-head CI and final owner handoff remain recorded on the PR/epic; the integration stays draft until its prerequisites land.


## Owner visual restoration

The owner rejected the queue-only hero and text-only About shown in the earlier after-images. The revised Home restores the original playable app montage beside the session copy, with a visible phone Play control; About restores the wide story/profile grid, working platform switch and section icons. Accurate exports, credentials, privacy, API status and funding copy remain. The gallery now labels rejected images explicitly and links the restored phone/desktop captures. Astra's recommendation and independent pointer-bug review are recorded in decisions.md.

Focused verification passes 49 tests across five files, including fresh About resources in all five locales. The twenty existing phone overflow/journey cases pass. Two permanent real-pointer regressions pass with reduced motion at 390 and 1440px. An initial test-fixture error used an unsupported Playwright fixture; the final tests explicitly emulate reduced motion before navigation. The direct twelve-check browser receipts pass. Required current-main compilation and current-head CI are recorded after completion, not inferred from these scoped checks.

The visual revision integrated onto main at 88cb8be7c0 passes all 65 required repository typecheck/build tasks. Astra independently verified both the merge resolutions and preservation of all newer main work. The remaining instrumentation PR #7878 retains all install placements and needs its own refreshed current-head CI before owner merge.

Final visual application source `6189e0f108` passes 65 repository checks and 262 focused/locale tests. The compiled homepage fixture passes at 37,281 gzip bytes. Both new guards fail on deliberate missing-resource/old-centering variants and pass after source restoration. Two pointer cases and twenty public-phone cases pass separately; the gallery records the actual scopes and source.

Final full-width import band at `d459e124e9b49b1b416c466bcd1726c0b3902292` also passes all 65 repository tasks, 17 Home tests and four layout checks. The compiled homepage remains below budget at 37,286 gzip bytes. Actual phone reading order, desktop link placement and German tablet wrapping pass independent Astra review.


All prerequisites (#7878, #7879, #7882, #7885) are now owner-merged. The final clean branch is rebased onto main `51d4ec9ade`. Application source `f642c2e8a8755c4bb10ba33dd9261b14829cee79` passes 65/65 required repository tasks, 136 focused tests and all 22 browser cases without skips/flakes. The populated compiled homepage is 37,269 gzip bytes. Both review and actual tree comparison preserve the restored Home/About visuals; footer-logo tracking from the merged prerequisite is retained. Current-head CI/readiness is recorded in the final PR and epic handoff comments. Agents never merge.
