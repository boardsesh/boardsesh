# Board invitations and requests

The owner chose “Your board, on Boardsesh” and one invitation for climbers, gym staff and makers. The homepage keeps its showcase and links “We’re happy to add it” to the compatibility page. Astra recommended a form on that page, available without an account. A dedicated backend mutation writes to the private admin feedback inbox. Staff can filter and triage board requests there. Requests have no GitHub mirror or outbound mail action. The optional reply address requires explicit permission. The analytics success event carries the role only. The existing consent rules apply.

The designer reviews matched desktop and phone views and scores five criteria from zero to two: compatibility clarity, discovery of the request action, hierarchy around the hero, accessible form states, and language that works for all three audiences. The work-item target is eight of ten with no critical functional, privacy or accessibility failure. The reviewer records evidence and limitations separately from the score.

The canonical mirror builder accepts only the two bug-report sources. A focused regression passes a private board request to both the builder and the transport and requires a skipped result with zero network calls. Admin triage can change a status but cannot publish a report. The admin view displays an explicitly consented reply address as text. The browser form never puts fields in a query string. GraphQL request bodies are excluded by the backend Sentry configuration; insert failures are surfaced with a fixed error that omits driver parameters.

The owner asked for an immediate, more readable boards directory after seeing the repeated lighting and import descriptions on the live page. Astra recommended shipping the compact brand and layout list in its own PR so it can land independently of the private submission work. This follow-up adds the invitation and working request form to that directory.

The implementation review found three places where the resolver alone could not enforce the private-request contract. PostgreSQL debugging now omits feedback statements and bindings. A verified ingress address shares one five-per-minute Redis quota across replicas. An unavailable quota stops the write, with a local memory quota limited to explicitly local or test environments without configured Redis. HTTP errors keep the retry delay and discard GraphQL source and private values. The form submits over HTTP, and WebSockets reject this operation before parsing.

The private-request branch is stacked on the compact directory in PR #7906. Its rows, layout names, gym links, spray-wall destination, and search description carry through. The homepage invitation and the request form are the changes under review here.

## Browser comparison

The comparison uses the directory from PR #7906 at `54a95e8d8f` and the private-request candidate in the same local preview. Both use the same seeded gym data, signed-out session, declined consent, reduced motion and 1× rendering. The phone viewport is 390×664 and the desktop is 1440×900. Only development controls were hidden. The homepage showcase uses its reduced-motion poster in both captures. The candidate was captured after the visible Play control settled.

| Surface | Parent | Candidate |
| --- | --- | --- |
| Homepage, phone | [Before](board-requests/before-home-390.png) | [After](board-requests/after-home-390.png) |
| Homepage, desktop | [Before](board-requests/before-home-1440.png) | [After](board-requests/after-home-1440.png) |
| Boards, phone | [Before](board-requests/before-boards-390.png) | [After](board-requests/after-boards-390.png) |
| Boards, desktop | [Before](board-requests/before-boards-1440.png) | [After](board-requests/after-boards-1440.png) |
| New request form | | [Phone](board-requests/after-form-390.png) · [Desktop](board-requests/after-form-1440.png) |

At both widths the browser followed the invitation, tried all three roles, cleared email when follow-up was withdrawn and moved focus to the success message. All ten submissions were intercepted with synthetic responses. The rate-limit and write-error cases retained the entered data for retry. A separate test exercised the real private database and Redis with synthetic records and mocked outbound services. Browser screenshots do not include these records. [Parent receipt](board-requests/before-receipt.json) · [Candidate receipt](board-requests/after-receipt.json)

A separate first-visit check temporarily applied the reviewed compact consent banner at `015d70ef67` and simulated a region requiring consent in all six languages. The original German translation put the bottom 4.83px of the install button behind the banner. Astra recommended shortening the German sentence while retaining the climb, lights, queue and board invitation. In the final 390×664 check the six homepages had visible headings, unobscured install actions and 44px consent choices. The closest clearance was German at 22.36px. All overlay files were restored byte for byte. [Measurements](board-requests/consent-geometry.json) · [German first visit](board-requests/consent-de-390.png)

## Privacy review

