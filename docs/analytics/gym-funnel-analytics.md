# Gym funnel analytics

The canonical event contract for the gym journey on www: find a gym, scan the QR
on the wall, land on the gym page, claim it, then manage it.

Source of truth: `packages/shared/analytics/src/gym-funnel.ts`, re-exported from
`@boardsesh/analytics`. Tests: `packages/shared/analytics/src/__tests__/gym-funnel.test.ts`
(`vp test run --project analytics --reporter=agent`).

## How to fire an event

Never write the event name as a string literal, and never destructure the
builder. Hand its whole return value to `trackGymFunnelEvent`:

```ts
import { gymClaimCtaClicked } from '@boardsesh/analytics';
import { trackGymFunnelEvent } from '@/app/lib/gym-funnel-analytics';

trackGymFunnelEvent(
  gymClaimCtaClicked({
    placement: 'gym-page',
    viewerState,
    gymUuid: gym.uuid,
  }),
);
```

Builders return the name and its properties **together** so a caller cannot pair
one event's props with another event's name. That is the failure a bare name
constant still allows, and it is invisible in PostHog until someone reads the
funnel. `trackGymFunnelEvent` (`packages/web/app/lib/gym-funnel-analytics.ts`)
is the only web call path that keeps the pairing intact end to end — pulling
`{ name, properties }` apart and calling `track()` yourself splits them back
into two arguments, which is the exact thing the builder exists to prevent.

### `viewerState` must come from a settled session

Pass a value that has already resolved: a server-read auth token, or
`useWsAuthToken().isAuthenticated`, whose query is gated on
`status !== 'loading'`. **Never** derive it from `useSession().status` in a
client island. `SessionProviderWrapper` mounts `<SessionProvider>` with no
`session` prop, so next-auth starts every page load at `loading` and settles
only after a round-trip to `/api/auth/session`. A server-rendered page paints
and hydrates first, so a tap that beats the round-trip — a QR poster scanned on
a phone is precisely that — would report a signed-in climber as `signed-out`.
`GymClaimViewerState` has no `loading` member on purpose, and one must not be
added: it would encode the hydration race as vocabulary instead of keeping it
out of the data.

## Why this is not in `SHARED_EVENTS`

`packages/shared/analytics/src/events.ts` is scoped to events fired by **both**
web and mobile — that scoping is the whole reason it prevents drift. Every event
here is www-only: the gym directory, the claim flow, and the manage console have
no mobile counterpart. They live in their own module.

## The seven events

