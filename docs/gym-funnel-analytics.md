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
| `Gym Claim CTA Clicked`  | `placement`, `viewerState`, `gymUuid`                 | Every claim entry point: the gym-page call-out (`app/gym/[gym_slug]/gym-claim-cta.tsx`), the gym preview sheet (`app/components/gym-entity/gym-detail.tsx`), the directory card, and the create-gym duplicate list (`app/components/gym-entity/similar-gym-suggestions.tsx`) |
| `Gym Claim Submitted`    | `method`, `gymUuid`                                   | `ClaimGymDialog` on submit, before the mutation resolves                                                                                                                                                                                                                     |
| `Gym Claim Result`       | `status`, `gymUuid`                                   | `ClaimGymDialog` once the mutation settles, success or failure                                                                                                                                                                                                               |
| `Gym QR Scanned`         | `medium`, `gymSlug`                                   | The QR landing tracker on `/gym/[gym_slug]`, once, after `parseGymQrLanding` matches                                                                                                                                                                                         |
| `Gym Page CTA Clicked`   | `cta`, `gymUuid`                                      | The secondary CTAs on `app/gym/[gym_slug]/page.tsx`                                                                                                                                                                                                                          |
| `Gym Directory Searched` | `queryLength`, `boardTypes`, `hasGeo`, `resultsCount` | The gym directory search surface                                                                                                                                                                                                                                             |
| `Gym Manage Tab Viewed`  | `tab`                                                 | `app/gym/[gym_slug]/manage/manage-gym-content.tsx` on tab change                                                                                                                                                                                                             |

### Property values

| Property       | Values                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------- |
| `placement`    | `gym-page`, `preview-sheet`, `directory-card`, `similar-gyms`                            |
| `viewerState`  | `signed-in`, `signed-out` — only the gym page can fire `signed-out`, see below           |
| `method`       | `domain`, `admin` — mirrors the `GymClaimMethod` GraphQL enum                            |
| `status`       | `email_sent`, `approved`, `admin_review`, `error`                                        |
| `medium`       | `poster`, `kiosk`, `board` — only `poster` can fire today, see below                     |
| `gymSlug`      | The slug of the gym page the scan landed on                                              |
| `cta`          | `follow`, `kiosk`, `website`, `report-duplicate`                                         |
| `tab`          | `overview`, `kiosks`, `insights`, `branding`, `profile`, `boards`, `members`, `comments` |
| `boardTypes`   | A **sorted, comma-joined string**, e.g. `kilter,tension`. Empty selection is `''`        |
| `queryLength`  | A number. The search text itself never leaves the browser                                |
| `hasGeo`       | A boolean, and only ever a boolean                                                       |
| `resultsCount` | A number                                                                                 |

`GymManageTabName` restates `VALID_TABS` from
`app/gym/[gym_slug]/manage/manage-gym-content.tsx`. It is restated rather than
imported because a shared package must never depend on `packages/web`; adding a
tab there without adding it here is a compile error at the call site.

### `viewerState: signed-out` only exists on the gym page — split by `placement`