The post-publication code review found that the shared analytics helper adds campaign and ad click fields to normal website events. The private request now uses the same consent gate and sends only its fixed role as an application event property. The PostHog SDK retains its event ID, timestamp and standard outer identity. Its final capture hook keeps only the role in the private event’s properties and excludes URL, referrer and person-property copies. Ordinary events retain their usual attribution. Tests exercise a tagged visit with both denied and granted consent and retain attribution on an ordinary event.

The admin inbox handles failures with a fixed retry message. Neither a browser GraphQL client error nor a database driver's bound search term is sent to the diagnostic sinks. Sentry receives a fixed diagnostic for a failed inbox read. These protections cover every filter, including All.

The installed Sentry GraphQL integration can attach source and operation names while parsing and executing a request. Yoga suppresses tracing of the private request and inbox list before parsing. Both use HTTP. WebSockets reject them before parsing, and unrelated operations retain their tracing. The forced-sampling test captures real SDK envelopes in memory, checks the source and root label of a public control, and checks that private names, aliases, comments and invalid literals stay out. The quota integration test pins its clock for the six fixture submissions so the test cannot cross a Redis window boundary.


The post-publication designer requested a settled Play control on the candidate’s phone poster. At 390×664 the 51.42px control appeared in the first viewport, and at 1440×900 it measured 64px. At each size the pointer hit the visible control, the locally served WebM began playing and advanced in real time, and a second click paused it. The showcase component, styles, film and homepage markup were byte-identical to the published feature at `36661383e2`. [Playback receipt](board-requests/settled-play.json)

## Gallery integration

The five request commits start immediately after `54a95e8d8f` and end at `3fa2274db3`. Astra recommended replaying precisely that range onto the published image gallery. The two branches share an older Git ancestor (`0757401e2b`) because the gallery was rebased. Starting there would also replay the superseded directory. The gallery supplies the layout images, captions, keyboard navigation and search metadata. This change adds the invitation and private request form to that page. Shared translations and generated GraphQL types incorporate both branches’ changes.

The two admin failure cases and the trusted-address quota test passed against local PostgreSQL and Redis on November 20. The fourth review fix pins the clock inside the quota test so all six submissions exercise the same minute.

The Node HTTP integration records GET query parameters before GraphQL execution. For a GET that contains a private feedback operation, Sentry drops the transaction and exports only a fixed error diagnostic. The abort logger uses the route path. Ordinary GraphQL GET requests keep their existing diagnostics. The installed SDK tests use a synthetic loopback server and in-memory telemetry to verify both private and public cases.

### Final gallery and form comparison

The parent gallery is `3cd6fac4ba`. The final request source is `b6b161e162`. At 390 × 900 and 1440 × 900, Chromium decoded all 17 layout images and the spray wall photograph. The invitation jumped to the form, withdrawing contact permission hid the email field, and the 44px submit button reached the confirmation. Each run intercepted one synthetic submission. Both pages fit the viewport and reported zero JavaScript errors. Both phases used reduced motion, denied optional analytics and hid the development-only Next.js and translation controls.

| Viewport | Gallery before the invitation | Gallery with invitation and form |
| --- | --- | --- |
| 390 × 900 | [Before](boards-gallery/after-en-US-phone.png) | [After](board-requests/gallery-form-390.png) |
| 1440 × 900 | [Before](boards-gallery/after-en-US-desktop.png) | [After](board-requests/gallery-form-1440.png) |

The final source passed all 65 workspace checks. Eight focused suites passed 88 assertions on the integrated gallery and private inbox. The two installed-SDK suites then passed eight checks, including both new transport-level privacy regressions. The earlier screenshots in this document show the pre-gallery directory. [Final browser receipt](board-requests/gallery-form-result.json)

The final gallery screenshots were taken after hydration and the rail measurements settled. The Kilter, Tension and MoonBoard controls each measured 44 × 44px on the phone. At desktop width Kilter fits without controls. Tension and MoonBoard still scroll, with 44 × 44px controls. End and Home moved each overflowing rail to its last and first layout. The form’s computed input background matched the site’s dark input token, `#2F234A`.