| Event                    | Properties                                            | Fired by                                                                                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Gym Claim CTA Clicked`  | `placement`, `viewerState`, `gymUuid`                 | Every claim entry point: the gym-page call-out (`app/gym/[gym_slug]/gym-claim-cta.tsx`, and its phone copy above the boards), "Run this gym? Claim it" under the gym page's H1 (`gym-run-by-claim-link.tsx`), the gym preview sheet (`app/components/gym-entity/gym-detail.tsx`), the directory's closing claim prompt (`app/gyms/gym-directory-claim-link.tsx`), a result card's Claim this gym in claim mode (`app/gyms/gym-directory-card.tsx`), the manage page's lock state (`manage/manage-no-access-actions.tsx`), the create-gym duplicate list (`app/components/gym-entity/similar-gym-suggestions.tsx`), and in the app the gym map's expanded row (`app/gyms/index.tsx`) and the gym page (`GymPageScreen.tsx`) |
| `Gym Claim Submitted`    | `method`, `gymUuid`                                   | `ClaimGymDialog` on submit, before the mutation resolves                                                                                                                                                                                                                     |
| `Gym Claim Result`       | `status`, `gymUuid`                                   | `ClaimGymDialog` once the mutation settles, success or failure                                                                                                                                                                                                               |
| `Gym QR Scanned`         | `medium`, `gymSlug`                                   | The QR landing tracker on `/gym/[gym_slug]`, once, after `parseGymQrLanding` matches                                                                                                                                                                                         |
| `Gym Page CTA Clicked`   | `cta`, `gymUuid`                                      | The secondary CTAs on `app/gym/[gym_slug]/page.tsx`                                                                                                                                                                                                                          |
| `Gym Directory Searched` | `queryLength`, `boardTypes`, `hasGeo`, `resultsCount` | The gym directory search surface                                                                                                                                                                                                                                             |
| `Gym Manage Tab Viewed`  | `tab`                                                 | `app/gym/[gym_slug]/manage/manage-gym-content.tsx` on tab change                                                                                                                                                                                                             |

### Property values

| Property       | Values                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------- |
| `placement`    | `gym-page`, `gym-page-header`, `preview-sheet`, `directory-footer`, `directory-result`, `manage-lock`, `similar-gyms`, `similar-gyms-refusal`, `app-gym-list`, `app-gym-page` (see below) |
| `viewerState`  | `signed-in`, `signed-out` — only the gym page, a claim-mode directory card and the app's gym page can fire `signed-out`, see below |
| `method`       | `domain`, `admin` — mirrors the `GymClaimMethod` GraphQL enum                            |
| `status`       | `email_sent`, `approved`, `admin_review`, `error`                                        |
| `medium`       | `poster`, `kiosk`, `board` — only `poster` can fire today, see below                     |
| `gymSlug`      | The slug of the gym page the scan landed on                                              |
| `cta`          | `follow`, `kiosk`, `website`, `report-duplicate`, `report-problem` (see below)           |
| `tab`          | `overview`, `kiosks`, `insights`, `branding`, `profile`, `boards`, `members`, `comments` |
| `boardTypes`   | A **sorted, comma-joined string**, e.g. `kilter,tension`. Empty selection is `''`        |
| `queryLength`  | A number. The search text itself never leaves the browser                                |
| `hasGeo`       | A boolean, and only ever a boolean                                                       |
| `resultsCount` | A number                                                                                 |

`report-problem` is Report a problem on the gym page: the gym's own button or a
board row's flag. It replaces `report-duplicate` while the `directory-reports`
flag is on (docs/product/directory-reports.md); with the flag off the page still
shows Report a duplicate, so both values can appear.

`GymManageTabName` restates `VALID_TABS` from
`app/gym/[gym_slug]/manage/manage-gym-content.tsx`. It is restated rather than
imported because a shared package must never depend on `packages/web`; adding a
tab there without adding it here is a compile error at the call site.

### `viewerState: signed-out` comes from gyms nobody runs, mostly on the gym page

**Read this before using `Gym Claim CTA Clicked` to answer H4** ("does a visible
self-serve claim CTA convert unclaimed gyms"). Since #3672 the gym page shows
the claim call-out to anonymous visitors, so `signed-out` is real data there —
but on a narrower population than "public gyms":

- `app/gym/[gym_slug]/page.tsx` renders it whenever the gym is public and
  `resolveClaimCtaVariant` (`app/gym/[gym_slug]/gym-claim-cta-logic.ts`) doesn't
  return `hidden`. `hidden` covers the signed-in viewer who already covers the
  gym — the resolver's `canClaim = !!authenticatedUserId && …` is false for
  owners, gym admins/editors and covering community leaders
  (`packages/backend/src/graphql/resolvers/social/gyms.ts`).
- **Both arms require a gym its staff don't run.** Since #8043 the call-out
  switches on `gym.listingState`: `RUN_BY_GYM` (an approved claim or an admin
  handover) hides it from everyone, signed in or not, and an ownership dispute
  goes through Report a problem. `UNCLAIMED` and `CLIMBER_LISTED` show it. Until
  2026-11-23 the anonymous arm read `gym.isClaimed`, which was true for a gym a
  climber added, so those gyms sent no `signed-out` events before that date and
  do after it.
- The anonymous arm sends the owner through the auth modal with a
  `callbackUrl` back to `/gym/<slug>?claim=1`, so the claim intent survives an
  OAuth round-trip and the dialog re-opens on return.

**The `signed-out` denominator is anonymous pageviews of public gyms their
staff don't run, not of all gym pages.** Dividing `signed-out` claim clicks by
total gym pageviews understates the conversion rate by whatever share of traffic
lands on gyms run by their staff — the well-run, heavily-visited end of the
directory. Restrict both sides of the ratio to those gyms before quoting a
number.

The other two entry points won't fire it, so an unsplit `signed-out` share
under-reads:

- `app/components/gym-entity/gym-detail.tsx` gates on `canClaim` directly.
- `app/components/gym-entity/similar-gym-suggestions.tsx` gates on
  `gym.isClaimable`, which `computeClaimableFlags` only computes for an
  authenticated viewer (`…/social/gym-matching.ts`).

Both of those read `viewerState` off `useWsAuthToken().isAuthenticated`, which
is `false` while the token is in flight — their render gates make that race
unreachable in practice, so treat their `signed-out` count as noise if one ever
appears rather than as a signal.

`directory-result` and `app-gym-page` fire `signed-out` too, but each only after
the visitor chose to look for their gym (claim mode) or opened a gym in the app.

**Filter on `placement in ('gym-page', 'gym-page-header')` before reading the `viewerState` split.**
Across all placements the denominator includes two surfaces that effectively
never report `signed-out`, which drags the anonymous share toward 0 for reasons
that have nothing to do with how signed-out climbers behave.

## Two rules that are easy to break

**`boardTypes` must be a string, not an array.** Web's `track()`
(`packages/web/app/lib/analytics.ts`) types properties as
`AllowedPropertyValues = string | number | boolean | null | undefined`, so an
array is a compile error at the call site — flatten it in the builder.
`gymDirectorySearched` sorts before joining so `['tension','kilter']` and
`['kilter','tension']` are one PostHog value instead of two. An empty selection
becomes `''`, not `undefined`, because `undefined` is stripped before ingest and
would make "searched with no board filter" indistinguishable from "the property
was never sent".

**No location precision, ever.** `hasGeo` is a boolean. No builder in this module
accepts or emits latitude, longitude, or accuracy in any shape, and a test
asserts over `Object.keys` of every payload that nothing matching
`/lat|lon|lng|coord|accuracy/i` can appear.

## QR landing param contract

Printed QR codes point at a normal Boardsesh URL carrying two extra params:

```
/gym/boulderwelt?src=qr&medium=poster
```

| Export                | Value                          |
| --------------------- | ------------------------------ |
| `GYM_QR_SRC_PARAM`    | `'src'`                        |
| `GYM_QR_MEDIUM_PARAM` | `'medium'`                     |
| `GYM_QR_SRC_VALUE`    | `'qr'`                         |
| `GYM_QR_MEDIUMS`      | `['poster', 'kiosk', 'board', 'desktop']` |

- `buildGymQrHref(path, medium)` builds the URL a QR encodes. Its output gets
  printed on laminated posters and stuck to walls, where a wrong href can't be
  patched, so it handles the two shapes a naive append breaks on: a **fragment**
  (`/gym/x#boards` — appending at the end buries the params inside the fragment,
  which never reaches the server) is split off and re-attached last, and a
  **pre-existing `src` or `medium`** (`/gym/x?src=email` → `?src=email&src=qr`,
  which Next surfaces as a `string[]` that the parser then rejects) is dropped so
  ours wins. Every other param is preserved.
