# Website review evidence

Captured on 19 November 2026 UTC for #7844. These are real Chromium screenshots, with reduced motion and an explicit declined-consent cookie. Phone captures emulate an iPhone user agent at 390×664; desktop captures use 1440×900. The before and after captures use the same local fixture database. No production traffic or user research was collected.

Before: frontend source and locale catalogs at `920a551128`, running with current workspace dependencies. The rejected English Home/About after-images use application source `9134f99cad5fb0fe2b2ebc8aab3e0083b85d40c0`. Final production entity and budget checks use `1e8a59caa775df5c5a07442ee4d5c88df4c55115`, build `P1mq-Uboo8bDK17yyWnPC`. Intervening work corrected Italian FAQ grammar and added CI/test checks; the captured English UI is unchanged. Every temporary source swap restored a clean HEAD. Next.js development controls were hidden by the capture harness; application styles were unchanged.

The owner rejected the queue-only Home hero and narrow text-only About below. Those images remain historical evidence, not the final proposal. The corrected revision restores the playable hero, About's profile preview and explicit section icons.

| Page | Original | Rejected revision | Restored revision |
| --- | --- | --- | --- |
| Home, 390×664 | [Original](home-390-before.png) | [Rejected](home-390-after.png) | [Restored](home-390-restored.png) |
| Home, 1440×900 | [Original](home-1440-before.png) | [Rejected](home-1440-after.png) | [Restored](home-1440-restored.png) |
| About, 390×664 | [Original](about-390-before.png) | [Rejected](about-390-after.png) | [Restored](about-390-restored.png) |
| About, 1440×900 | [Original](about-1440-before.png) | [Rejected](about-1440-after.png) | [Restored](about-1440-restored.png) |
| Climb list, 390×664 | [Original](climb-list-390-before.png) | — | [After](climb-list-390-after.png) |

The restored captures use the reviewed visual source at `2b539d4ed443eb240f41d6dfbeecdbf2b87b4a5c`, whose visual files are byte-identical in current-main integration `6189e0f108cd39acaf0ad5119ff46b64bd566541`. They keep the same viewports, local data and declined-consent cookie. Only Next.js controls and the development-only translation editor are hidden; application layout is unchanged. The subsequent desktop centering correction leaves the initial screenshot position unchanged but prevents hover displacement. Full-page views: [phone Home](home-390-restored-full.png), [desktop Home](home-1440-restored-full.png), [phone About](about-390-restored-full.png), [desktop About](about-1440-restored-full.png).

[Restored layouts](visual-restoration-layouts.json) cover Home/About at both widths plus German About, Support and Legal on a phone, without overflow or JavaScript page errors. [Playback and preview receipts](visual-restoration-playback.json) contain twelve checks: reduced-motion pointer Play/Pause at both widths, matching iOS/Android About captures in all five locales, the four localized three-board heroes without baked English video, and visible/idle desktop autoplay. This is Chromium responsive QA with an iPhone user agent on the phone case; it is not physical Safari testing. Astra independently reviewed the restored images and actual code, found the desktop pointer bug, and approved the correction and real pointer regression.

The list pair uses `/kilter/1/28/1,20/40/list`, which redirects to its canonical slug route. Both show the same first climb, Floats Your Boat, at the same vertical position, with visible board images fully loaded.

## Browser results

[Public layouts](public-layouts.json): 36 route/viewport checks at 390, 844 and 1440 pixels all returned 200, with no horizontal overflow, duplicate IDs or JavaScript page errors. These checks use the production build on loopback port 3012 with normal browser user agents; production middleware intentionally rejects the default automation user agent. Store actions measure 48px.

[Entity layouts](entity-layouts.json): 12 checks cover a list, climb, playlist and synthetic gym at the same three widths. All returned 200 without overflow or JavaScript page errors. List and climb breadcrumbs sit 16px below the actual header bottom. The final checks use production output on port 3012, built with the verified local HTTPS backend on 8081. The gym preview loads at all three widths. Earlier development-server checks were repeated after correcting the local build-time proxy configuration; neither production data nor a physical controller was used.

[Homepage budget](homepage-budget.json): the untouched production homepage response is 37,716 gzip bytes against the existing 60,000-byte budget. Its first HTML contains the real H1 and excludes API-only documentation copy. The new [pre-merge gate](../homepage-budget.md) runs after the existing typecheck build, including catalog-only PRs. Its isolated, populated fixture response is [36,977 gzip bytes](homepage-budget-fixture.json); both live fixture operations and actual SSR text are required. The existing post-deployment smoke remains. The public prerequisite's independently compiled older homepage is also [under budget](public-pr-homepage-budget.json), at 39,159 gzip bytes.

