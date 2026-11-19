# Supported-board directory readability

The owner found the live compatibility cards hard to scan and rejected the repeated lighting, app, import and controller paragraphs. Astra recommended a separate presentation change before the private board-request form: one server-rendered list in the existing supported-board order, with a board heading, its real catalog layouts and one destination. Desktop rows align those three columns; phone rows stack them. A spray wall has its own row and setup destination. The list keeps the existing directory links and compatibility events.

Astra recommended the visible lead “Find your board and layout, then find a wall to climb on.” The metadata description is “See supported climbing boards and layouts, and find gyms with a wall you can climb on.” Both are translated in all six shipping locales. The existing page title, metadata builder and app-store actions remain. One existing logbook-guide link follows the list; detailed sync and connection instructions stay in their guides. Unused compatibility-only catalog paragraphs are removed.

The separate request-form change adds the invitation to request another board.

The local designer rubric assigns zero, one or two points to each of: finding a board, understanding its layouts, phone wrapping, action hierarchy and text readability. The work-item target is at least eight of ten with no critical functional or accessibility failure. This is a local expert assessment, not the original research panel score.

## Matched browser evidence

Chromium compared the original page from `0757401e2b6d66a96a077bff7432e524210a1025` with application source `3ff5f6352899051a46dff06771757fc0dee39702` at 390 × 900 and 1440 × 900. Each phase covered all six shipping locales against the same local seeded database with optional analytics denied. The original page and six website catalogs were temporarily overlaid in the candidate checkout, then restored byte for byte before candidate capture. Both phases hid only `nextjs-portal` and the development-only `[data-translation-editor]` controls. Production page styling was unchanged by the harness.

| English page | Before | After |
| --- | ---: | ---: |
| Visible words in main content | 511 | 147 |
| Main content height at 390px | 4,072px | 2,134px |
| Main content height at 1440px | 2,313px | 1,460px |
| Smallest board-row action height | 17px | 44px |

The nine rows retain the eight catalog brands and the separate spray-wall destination. All 24 page visits returned HTTP 200 without horizontal overflow or JavaScript page errors. All 108 after-state board-row action measurements are at least 44px tall. The 432 row-text samples have computed contrast of at least 6.48:1 after ancestor background alpha composition; none of those samples required image or gradient estimation. Keyboard navigation on the English phone and desktop renders gives the first board action a visible 2px focus outline. These receipts cover the directory rows, not every component elsewhere on the site.

The displayed gym counts are local seed data, not production coverage figures. The owner's screenshot remains a cropped live reference; the images below are the matched local comparison. The initial captures with development controls visible are retained in the campaign scratch directory; durable captures use the same exclusions in both phases.

- Phone: [before](boards-readability/before-phone.png), [after](boards-readability/after-phone.png), [keyboard focus](boards-readability/after-phone-focus.png).
- Desktop: [before](boards-readability/before-desktop.png), [after](boards-readability/after-desktop.png), [first screen](boards-readability/after-desktop-viewport.png), [keyboard focus](boards-readability/after-desktop-focus.png).
- Long translated phone rows: [French](boards-readability/after-fr-phone.png), [German](boards-readability/after-de-phone.png).
- All six locale measurements: [before](boards-readability/before-receipts.json), [after](boards-readability/after-receipts.json).

## Verification

The application source passed all 65 required repository typecheck tasks, the existing board-page tests and 264 catalog/terminology checks (267 focused tests total), scoped formatting/lint/type checks and the normal commit hooks. A confirmed base-branch CI failure in the profile metadata test was reproduced (one failed, nine passed), then fixed by adding only the explicit supported `zh-CN` alternate to its expectation. All ten profile cases then passed; canonical, indexability and privacy assertions remain.

The separate code-quality and designer Astra reviews run on the published PR. No work-item design score is claimed before that review.

The independent code review found that both markerless list containers needed explicit `role="list"`, matching the existing Help steps pattern and [WebKit's documented list heuristic](https://bugs.webkit.org/show_bug.cgi?id=259487#c3). The minimal attribute fix passed scoped formatting, lint and type checks and all three existing board-page tests. Actual server-rendered HTML exposes one nine-item directory list and eight nested layout lists, all with the explicit role. The layout captures remain applicable. Physical Safari/VoiceOver behavior was not tested; current-head CI and Astra re-review cover the follow-up.