- `parseQrLanding(searchParams)` returns `{ medium }` or `null`. It is
  deliberately strict, because it decides whether an acquisition event fires:
  `src` must equal `'qr'` exactly (no trimming, no case folding), `medium` must
  be a known member, and an array-valued `src` or `medium`
  (`?medium=kiosk&medium=poster`) is rejected outright rather than picking one —
  a duplicated param is a hand-edited or crawler-mangled URL, not a scan.
- Each landing page narrows it to the mediums its codes print:
  `parseGymQrLanding` to `GYM_PAGE_QR_MEDIUMS` (`poster`, `kiosk`, `board`; a
  climb page's `desktop` code never names a gym, so it can never fire
  `Gym QR Scanned`), `parseBoardQrLanding` to `kiosk` and `board`, and
  `parseClimbQrLanding` to `desktop`. `gymQrAttributionQuery`, which carries the
  pair through the gym and `/b/{slug}` redirects, uses the gym parser.
- `stripGymQrParams(search)` drops the two params and keeps the rest, so the
  landing surface can rewrite the URL after firing. Without that rewrite, a
  shared or bookmarked link re-attributes someone else's visit to a poster. It
  filters the raw `&`-separated pairs instead of round-tripping through
  `URLSearchParams`, which would re-encode what it keeps — `?q=hello%20world`
  becomes `?q=hello+world`, and a valueless `?embed` becomes `?embed=`. The
  result is written into the address bar, so an untouched param must not visibly
  change shape.

### Which code fires which event

Eight printed or on-screen codes share the param contract above, and they land
on seven kinds of page, so a scan is counted by one of seven events:

| `medium` | Code | Lands on | Event |
| --- | --- | --- | --- |
| `poster` | The gym poster (`/gym/{slug}/poster`) | `/gym/{slug}` | `Gym QR Scanned` |
| `kiosk` | The kiosk screen's per-board install code (`app/components/kiosk/board-slot/board-install-qr.tsx`) | `/b/{slug}`, then `/b/{slug}/{angle}/list` | `Board QR Scanned` |
| `board` | The board poster (`/poster/b/{slug}`, #4415): `boardQrUrl(slug, 'board')`, with an unlisted Spraywall's `wall=<uuid>` in front of the pair | `/b/{slug}`, then `/b/{slug}/{angle}/list` | `Board QR Scanned` |
| `desktop` | The code beside "Open in your browser" on a climb page, shown from md (900px) only: `climbQrUrl(handoffPath, locale)`, the climb page itself in the reader's language | The same climb page, in either tree | `Climb QR Scanned` |
| `desktop` | The same code on a board's climb list, shown from md only: `listQrUrl(basePath, locale)`, page 1 of the list the reader is on | The same list, in either tree | `List QR Scanned` |
| `desktop` | The same code on a setter's page, shown from md only: `setterQrUrl('/setter/{name}', locale)`, page 1 of the setter's climbs | `/setter/{name}` | `Setter QR Scanned` |
| `desktop` | The same code on a public playlist, shown from md only: `playlistQrUrl(uuid, locale)` | `/playlists/{uuid}` | `Playlist QR Scanned` |
| `desktop` | The same code in the home hero, shown from 1100px only: `homeQrUrl(locale)` | `/` | `Home QR Scanned` |

`Gym QR Scanned` stays poster-only: its tracker mounts on `/gym/[gym_slug]` and
nowhere else, and it carries `gymSlug`. A `kiosk` or `board` row on it means
someone pointed a new code at a gym page.

`Board QR Scanned` is in `SHARED_EVENTS`, built by `boardQrScanned`
(`packages/shared/analytics/src/board-qr-events.ts`):

| Property | Values |
| --- | --- |
| `medium` | `kiosk`, `board`. A `/b` landing with `medium=poster` counts nothing: no board code prints it, so `parseBoardQrLanding` (the strict parser, narrowed to `BOARD_QR_MEDIUMS`) refuses it |
| `surface` | `web` for the www page, `app` when the code opened the app (below) |
| `boardType` | One of the nine board types (`kilter`, `spray`, …) or null, from `boardTypeProperty` |

Its properties name no board: no slug, no name, no uuid, no gym. A Spraywall's
slug is made from its name, and its uuid opens an unlisted one, so the
Spraywall telemetry rule applies (`docs/product/spray-walls.md`, "Telemetry"), and the
payload is checked by the same test. The web SDK still stamps the page URL
(`$current_url`, `$pathname`) on this event as on every other one, so the
`?wall=` capability has to be scrubbed from it there, as it is for `$pageview`.

`QrLandingTracker` with `kind="board"` (`app/components/climb-front-door/qr-landing-tracker.tsx`)
fires it, on both branches of the list page: the Spraywall front door and the
catalogue board list. Two ways it differs from the gym tracker:

- **It reads the pair in the browser.** The list page's HTML is stored at the
  edge with a shared `s-maxage`, so the server cannot say whether this visit came
  off a code. `captureQrLanding('board')` (`app/lib/qr-landing.ts`) parses
  `window.location.search` with `parseBoardQrLanding`, the strict
  `parseGymQrLanding` narrowed to the board mediums, and remembers the answer
  for that page, so the store buttons can still read it after the strip.
- **It keeps `?wall=`.** Only `src` and `medium` leave the address bar. The
  `wall` param is what opens an unlisted Spraywall, and a reload without it is a
  404.

Both trackers strip one task later, like `useClaimParamStrip`: on the hydration
commit their effect runs before Next has patched `history.replaceState`, and a
native call then leaves the router's own URL holding the pair. Both count only
once consent has settled (`useConsent().granted`).
Consent resolves after the hydration commit, because the session and the
region lookup are async, and `track()` drops anything sent before that. The
gym tracker counted on mount until #4415, so it lost nearly every cold scan:
read `Gym QR Scanned` from before that deploy as broken, not as zero scans. The
address-bar cleanup does not wait for consent.

Kiosk scans start counting with this event. There is no kiosk scan count before
its deploy, so annotate the date and do not read the first week as growth.

**A board code opens the app when the app is installed.** `/b/` is claimed for
the app on both platforms (the iOS association file's `/*`, and Android's
`pathPrefix: '/b/'`), so a phone with Boardsesh skips the web page. The app
counts those scans itself: `app/b/[board_slug]/index.tsx` and
`app/b/[board_slug]/[angle]/list.tsx` read the pair with the same strict
`parseBoardQrLanding`, and `BoardRouteHandoff` fires `Board QR Scanned` with
`surface: 'app'` once its hand-off has opened the board
(`packages/mobile/src/lib/board-qr-scan.ts`). A dead slug, a refused wall or a
bounce to login counts nothing. The capture waits for the SDK when consent is
already given, and is dropped without consent. The same landing counts once in
60 s, because a signed-out cold start can reach the route twice (the consent
prompt's deferred destination and the sign-in replay). The browser app sends
nothing: `app` means the store app.

A signed-out scanner is sent to login first. The deep-link provider keeps the
link through sign-in, and its allowlist (`parseBoardLinkPath` in
`packages/mobile/src/lib/routing/board-deep-link.ts`) keeps `src` and `medium`
as a pair `parseBoardQrLanding` accepts, rewritten to `src=qr&medium=…`. So the
scan that brings a new installer into the app is counted when the replayed
link opens the board, up to a day later.

Read the two surfaces as two populations. `surface: 'web'` counts phones
WITHOUT the app, plus scanners that open links in their own browser. That is
the population the store buttons are for, so read installs against it without
the dilution the gym page has (below). `surface: 'app'` counts climbers who
already had the app, or installed it and signed in. Scans before the app's
deploy fired nothing there, so annotate the date.

**Printing the poster from the app.** The app's share sheet
(`BoardShareSheet`, opened from a Spraywall's Share link and from the board
detail sheet) offers "Print a poster" for a Public or Unlisted Spraywall or
board. `buildSprayWallPosterUrl` (`lib/spray/spray-share.ts`) and
`buildHomeBoardPosterUrl` (`lib/board-share/board-share-link.ts`) build
`/poster/b/{slug}`, plus `?wall=` for an unlisted Spraywall. Never `?invite=`:
a Followers or Invite-only board gets no poster. The page opens in the in-app
browser, never through `Linking`, because a phone that still holds an
association file claiming `/poster` would hand it straight back to the app.
For a `/poster` link tapped outside a browser while that older file is still on
the phone, `app/poster/[...rest].tsx` re-opens the same page in the in-app
browser and puts Home underneath. Only `wall` (a uuid) and `layout` (`photo`,
`plain`, `cards`) are carried over (`posterPageUrlFromRoute`).

`/b/...` is itself a www climbing surface that #4358 is deleting. When it goes,
the kiosk and board codes need a new target; the params and the builders in
`app/lib/gym-attribution.ts` survive that move unchanged.

### `Climb QR Scanned`: the desktop code on a climb page

A climb page on a laptop shows a QR code beside "Open in your browser", so a
climber reading it at home can carry the climb to the phone they will hold at
the wall. It encodes the page itself, `…/view/{climb}?src=qr&medium=desktop`
(`climbQrUrl` in `app/lib/gym-attribution.ts`), from `handoffPath`: on
`/b/{slug}` it keeps the board the reader arrived with, like the hand-off. The
code is rendered on the server (`PhoneQrCard`, `qrcode.react`'s `QRCodeSVG`) and
hidden below md with CSS, so it ships no JavaScript and every reader gets the
same HTML.

`Climb QR Scanned` is in `SHARED_EVENTS`, built by `climbQrScanned`
(`packages/shared/analytics/src/climb-qr-events.ts`):

| Property | Values |
| --- | --- |
| `medium` | `desktop`. A climb landing with any other medium counts nothing: `parseClimbQrLanding` (the strict parser, narrowed to `CLIMB_QR_MEDIUMS`) refuses it |
| `surface` | `web` for the www page. `app` is reserved for the app's own landing, which is not built |
| `boardType` | One of the nine board types or null, from `boardTypeProperty` |

Nothing names the climb: no uuid, no name, no setter. The page URL the SDK
stamps on every event already says which climb it was.

`QrLandingTracker` with `kind="climb"` fires it, mounted on the climb page in
both trees. It works like the board tracker above: it reads the pair in the
browser (the climb page is stored at the edge for 24 hours), strips `src` and
`medium` one task later, and counts once consent has settled, once per
pathname. The server never reads the pair: the canonical, the JSON-LD and the
HTML are the same with or without it, and `hasUserSpecificQueryParams`
(`app/lib/list-page-cache.ts`) ignores both params, so a scanned URL is still
CDN-cached.

What it counts: phones **without** the app, plus phones that open links in
their own browser. A phone with Boardsesh opens climb links straight in the app,
which reads no pair today, so those scans count nothing. Read `Climb QR Scanned`
as "a laptop reader sent the climb to a phone that needed the app", and read
its installs against it.

After a scan the climb page's store links (the phone's store badge and the
sticky install bar) add the medium: the link id becomes `climb-view.desktop`
or `sticky-bar.desktop`, `utm_medium` becomes `qr`, and `App Install Click`
carries `qrMedium: 'desktop'`. The hook is `useQrLandingMedium('climb')`.

The QR card's own App Store and Google Play buttons are a laptop's store
clicks, so they carry their own placement and link id, `climb-qr-card`, apart
from the phone's `climb-view`.

### `List QR Scanned`: the desktop code on a board list

A board's climb list on a laptop shows the climb page's code beside its own
"Open in your browser" (`FrontDoorHeroCta`, shared by both pages). It encodes
page 1 of the list the reader is on, `…/{angle}/list?src=qr&medium=desktop`
(`listQrUrl` in `app/lib/gym-attribution.ts`), so on `/b/{slug}` it keeps the
board. Same medium, same strict parser (`parseClimbQrLanding`) and the same
three properties as `Climb QR Scanned`; built by `listQrScanned` in
`packages/shared/analytics/src/climb-qr-events.ts`. It has its own name so
`Climb QR Scanned` stays a count of climb pages.

`QrLandingTracker` with `kind="list"` fires it, mounted by `StaticListFrontDoor`
in both trees. On `/b/{slug}/{angle}/list` it sits beside the `board` tracker
the page has always mounted: each kind reads only its own mediums, so a kiosk
or poster scan is still one `Board QR Scanned` and a laptop scan is one
`List QR Scanned`, never both. Either tracker strips the pair once it has read
its own landing.

After a scan the store link id adds the medium only where the page's store
buttons read that kind. The config-tuple list's buttons read `list`, so a
laptop scan there gives `climb-list.desktop`. The `/b` list's buttons keep
reading `board`, so they still say `climb-list.kiosk` or `climb-list.board`
after a printed code, and a laptop scan there leaves the plain `climb-list`
link id. Count those scans with `List QR Scanned` instead.

As on the climb page, the QR card's own store buttons are a laptop's clicks
and carry their own placement and link id, `climb-list-qr-card`, apart from
the phone's `climb-list`.

### `Setter QR Scanned` and `Playlist QR Scanned`: the desktop code on a setter page and a playlist

A setter's page and a public playlist show the same laptop code, from md
(900px) only, through the same `PhoneQrCard`. Each encodes its own page with
`?src=qr&medium=desktop`: `setterQrUrl` gives page 1 of the setter's climbs,
`playlistQrUrl` gives `/playlists/{uuid}` (both in `app/lib/gym-attribution.ts`).
Same medium, same strict parser (`parseClimbQrLanding`) and the same three
properties as `Climb QR Scanned`, built by `setterQrScanned` and
`playlistQrScanned` in `packages/shared/analytics/src/climb-qr-events.ts`. Each
has its own name so no page's count is inflated by another's.

`QrLandingTracker` fires them: `kind="setter"` on the setter page, with
`boardType` the board most of that page's climbs sit on, and `kind="playlist"`
on a public playlist, with the playlist's board. A private playlist shows no
code and mounts no tracker: its link opens nothing on a phone that is not
signed in as the owner.

The store buttons read the same kind, so a store click after a scan gives the
link ids `setter.desktop` and `playlist.desktop`. On the setter page the
phone's store pair (`setter`) shows below md only; from md the QR card's pair
takes its place. The QR cards' own store buttons are a laptop's clicks and
carry their own placements and link ids, `setter-qr-card` and
`playlist-qr-card`.

### `Home QR Scanned`: the desktop code in the home hero

From 1100px the home hero shows the same `PhoneQrCard` with both store badges
in place of the phone's badge (later than the climb pages' 900px, because the
home hero's two columns leave too little room for two badges beside the code
below that). The code encodes `/` in the
reader's language with `?src=qr&medium=desktop` (`homeQrUrl` in
`app/lib/gym-attribution.ts`). Same medium, parser and properties as the other
desktop codes, built by `homeQrScanned`; the home page shows no board, so
`boardType` is always null. `QrLandingTracker kind="home"` is mounted by
`app/page.tsx`.