[Named setter controls](setter-controls.json): four additional browser checks cover `/setter/will_avelar` and the playlist at 390 and 1440 pixels. Both fit the viewport; Back and Share sit fully below the actual header. The browser accessibility tree names the button “Back”. This is accessibility-tree evidence, not a claimed real screen-reader announcement.

Physical-phone LCP and time-to-interactive comparisons were not measured. The owner requested implementation without baseline collection; no phone-performance result is inferred from the HTML budget. Gym geometry is recorded after scrolling to the preview on narrow screens.

## Retained synthetic gym

[Gym page](gym-390-after.png) and [loaded board art](gym-art-390-after.png) show a new local-only fixture at `/gym/bugbash7844-qa-gym`. The public page identifies it as fictional QA data. Its map and physical-board link precede install actions; the loaded climb image is 320px high. It is supplemental after-only evidence, not a physical gym photograph.

The fixture lives only in the verified Docker development database at loopback port 5432, database `main`. Stable UUIDs `78440000-0000-4000-8000-000000000001` through `...0004` identify the synthetic user, gym, board and tick. Its public catalog climb is pinch city7 (`000032F00F98496087BAFF1EC0D2B810`), Kilter layout 1, size 7, sets 1,20 at 40°. The fixture was inserted in one transaction and retained; no data was deleted. No production database was read.

Consent evidence belongs to the separate draft #7881. The shortened disclosure is not included in this application build. The requested physical lit-board footage and consented founder photograph remain outstanding.

## Help video review correction

A fresh reduced-motion visit exposed a shared translation subtree missing from four Help routes. The [before image](help-video-copy-before.png), application source `9c3a4abffa`, shows the raw play-hint key; the [after image](help-video-copy-after.png), source `3a8908870cda82750c8ff34a067ecca13d6b2a2e`, shows the translated instruction. Both use the same 390×664 viewport, declined consent and local data. Development controls are hidden by the capture harness.

[Before receipts](help-video-copy-before.json) reproduce the missing hint/fallback copy on four routes in English and Spanish. [After receipts](help-video-copy-after.json) confirm all eight fresh visits have translated video fallback text, no raw keys, no horizontal overflow and no page errors; gesture clips also show their translated reduced-motion hints. The spray walkthroughs do not have that gesture hint. The permanent forty-case regression covers all five locales, reduced motion, refused autoplay and both walkthrough variants, and fails on the prior selectors.

The final integrated source again passed all 64 required typecheck tasks. Its [populated artifact budget](help-fix-homepage-budget.json) is 36,976 gzip bytes, build `05Co87yhVYqwJygXcAWrL`, with twenty beta fixtures against 60,000 bytes. No new physical-phone performance claim is made.

## Final public review fixes

Application source `50d1211593194c3a1e076f08742ff49df6637583` integrates the five-fix public commit `d185fcad02e09a75e858f40fe05364d21eceaf38`. Both Astra reviewers approved that committed batch; a separate Astra review approved preserving every integration-branch install placement and appending `auth-login` once. Eight focused suites pass 230 tests in the integration (212 on the public prerequisite), and all 64 required typecheck tasks pass.

[Before](playlist-ssr-before.json) and [after](playlist-ssr-after.json) JavaScript-disabled measurements reproduce the row bug and its fix. Phone rows are 117.8px tall; tablet/desktop rows are 140.2px. The old 107px absolute offsets overlap by 10.8px and 33.2px. Natural flow now has zero adjacent-row gaps at every width, while retaining the larger thumbnails. The before source is `d09aefa25f`; the after source is `50d1211593`. Both use the same declined-consent local fixture and scroll framing.

| JavaScript disabled | Before | After |
| --- | --- | --- |
| 390×664 | [Overlapping rows](playlist-ssr-before-390.png) | [Natural row spacing](playlist-ssr-after-390.png) |
| 844×900 | [Overlapping rows](playlist-ssr-before-844.png) | [Natural row spacing](playlist-ssr-after-844.png) |
| 1440×900 | [Overlapping rows](playlist-ssr-before-1440.png) | [Natural row spacing](playlist-ssr-after-1440.png) |

[Settled scroll traces](playlist-windows.json) independently show actual virtualization at all three widths. On this seventeen-climb fixture, the rendered window starts at index 0, advances to 6–16 near scrollY 2400, then returns to index 0. Leading spacers grow to 708px/840px and return to zero; mounted counts fall to eleven and recover to sixteen/seventeen. These are condensed direct browser diagnostics. They establish bounded range movement and scroll-space preservation; the separate JavaScript-disabled measurements establish per-row gaps. Larger/empty windows and session extras have unit regressions. An earlier relative-target automated probe timed out and is not counted as a passing test; its cause is unverified. Astra recommended using the repeatable direct traces, with no application change for that probe.