**Read this before using `Gym Claim CTA Clicked` to answer H4** ("does a visible
self-serve claim CTA convert unclaimed gyms"). Since #3672 the gym page shows
the claim call-out to anonymous visitors, so `signed-out` is real data there:

- `app/gym/[gym_slug]/page.tsx` renders it whenever the gym is public and
  `resolveClaimCtaVariant` (`app/gym/[gym_slug]/gym-claim-cta-logic.ts`) doesn't
  return `hidden`. `hidden` is the signed-in viewer who already covers the gym —
  the resolver's `canClaim = !!authenticatedUserId && …` is false for owners,
  gym admins/editors and covering community leaders
  (`packages/backend/src/graphql/resolvers/social/gyms.ts`).
- The anonymous arm sends the owner through the auth modal with a
  `callbackUrl` back to `/gym/<slug>?claim=1`, so the claim intent survives an
  OAuth round-trip and the dialog re-opens on return.

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

**Filter on `placement = 'gym-page'` before reading the `viewerState` split.**
Across all placements the denominator includes two surfaces that effectively
never report `signed-out`, which drags the anonymous share toward 0 for reasons
that have nothing to do with how signed-out climbers behave.

## Two rules that are easy to break

**`boardTypes` must be a string, not an array.** Web's `track()`
(`packages/web/app/lib/analytics.ts`) types properties as
`AllowedPropertyValues = string | number | boolean | null | undefined` and hands
the same object straight to `@vercel/analytics`. An array is not rejected — it is
dropped, and the board-type breakdown comes back empty with no error anywhere.
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
| `GYM_QR_MEDIUMS`      | `['poster', 'kiosk', 'board']` |

- `buildGymQrHref(path, medium)` builds the URL a QR encodes. Its output gets
  printed on laminated posters and stuck to walls, where a wrong href can't be
  patched, so it handles the two shapes a naive append breaks on: a **fragment**
  (`/gym/x#boards` — appending at the end buries the params inside the fragment,
  which never reaches the server) is split off and re-attached last, and a
  **pre-existing `src` or `medium`** (`/gym/x?src=email` → `?src=email&src=qr`,
  which Next surfaces as a `string[]` that the parser then rejects) is dropped so
  ours wins. Every other param is preserved.
- `parseGymQrLanding(searchParams)` returns `{ medium }` or `null`. It is
  deliberately strict, because it decides whether an acquisition event fires:
  `src` must equal `'qr'` exactly (no trimming, no case folding), `medium` must
  be a known member, and an array-valued `src` or `medium`
  (`?medium=kiosk&medium=poster`) is rejected outright rather than picking one —
  a duplicated param is a hand-edited or crawler-mangled URL, not a scan.
- `stripGymQrParams(search)` drops the two params and keeps the rest, so the
  landing surface can rewrite the URL after firing. Without that rewrite, a
  shared or bookmarked link re-attributes someone else's visit to a poster. It
  filters the raw `&`-separated pairs instead of round-tripping through
  `URLSearchParams`, which would re-encode what it keeps — `?q=hello%20world`
  becomes `?q=hello+world`, and a valueless `?embed` becomes `?embed=`. The
  result is written into the address bar, so an untouched param must not visibly
  change shape.

### Only `poster` can fire `Gym QR Scanned` today

The member list reads as three live mediums. It is one. `Gym QR Scanned` fires
from the QR landing tracker, which mounts on `/gym/[gym_slug]` and nowhere else.
The kiosk's per-board QR (`app/components/kiosk/board-slot/board-install-qr.tsx`)
encodes `/b/{slug}`, and `app/b/[board_slug]/page.tsx` is a bare
`redirect('/b/{slug}/{angle}/list')` — it renders no tracker, and the redirect
target is a literal path, so the `?src=qr&medium=` params do not even survive the
hop.

`kiosk` and `board` stay in `GYM_QR_MEDIUMS` anyway: the parser has to accept all
three so that pointing a future kiosk or board QR at a gym page is a call-site
change rather than a vocabulary change that invalidates codes already printed on
walls. Until then, expect `medium: 'poster'` and only `poster` in PostHog — a
`kiosk` or `board` row appearing means someone shipped a new producer.

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
one, so it is called out here as well as in the rules above. An array does not
survive the web `track()` path: it is typed out by `AllowedPropertyValues` and
dropped by `@vercel/analytics` without an error, so shipping the issue's literal
shape would produce an event whose board-type breakdown is permanently empty.
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
tolerable, renames split funnels.

One addition in the other direction: **`GymClaimPlacement` gains
`similar-gyms`.** `app/components/gym-entity/similar-gym-suggestions.tsx` is
easy to mistake for a directory surface, but it is rendered only by
`app/components/gym-entity/create-gym-form.tsx` — it is the duplicate check
inside the create-gym flow, shown to someone who is about to add a gym that may
already exist. Folding it into `directory-card` would merge "browsing the
directory" with "about to create a duplicate", which are opposite intents and
the two most interesting rows to tell apart. `directory-card` itself is reserved
by #4374; the directory surface ships in a later PR of this epic.

## The gym-page install CTA (#4374 AC2)

Not in this module, on purpose, and it is the one event in the epic that is not.

The gym-page install CTA fires **`App Install Click`**, the event five existing
web call sites (`home-page-content.tsx`, `capacitor-retirement-screen.tsx`)
already fire — not `Gym Page CTA Clicked`. Two funnels for one action would have
to be unioned every time anyone asks how many installs the product drives.

Its payload is `{ platform, source, placement: 'gym-page', gymSlug }`.

- **`source` keeps its existing meaning and values** (`'google-play'`,
  `'app-store'`, `'capacitor-retirement'`, …). PH-13's install-source breakdown
  is grouped by it, and that breakdown has to stay comparable across this change,
  so `source` is not repurposed to carry the surface.
- **`placement` and `gymSlug` are added alongside it.** AC2 asks for those two
  properties; it is not asking for `source` to change meaning.

The builder lives in **`packages/web/app/lib/app-install-event.ts`**, added by
the wiring PR. It is deliberately not in `@boardsesh/analytics`: `App Install
Click` is web-only with no mobile counterpart, and a shared package should not
own an event neither platform shares — that is the same rule that keeps the
seven gym events out of `SHARED_EVENTS`.

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