The phone that scanned lands on the home page, whose badge (`placement =
'hero'`) reads the same kind, so a store click after a scan has the link id
`hero.desktop`. The QR card's own badges are a laptop's clicks and send
`placement = 'home-qr-card'`.

### A scan only counts if the page loads: iOS and the association file

`Gym QR Scanned` fires from a tracker on the www gym page, so a scan that never
loads that page is never counted. On an iPhone with Boardsesh installed that
used to be every scan. The iOS association file claimed `/*` for the app, the
app has a `/gyms` directory but no `/gym/{slug}` screen, and an unmatched link
falls through `+not-found` to Home. The climber saw the app's Home tab and
PostHog saw nothing.

`app/lib/apple-app-site-association.ts` now lists `/gym` in
`WEB_ONLY_PATH_PREFIXES`, which emits `NOT /gym/*` plus one entry per locale
prefix (`NOT /es/gym/*`, `NOT /fr/gym/*`, `NOT /de/gym/*`) above the catch-all.
That keeps the gym page, `/gym/{slug}/poster` and `/gym/{slug}/manage` in the
browser. `/gyms` is not matched and still opens the app. `/poster` is listed
the same way for the board poster print page (`/poster/b/{slug}`); the
`/b/{slug}` code that page prints still opens the app.

Four things to know before reading an iOS scan count:

- **The change is not instant.** Phones do not fetch the file from www. Apple's
  CDN does, and a phone asks the CDN on install, on app update and about once a
  week after that. Allow a week before treating "no iOS scans" as a real zero.
  `https://app-site-association.cdn-apple.com/a/v1/www.boardsesh.com` shows the
  copy Apple is serving.
- **Android was never affected.** The store build opens `/join`, `/preview`,
  `/b/`, the board-route prefixes (`/kilter/`, `/tension/` and the rest, plus
  their `/es`, `/fr`, `/de` forms) and `/auth/reset-password` in the app. It
  does not claim `/gym` or `/poster`, so a gym poster scan has always reached
  the web page there.
- **Climbers who already have the app are in the count, and the page cannot
  hand them back to it.** Their scan now loads the gym page and fires
  `Gym QR Scanned`, but they cannot install. The board links on the page are
  same-site navigations, which iOS never treats as universal links, and the
  only app-bound controls are the two store buttons. So scan-to-install read
  straight off the funnel is diluted by existing users. Until the page has an
  "Open in Boardsesh" control (not built yet), split scans by whether an
  install was possible before quoting a pilot rate.
- **If the app ever gets a `/gym/{slug}` screen**, removing the exclusion sends
  scans back into the app, and the scan event then has to fire from the app
  too. `/poster` and `/manage` would still need to stay on the web.

### Carrying the params through a redirect

Two redirects would otherwise silently unattribute a scan, and both now re-emit
the pair through `gymQrAttributionQuery` (`app/lib/gym-attribution.ts`):

- `app/b/[board_slug]/page.tsx` → `/b/{slug}/{angle}/list`
- the merged-twin 308 in `app/gym/[gym_slug]/page.tsx` → `/gym/{canonical}`