The empty local gym's [before](gym-discussion-before.json) and [after](gym-discussion-after.json) receipts cover fresh English and Spanish server rendering. The five unchanged strings moved from gyms to the kiosk namespace the page already reads. [Before image](gym-discussion-before-en-US.png) and [after image](gym-discussion-after-en-US.png) show the raw key replaced by readable copy. All five locales and both discussion-count branches have real-catalog tests.

[Phone and desktop sign-in links](auth-install-source.json) contain the dedicated `auth-login` campaign token for both stores. The install-placement union, exact-list guard, callback behavior and caller attribution pass the integration suite. Own-property icon lookup retains default/unknown glyphs and custom emoji without rendering inherited object members.

[Mirrored crop comparison](crop-edge-comparison.png) is a labeled synthetic geometry diagram, not a board photograph or a seeded real climb. All four cells use the actual helper output for a 100×200 board and a single hold at (95,190), radius 8, with equal 5:7 slots at 2× size. The [old output](crop-edge-before.json) emits an invalid double-minus translation for the mirror; the [fixed output](crop-edge-after.json) clamps reflected X to zero. [Chromium parsing and centre bounds](crop-edge-browser.json) confirm the unmirrored hold stays visible, while the mirrored hold disappears before and returns afterward. No physical controller claim is made.

The final compiled [populated-fixture homepage](final-public-review-homepage-budget.json) is 36,975 gzip bytes, build `iCKStpFbr9TyDkv8Urt45`, with twenty beta rows. The preview was stopped for validation, then restarted with updated tester notes. A malformed ignored dev validator was preserved outside the checkout before the successful 64-task rerun; application source and production type checks were unchanged.


## Visual restoration verification

Application source `6189e0f108cd39acaf0ad5119ff46b64bd566541` passes all 65 required repository typecheck/build tasks. Seven focused hero, video, About, preview, shell and locale suites pass 262 tests. The existing public-phone suite passes twenty cases; the two real-pointer cases pass separately after explicit reduced-motion emulation. The final [compiled homepage fixture](visual-restoration-homepage-budget.json) passes at 37,281 gzip bytes with twenty beta rows against 60,000 bytes.

The new guards were tested against broken committed-source variants and then restored. Removing About's preview resources produces five failures for missing translated platform-group names; restoring the selector passes all five. Removing the desktop layout-centering fix makes the pointer test fail at hover because the moving target is intercepted by the video; restoring the fix passes both pointer cases. The original source bytes were restored in finally blocks and the working tree was clean afterward. Astra independently reviewed the actual code, pointer mechanism, supported Playwright API and current-main integration.

The final Home full-page captures also include Astra's approved full-width logbook band. [Measured layout](import-band-geometry.json) confirms its width matches the hero at 390, 844 and 1440px, with the action right of the copy on desktop and heading/body/link/assurance preserved in phone order. German tablet text also fits. This replaces the visually orphaned half-width card without changing copy or destination. About captures remain unchanged.

Final import-band application source `d459e124e9b49b1b416c466bcd1726c0b3902292` passes all 65 required repository tasks, 17 Home behavior tests and four direct layout checks. Its [compiled populated homepage](import-band-homepage-budget.json) is 37,286 gzip bytes with twenty beta rows. Astra independently approved the actual diff and both new captures. The current Home full-page captures use this source; unchanged About captures retain the provenance above.


## Final alignment after prerequisite merges

All four prerequisite PRs were owner-merged. The clean website branch was rebased onto main `51d4ec9ade`; final application source `f642c2e8a8755c4bb10ba33dd9261b14829cee79` preserves the reviewed visual files and all newer main code. The only extra application behavior retains the merged footer logo's navigation event. Astra independently reviewed the actual conflicts, tree comparison and focused assertion.

This source passes all 65 required repository typecheck/build tasks, 136 focused tests across nine files and all [22 browser cases](final-aligned-browser-summary.json), without skips or flakes (47.0 seconds). The [compiled populated homepage](final-aligned-homepage-budget.json) is 37,269 gzip bytes with twenty beta rows against 60,000 bytes. The footer click guard produces one real failure when its handler is removed, then all twelve footer cases pass after restoration. The stale donation guard entries were removed only after verifying that the already-guarded funding.body is the actual rendered copy.

The first check attempt hit concurrent automatic installs after main updated its pinned dependencies. One explicit frozen install completed successfully with unchanged manifests and lockfile; the complete rerun passed. The final preview uses HTTPS port 3000 and its actual backend on 8080. The HTML fixture is isolated; it is not a production-board-art or physical-phone performance measurement. Screenshot provenance remains as recorded above because layout, captures and visible copy are unchanged by this alignment.
