# Board invitations and requests

The owner chose “Your board, on Boardsesh” and one invitation for climbers, gym staff and makers. The homepage keeps its showcase and links “We’re happy to add it” to the compatibility page. Astra recommended a form on that page, available without an account. A dedicated backend mutation writes to the private admin feedback inbox. Staff can filter and triage board requests there. Requests have no GitHub mirror or outbound mail action. The optional reply address requires explicit permission. The analytics success event carries the role only. The existing consent rules apply.

The designer reviews matched desktop and phone views and scores five criteria from zero to two: compatibility clarity, discovery of the request action, hierarchy around the hero, accessible form states, and language that works for all three audiences. The work-item target is eight of ten with no critical functional, privacy or accessibility failure. The reviewer records evidence and limitations separately from the score.

The canonical mirror builder accepts only the two bug-report sources. A focused regression passes a private board request to both the builder and the transport and requires a skipped result with zero network calls. Admin triage can change a status but cannot publish a report. The admin view displays an explicitly consented reply address as text. The browser form never puts fields in a query string. GraphQL request bodies are excluded by the backend Sentry configuration; insert failures are surfaced with a fixed error that omits driver parameters.

The owner asked for an immediate, more readable boards directory after seeing the repeated lighting and import descriptions on the live page. Astra recommended shipping the compact brand and layout list in its own PR so it can land independently of the private submission work. This follow-up adds the invitation and working request form to that directory.

The implementation review found three places where the resolver alone could not enforce the private-request contract. PostgreSQL debugging now omits feedback statements and bindings. A verified ingress address shares one five-per-minute Redis quota across replicas. An unavailable quota stops the write, with a local memory quota limited to explicitly local or test environments without configured Redis. HTTP errors keep the retry delay and discard GraphQL source and private values. The form submits over HTTP, and WebSockets reject this operation before parsing.

The private-request branch is stacked on the compact directory in PR #7906. Its rows, layout names, gym links, spray-wall destination, and search description carry through. The homepage invitation and the request form are the changes under review here.

## Browser comparison

The comparison uses the directory from PR #7906 at `54a95e8d8f` and the private-request candidate in the same local preview. Both use the same seeded gym data, signed-out session, declined consent, reduced motion and 1× rendering. The phone viewport is 390×664 and the desktop is 1440×900. Only development controls were hidden. The homepage showcase uses its reduced-motion poster in both captures.

| Surface | Parent | Candidate |
| --- | --- | --- |
| Homepage, phone | [Before](board-requests/before-home-390.png) | [After](board-requests/after-home-390.png) |
| Homepage, desktop | [Before](board-requests/before-home-1440.png) | [After](board-requests/after-home-1440.png) |
| Boards, phone | [Before](board-requests/before-boards-390.png) | [After](board-requests/after-boards-390.png) |
| Boards, desktop | [Before](board-requests/before-boards-1440.png) | [After](board-requests/after-boards-1440.png) |
| New request form | | [Phone](board-requests/after-form-390.png) · [Desktop](board-requests/after-form-1440.png) |

At both widths the browser followed the invitation, tried all three roles, cleared email when follow-up was withdrawn and moved focus to the success message. All ten submissions were intercepted with synthetic responses. The rate-limit and write-error cases retained the entered data for retry. A separate test exercised the real private database and Redis with synthetic records and mocked outbound services. Browser screenshots do not include these records. [Parent receipt](board-requests/before-receipt.json) · [Candidate receipt](board-requests/after-receipt.json)

A separate first-visit check temporarily applied the reviewed compact consent banner at `015d70ef67` and simulated a region requiring consent in all six languages. The original German translation put the bottom 4.83px of the install button behind the banner. Astra recommended shortening the German sentence while retaining the climb, lights, queue and board invitation. In the final 390×664 check the six homepages had visible headings, unobscured install actions and 44px consent choices. The closest clearance was German at 22.36px. All overlay files were restored byte for byte. [Measurements](board-requests/consent-geometry.json) · [German first visit](board-requests/consent-de-390.png)