The second is the one that matters: a poster is laminated and stuck to a wall,
and the gym it names can be merged into another listing a year later. The helper
is a strict allowlist — it re-serialises `src` and `medium` from the contract's
own constants after `parseGymQrLanding` has accepted them, so nothing a crafted
link carries (`?medium=evil`, someone else's `utm_campaign`, a `?next=` URL)
rides through a redirect into a URL we publish. Its entire reachable output is
three fixed strings plus the empty one, and it returns `''` rather than `'?'`, so
an ordinary visit still redirects to a clean URL.

Since #6027 the merged-twin 308 also carries the campaign params a visit landed
with (`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`,
`gclid`), through `gymRedirectAttributionQuery`. A gym's bio link to an old slug
(`/gym/old-slug?utm_source=instagram&utm_medium=social`) used to arrive on the
canonical page as direct traffic. It is still an allowlist: those six names
only, each value trimmed and capped at 200 characters and re-encoded, so
`?next=` and `?claim=` are dropped as before. Carrying them gives a crafted link
nothing it did not have, since the same params on the canonical URL are read
with no redirect involved. The `/b/{slug}` redirect still carries the QR pair
only.

The board list (`/b/{slug}/{angle}/list`) strips the pair too, since
`Board QR Scanned` (#4415): a climber who shares the URL after a kiosk or poster
scan passes on a clean link, and a recipient is not counted as another scan.

## Amendments to issue #4374

The issue's literal wording could not be honoured in four places. Anything not
listed here matches #4374 exactly.

**`admin_review`, not `admin_sent`.** The issue writes the claim-result union as
`'email_sent' | 'approved' | 'admin_sent' | 'error'`. There is no `admin_sent`
anywhere in the system. The `GymClaimRequestStatus` GraphQL enum
(`packages/shared-schema/src/schema/gyms.ts`) declares `email_sent`,
`admin_review`, and `approved`, and the resolver
(`packages/backend/src/graphql/resolvers/social/gym-claims.ts`) returns
`{ status: 'admin_review' }`. Shipping `admin_sent` would force every call site to
remap a value it already holds, and any site that forgot would emit a status
matching nothing in the backend. `error` stays ours: the mutation threw or the
network failed, so no `GymClaimRequestStatus` exists to report.

**Three `GymPageCta` members dropped.** The issue lists
`'install' | 'follow' | 'kiosk' | 'website' | 'directions' | 'report-duplicate' | 'report-listing'`.
Shipping a member with no call site creates a value that can never appear in
PostHog, which reads as a broken breakdown rather than a zero.

- `install` — installing is not a `Gym Page CTA Clicked` at all. It stays on
  `App Install Click`, which five existing web call sites already fire, so the
  install funnel stays one funnel. See "The gym-page install CTA" below.
- `directions` — no such CTA. The address renders as plain text on
  `app/gym/[gym_slug]/page.tsx`, not a map link.
- `report-listing` — belongs to #4385, out of scope for this tier. Report-a-
  **duplicate** is a different, existing CTA and is kept.

**`boardTypes` ships as a string, not an array.** #4374's AC1 gives
`Gym Directory Searched` a `boardTypes` array. The value is a sorted
comma-joined string instead — a real property-shape deviation, not a naming
one, so it is called out here as well as in the rules above. An array cannot go
down the web `track()` path at all — `AllowedPropertyValues` types it out — so
the issue's literal shape is not expressible without flattening it first.
The property name is unchanged, and the sorted join keeps one filter
combination as one PostHog value.

**`Gym QR Scanned` carries `gymSlug`, as the issue says — an earlier draft of
this module used `landingPath` and that was wrong.** Recorded so it is not
re-proposed: the reasoning was that the kiosk's per-board QR encodes `/b/{slug}`,
which is a board slug, so a gym-slug property looked unfillable for
`medium: 'board'`. The premise was false. This event only fires from the QR
landing tracker on `/gym/[gym_slug]`, and `app/b/[board_slug]/page.tsx` is a
bare `redirect('/b/{slug}/{angle}/list')` that renders no tracker and drops the
query string, so a board scan cannot produce this event under any property name.
`landingPath` would also have been a rename of a required property, which is the
one kind of drift this whole module exists to prevent — additive extras are
tolerable, renames split funnels. Board scans now have their own event,
`Board QR Scanned` (#4415, "Which code fires which event" above), which names
no board at all.

**`directory-card` was renamed to `directory-footer`.** The directory used to
repeat "Is this your gym?" on every unclaimed result row — 24 prompts a page —
and the prompt now renders once, under the list. Same event, same funnel step,
different denominator: one impression per page instead of one per row, so the
click rate before and after is not the same measurement. The old value stops
appearing the day this ships; any saved insight that filters on
`placement = 'directory-card'` needs updating, and a series that spans the cut
must be split at it rather than read as a trend. `gymUuid` is `null` on this
placement: one prompt under 24 gyms is not about a gym.

One addition in the other direction: **`GymClaimPlacement` gains
`similar-gyms`.** `app/components/gym-entity/similar-gym-suggestions.tsx` is
easy to mistake for a directory surface, but it is rendered only by
`app/components/gym-entity/create-gym-form.tsx` — it is the duplicate check
inside the create-gym flow, shown to someone who is about to add a gym that may
already exist. Folding it into the directory placement would merge "browsing the
directory" with "about to create a duplicate", which are opposite intents and
the two most interesting rows to tell apart.

### `similar-gyms-refusal`: Claim in the create refusal

`createGym` refuses a gym that looks listed (`GYM_SIMILAR_EXISTS`, docs/product/gym-board-governance.md), and www's `/gyms/new` then opens "Is it one of these?" with the gyms the server named (`similar-gym-refusal-dialog.tsx`). A Claim there is counted as `similar-gyms-refusal`, not `similar-gyms`: the climber had already pressed Save, so it is a duplicate the server stopped rather than one the live suggestions caught. `gymUuid` is the listed gym's.

### Claim placements added with the claim discovery work (#8043, PR 7)

Five values joined `GymClaimPlacement` on 2026-11-23. Each counts a new door, so
none of them is an alias of an older value and none should be summed into one:

- **`gym-page-header`**: "Run this gym? Claim it" in the run-by line under the
  gym page's H1. It opens the same dialog as the call-out, but it sits in the
  first screen on a phone, so `gym-page` vs `gym-page-header` is the read on
  whether a claim offer up top is found. The call-out's phone copy (above the
  boards below 960px) still counts as `gym-page`: it is the same call-out moved,
  not a new offer.
- **`directory-result`**: Claim this gym on a result card, shown only in claim
  mode (`/gyms?claim=1`, which the footer prompt, the for-gyms page and the site
  footer open). One per gym, so `gymUuid` is set. It is not the retired
  `directory-card`: that one counted a prompt on every row of every visit.
- **`manage-lock`**: Claim this gym on `/gym/{slug}/manage` for a signed-in
  climber who can't edit the gym. Always `signed-in`: the route sends everyone
  else to log in first.
- **`app-gym-list`** and **`app-gym-page`**: the first claim events the app
  sends. They go through the same builder (`gymClaimCtaClicked`), so app and www
  claims read in one breakdown. `app-gym-list` is always `signed-in` (the row
  only offers a claim on `canClaim`); `app-gym-page` sends `signed-out` when the
  card's button opens log-in. The app sends no `Gym Claim Submitted` or `Gym
  Claim Result` yet, so an app funnel ends at the click.

Two behaviour changes move these numbers too. A gym a climber added
(`listingState = CLIMBER_LISTED`) now offers the claim to signed-out visitors,
where before it counted as claimed and showed nothing, so `signed-out` clicks
come from a wider set of gyms than the section above describes. And a gym its
staff run (`RUN_BY_GYM`) offers no claim to anyone, signed in or not.

`Gym Claim Path Clicked` (`website-journey-events.ts`, the home page's and
/for-gyms' "Claim your gym" links) reading zero over the 90 days to 2026-11-23
is its age, not a fault: it shipped in #7883 on 2026-11-19. Both call sites are
same-origin links whose click handler calls `track()` before the soft
navigation. Read it again after a few weeks of traffic.

## The gym-page install CTA (#4374 AC2)

Not in this module, on purpose, and it is the one event in the epic that is not.

The gym-page install CTA fires **`App Install Click`**, the event five existing
web call sites (`home-page-content.tsx`, `capacitor-retirement-screen.tsx`)
already fire — not `Gym Page CTA Clicked`. Two funnels for one action would have
to be unioned every time anyone asks how many installs the product drives.

Its payload is `{ platform, source, placement: 'gym-page', gymSlug }`, plus
`qrMedium` when the click follows a scan (below).

- **`source` keeps its existing meaning and values** (`'google-play'`,
  `'app-store'`, `'capacitor-retirement'`, …). PH-13's install-source breakdown
  is grouped by it, and that breakdown has to stay comparable across this change,
  so `source` is not repurposed to carry the surface.
- **`placement` and `gymSlug` are added alongside it.** AC2 asks for those two
  properties; it is not asking for `source` to change meaning.
- **`qrMedium`** (`'poster' | 'kiosk' | 'board'`) is present only when the page
  was reached from a printed code. It is absent, not `null`, on a plain visit,
  so that payload is unchanged.

The builder lives in **`packages/web/app/lib/app-install-event.ts`**, added by
the wiring PR. It is deliberately not in `@boardsesh/analytics`: `App Install
Click` is web-only with no mobile counterpart, and a shared package should not
own an event neither platform shares — that is the same rule that keeps the
seven gym events out of `SHARED_EVENTS`.

The CTA itself is **`app/gym/[gym_slug]/gym-install-cta.tsx`** (#4379). It
renders both stores as real anchors — no platform sniffing, because an effect
that picks one store leaves the server HTML with no install link at all — drawn
as the official App Store and Google Play badges (black, 44px, App Store first,
neither styled as the primary), and uses the canonical slug (`gym.slug || gym_slug`), so a scan that 308s off a
merged twin's URL still reports one campaign rather than two.

### A poster scan and a page click are different links (#6027)

Until #6027 every gym-page Play link said `utm_medium=qr`, whether the visitor
scanned a poster or clicked through from the gym directory. An install could
not be put down to a poster, which is the one thing the poster pilot (#5657)
has to measure.

The gym page now hands the parsed `?src=qr&medium=…` landing to the CTA as a
`qrMedium` prop, and `buildStoreUrl` (`app/lib/store-links.ts`) turns it into
the link:

| Visit                         | `utm_medium` | link id (`utm_content`) | `utm_campaign` | App Store `ct`     |
| ----------------------------- | ------------ | ----------------------- | -------------- | ------------------ |
| Browsed to the gym page       | `web`        | `gym-page`              | `gym-<slug>`   | `gym-page`         |
| Scanned the gym's poster      | `qr`         | `gym-page.poster`       | `gym-<slug>`   | `gym-page.poster`  |

`utm_source` is `boardsesh` and `utm_campaign` is `gym-<slug>` in both rows,
the strings gym installs have reported since #4379.

The medium is a **prop**, not something the CTA reads from the URL:
`GymQrLandingTracker` strips `src` and `medium` from the address bar on mount,
so by the time a visitor reaches for the button the URL no longer says they
scanned anything.

A visitor who landed on a tagged link (`?utm_source=instagram&utm_medium=social`
on a gym's own bio link, say) keeps their source and medium in the store link.
Their `utm_campaign` wins too when they brought one; otherwise the campaign
stays `gym-<slug>`. The link id is always ours. A `utm_medium` of `organic` or
`(not set)` is the one tag not carried: the app would file the install as a
Play organic one (see `docs/analytics/growth-metrics.md`, "Store links"). That upgrade happens after
hydration, so the server HTML never depends on the visitor.

`qr` installs from before the #6027 deploy are gym-page clicks of any kind. Do
not compare `qr` counts across that date.

### Why the Play link carries `referrer`, not just `utm_*`

`buildPlayStoreUrl` (`app/lib/store-links.ts`) sets `utm_source`, `utm_medium`,
`utm_campaign` and `utm_content` **and** a `referrer` param holding a
percent-encoded copy of the same four. The `referrer` is the one that does the
work: Play populates the Install Referrer API from that query parameter, and
`packages/mobile/src/lib/install-referrer.ts` reads the string back with
`new URLSearchParams(raw)` to pull source, medium and campaign into
`Install Attributed`, keeping the whole string as `install_referrer_raw` (where
the link id is read from; the HogQL is in `docs/analytics/growth-metrics.md`). A link with
only the bare `utm_*` params reads correctly to a human, matches #4379's literal
wording, and attributes **zero** installs, because the app never sees them.

The bare `utm_*` params stay on the link anyway, but do not assume a consumer
for them: they are kept because they are harmless and make the link readable at a
glance (and greppable in a log) without decoding the nested `referrer`. Whether
Play's own acquisition reporting reads them has not been verified here — the
mechanism this section documents is `referrer`, and that is the one to rely on.

### The App Store link

Apple has no install referrer, so nothing about an iOS install reaches the app
or PostHog. The link carries a campaign token instead (`ct`, with `pt` and
`mt=8`), which App Store Connect counts in aggregate. All gyms share one token
per kind of link, because App Analytics hides a campaign with fewer than 5
first-time downloads. `pt` needs `NEXT_PUBLIC_APP_STORE_PROVIDER_ID`, which is
not set yet; see "Store links" in `docs/analytics/growth-metrics.md`.

## Properties deliberately not carried

`Gym Claim Result` does **not** repeat `method`, and `Gym Manage Tab Viewed`
carries no gym identifier — both match #4374's contracts (`{gymUuid, status}`
and `{tab}`), and both extras were considered and dropped.

- `method` on the result: PostHog funnels can break a step down by a previous
  step's property, so the claim path is already recoverable from the paired
  `Gym Claim Submitted`. The one case that loses resolution is
  `status: 'error'`, which cannot say on its own which path threw. Add `method`
  back if that breakdown is ever actually wanted.
- `gymUuid` on the manage tab: the console is owner-only, so a gym identifier
  would tie a named gym to one operator's navigation — scope the event was never
  asked to carry, for a view whose interesting question is "which tabs get used",
  not "which gym used them".

The gym page's `manage` button (editors only) is likewise **not** a `GymPageCta`
member: not in #4374's vocabulary, and an owner action rather than a step in the
discovery funnel. Add it with its own comment if a later PR needs it measured.
