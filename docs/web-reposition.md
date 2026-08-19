# Web reposition: Next.js as the SSR front door

Tracks the initiative that strips the interactive climbing-session surfaces out of
`packages/web` (Next.js) and leaves it as a crawlable **marketing + climb-viewing +
gym** surface. The interactive product (queue, play drawer, party/WebSocket
sessions, Bluetooth LED control, tick logging, board-connect, climb authoring)
lives in the React Native app's browser target served at `/app` and standalone at
`app.boardsesh.com`. Viewing a climb offers a **"Climb this"** hand-off into `/app`.

The full phased plan (A0–A6 teardown track + B0–B5 gym-discovery track) lives with
the maintainer; this doc records the parts the repo needs: the Phase A0 audit
findings that gate later deletions, and the blocking pre-delete QA checklist.

## Phase A0 — audit findings (gate the deletion phases)

These are verified against the working tree and constrain what later phases may
delete and how.

### API routes — what's safe to delete

The mobile app reaches the climbing backend through **GraphQL**, not the Next.js
web proxies. But it still fetches a handful of www-hosted Next.js routes for
auth and two other flows: `/api/auth/session`, `/api/auth/providers-config`,
`/api/auth/csrf`, `/api/auth/callback/credentials`, `/api/auth/register`,
`/api/auth/forgot-password`, `/api/auth/reset-password`,
`/api/auth/resend-verification` (native store fleet too, via the plain
`app/auth/register.tsx`), `/api/auth/signout`, `/api/auth/native/callback`
(native only), `/api/internal/ws-auth`, and `/api/internal/beta-link-thumbnail`.
(`/api/aurora-credentials`, `/api/board-credentials/*`, `/api/aurora-import` and
`/api/moonboard-import` are backend routes, not Next.js.)

| Route                                                                     | Runtime callers                                                                             | Verdict                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `/api/v1/[board]/proxy/{login,saveAscent,saveClimb,getLogbook,user-sync}` | **None** — already migrated to GraphQL (see `docs/branch-deploys.md`)                       | W-25a + W-25b: all five deleted, URLs 404 (see below)         |
| `/api/internal/favorites`                                                 | Only web session-app UI slated for teardown (`climb-actions/*`)                             | deleted with that UI (see `deleted-private-surfaces.test.ts`) |
| `/api/internal/join/[sessionId]`                                          | `app/join/[sessionId]/page.tsx`, `join-redirect.tsx`                                        | **KEEP** — session share links                                |
| `/api/internal/controllers`                                               | `account/controllers-section.tsx`                                                           | **KEEP** — kept by W-21 (#4440)                               |
| `/api/internal/ws-auth`                                                   | `use-ws-auth-token.ts` → ~85 web files incl. kiosk presence; mobile `auth-store.web.ts:343` | **KEEP** — `/app` + kiosk auth bridge                         |

Loose ends to clean when the routes go (not runtime callers, but they'd go stale):
`app/lib/api-docs/openapi-routes.ts` (documents `proxy/login`, `proxy/saveAscent`),
`docs/branch-deploys.md` migration table, and the routes' own `__tests__`.
**All three are discharged by W-25a (#4441)**, which also split the proxy row's
verdict: `saveClimb`, `getLogbook` and `user-sync` are deleted, while `login` and
`saveAscent` answered `410 Gone` from 2026-08-15. W-25b (#4443) then deleted the
last two URLs outright, ahead of the published `Sunset: Thu, 01 Oct 2026` header — Marco's call, since the routes had already
answered 410 with no Aurora call behind them since W-25a, so any caller still
hitting them was already broken; W-25b changes only how (410 → 404). The four
orphaned implementation modules W-25a left behind are tracked in #4574, not
folded into either PR.

### Shipped hardware pins `www` URL shapes (two different ones)

Two shipped artefacts point at `www.boardsesh.com`, and they pin **different**
things. Neither is fixable by us for the copies already in the field.

- **The legacy page-route shape.** `packages/web/board-controller/main.py:627`
  builds
  `https://www.boardsesh.com/{board_name}/{board_layout}/{board_size}/{board_set}/{board_angle}/list?controllerUrl=…`
  and 302s to it on line 629, using named slugs (defaults:
  `kilter`/`original`/`12x12`/`screw_bolt`/`40`). This is a FastAPI app users run
  on their own host from this repo, so the source is editable, but we can't push
  the update — installed copies keep sending traffic at the old shape. The legacy
  config-tuple `/list` route has to keep resolving.
- **The `www` host plus `/api/internal/board-render`.**
  `embedded/projects/board-controller/src/config/board_config.h:41` (same define
  at `embedded/projects/moonboard-dev-server/src/config/board_config.h:17`) sets
  `DEFAULT_RENDER_BASE_URL "https://www.boardsesh.com"`. The firmware never
  requests a page: `buildBoardRenderThumbnailUrl`
  (`embedded/libs/thumbnail-client/src/thumbnail_client.cpp:298-324`) appends
  `/api/internal/board-render` plus a
  `board_name`/`layout_id`/`size_id`/`set_ids`/`frames` query string. So this
  pins that URL shape, not the old Next.js implementation. The route file was
  deleted in #4715, but an unconditional external rewrite preserves the path and
  forwards it to Railway `/render/board` — the redirect wave (A6 in the
  maintainer's plan; shipped piecemeal as W-17/#4433, W-19/#4437, W-20b/#4439)
  had to leave the path alone, and so must any later cleanup. The default is
  overridable at build time (`#ifndef`) and at runtime through the device's own
  config endpoint (`embedded/libs/esp-web-server/src/esp_web_server.cpp:708-714`
  persists `render_base_url`), so it is recoverable, but only by hand, one device
  at a time.

### App redirect destinations (the maintainer plan's A6; shipped across W-17/#4433, W-19/#4437, W-20b/#4439)

Destinations are paths on `${APP_ORIGIN}` (`app.boardsesh.com`), not on www. They
used to be written with an `/app/` prefix, back when www proxied the Expo bundle
at `/app`; W-24 (#4438) retired that static path, so the prefix is gone and the
shipped rules read `` `${APP_ORIGIN}${path}` `` — see `BASE_REDIRECTS` in
`packages/web/next.config.mjs`.

| Web route removed  | `${APP_ORIGIN}` destination                             | Status                                                                                                                                         |
| ------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `join/[sessionId]` | `/join/{sessionId}`                                     | exists (`packages/mobile/app/join/[sessionId].tsx`; universal-link `/join` registered)                                                         |
| `/you`             | `/profile`                                              | shipped in W-19 (#4437)                                                                                                                        |
| `/settings`        | `/profile/more`                                         | no bare `/settings` in the app — redirect to `/profile/more`                                                                                   |
| `/notifications`   | `/home/notifications`                                   | shipped in W-20b (#4439); `packages/mobile/app/(tabs)/home/notifications.tsx`, and `(tabs)/profile/notifications.tsx` renders the same screen  |
| climb view         | `/climbs/{uuid}?boardName&layoutId&sizeId&setIds&angle` | exists; **all five query params required**, numeric IDs                                                                                        |
| `/list`            | `/climbs`                                               | exists, but the Climbs tab reads its board from the persisted active board, **not** the URL — board context is lost on a bare `/list` redirect |

### Board layout provider mounts (asymmetric — mattered for the classic-code delete, the maintainer plan's A5, shipped as W-16/#4435)

- **Legacy tree:** `BoardProvider` is mounted at the top in `[board_name]/layout.tsx`, wrapping **all** children. The deep `[angle]/layout.tsx` mounts the session providers (`GraphQLQueueProvider`, `WebSocketConnectionProvider`, `ConnectionSettingsProvider`, `BoardSessionBridge`, `UISearchParamsProvider`, `QueueBridgeInjector`, `BoardSeshHeader`) and the `<main id="content-for-scrollable">` shell + `I18nProvider`, but **not** `BoardProvider`.
- **Slug tree:** no `[board_slug]`-level layout — `b/[board_slug]/[angle]/layout.tsx` mounts `BoardProvider` **and** all the session providers together (nested inside `I18nProvider`).
- **Coupling to break first:** `b/[board_slug]/[angle]/list/layout.tsx` imports `ListLayoutClient` from the **legacy** tree (`[board_name]/…/list/layout-client.tsx`), and that client consumes the queue (`useQueueActions`/`useQueueList`). The static `/list` (the maintainer plan's A3, shipped as part of the front door in W-15/#4369 — see `climb-list/static-climb-list.tsx`) had to replace this before the legacy tree could be deleted, and it did: the legacy `list-layout-client.tsx` is gone.

### Kiosk / embed presence dependencies (clients relocated; login-less query still open)

`components/kiosk/presence/kiosk-presence-hub.tsx` imports
`app/lib/realtime/graphql-client` (`createGraphQLClient`) and
`app/lib/realtime/board-presence-client` (`createWebBoardPresenceClient`), plus
`useWsAuthToken` (kept) — both clients were lifted out of the delete-candidate
dirs by W-11 (#4364). The hub renders on `/kiosk/*`, `/embed/board/*`, and the
gym-manage `kiosk-preview.tsx`. **Not** on `/embed/gym/*/leaderboard` (that's a
historical period leaderboard, no presence socket). A5-pre's other half — the
login-less "now on the wall" query, so an anonymous kiosk/embed load needs no
`ws-auth` token — is **still outstanding**: #4408.

### `/playlists` is NOT clean (blocks the `climb-actions/*` delete)

The kept `/playlists/[playlist_uuid]` detail page depends on `climb-actions/*`:
`playlist-detail-content.tsx` imports `PlaylistActivationProvider` directly, and
renders `climb-list/multiboard-climb-list.tsx`, which imports both
`FavoritesProvider` and `PlaylistsProvider` (defined only in `climb-actions/`)
plus `useOptionalPlaylistActivation`. Refactor `multiboard-climb-list.tsx` and
`playlist-detail-content.tsx` off `climb-actions/*` before deleting that dir. The
`/playlists` library index page is clean.

## Phase A0 — invariant tests added

- `app/__tests__/crawler-classic-invariant.test.ts` — a cookie-less request to a
  canonical board URL (`/b/**`, a config-tuple `.../list`, or a config-tuple
  `.../view/**`, in every locale prefix) gets no 3xx at all from middleware, and
  the three legitimate redirect classes (numeric→slug in the `[angle]` and
  `[angle]/list` layouts, bare-uuid/numeric→slug at `view/[climb_uuid]`, and
  `/play`→`/view` on both trees) are asserted on `Location` **host**
  (`www.boardsesh.com`), never pathname — a pathname check can't tell a
  cross-host redirect from a legitimate same-host one when they share a
  pathname shape, and a blanket ban on redirect statuses would wrongly outlaw
  those correct same-host 308s. Protects the SEO/crawler audience through the
  teardown. W-09 deleted the `bs_expo_web` cookie, the `bs_classic`/`?classic=1`
  hatch and `mapToExpoWebTarget`; `docs/expo-web-rollout.md` is gone.
- `app/__tests__/climb-canonical-parity.test.ts` — **A1 landed in W-15 (#4369).**
  The two view trees used to self-canonicalize into different URLs for one climb
  (split PageRank). Both now emit the identical string, because both call
  `buildCanonicalClimbViewUrl`; the test asserts that equality rather than
  documenting the split. The consolidation target is the config-tuple tree
  (route segments `/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/…`,
  served in its named-slug form — `/kilter/original/12x12/screw_bolt/40/…`), not
  `/b`. `/b/{slug}` resolves through `boardBySlug`
  (`packages/backend/src/graphql/resolvers/social/boards.ts`), which reads
  `user_boards` scoped only by `slug` and `deletedAt` — a board a specific user
  owns, not a climb config. Most climbs have no `/b` URL at all, and popular
  configs have many (one per owning user), so `/b` can't be the canonical for a
  climb config. What changed at A1 was the `/b` pages' inline canonical literals,
  which reached `createPageMetadata` without touching `url-utils`:
  `b/[board_slug]/[angle]/view/[climb_uuid]/page.tsx:54` and
  `b/[board_slug]/[angle]/list/page.tsx:43`. **The sharp edge, also pinned:** an
  unlisted or private `/b` board is `noindex`, and it now passes NO `path` at
  all, so `createPageMetadata` emits no `alternates`. A canonical pointing from a
  noindex URL at an indexable twin is a conflicting signal Google can resolve by
  propagating the noindex — deindexing a public config-tuple climb page because
  one private board happens to share its configuration. The legacy `/list` page's
  `generateMetadata` stopped returning a bare `{}` in the same PR: with `/b` no
  longer self-canonicalising, claiming the self-canonical no longer widens
  anything.
- `b/[board_slug]/[angle]/view/[climb_uuid]/__tests__/view-seo-fragment.test.tsx`
  — grew from the A0 identity guard into the front door's acceptance suite: the
  page still SSR-emits `ClimbViewSeoFragment` (by element identity), and the
  rendered HTML carries exactly one `<h1>`, the board `<img>` with explicit
  width/height, a setter link, angle cross-links, ≥3 internal links, and a CTA
  whose href is `APP_URL` + the same pathname **with any locale prefix
  stripped** (see below).

**Supersedes `docs/view-page-removal-pivot.md` (deleted, W-26/#4442).** That
plan's drawer-first architecture and its "SEO content lives in a dedicated
visually-hidden fragment" rule described a world where `PlayViewDrawer`
hydrated on top of `ClimbViewSeoFragment` and hid it once interactive. W-15
removed the drawer from this route entirely, so `ClimbViewSeoFragment`
(`app/components/climb-detail/climb-view-seo-fragment.tsx`) is now the page's
only visible `<h1>` — not hidden behind anything. Element identity (`<h1>` +
`<p>`) carried over unchanged; `view-seo-fragment.test.tsx` above is what pins
it now.

**W-06 (#4361) — the SPA end of the hand-off.** A front door that links into
`app.boardsesh.com` is only worth building if the arrival works signed-out, so
the Expo app's auth gate now stands aside for the read-only board URLs on web
and carries the attempted path through login as a validated `?next=`. The URL
shapes it relaxes, the two-gate `next` contract, the `.web.ts` fork that keeps
the native gate a constant `false`, and why `auth_required` is a relaxed route's
terminal status today are recorded in
[`docs/expo-web-deployment.md`](./expo-web-deployment.md) under "Signed-out
read-only routes".

## The front door (W-15, #4369)

Four **page subtrees** are now server-rendered front doors with no interactive
climbing UI: the climb view and `/list` on the config-tuple tree, and their
`/b/{slug}` twins. W-15 changed the page subtrees; the surrounding board shells
(`app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/layout.tsx` and its
`/b` twin) still rendered `BoardSeshHeader` and still mounted the queue and
WebSocket providers until **W-17 (#4433)** deleted the sibling routes that
consumed them and stripped both shells. They are now server-only apart from
`LastUsedBoardTracker`, so the import-graph invariant walks the config-tuple
shell too (`KEPT_ENTRY_FILES` in
`app/__tests__/import-graph-invariant.test.ts`), leaving that one allowlisted
edge for W-16 to cut with `components/board-page`. What each front door is, and
the two constraints that shaped them:

**The climb front door** (`app/components/climb-front-door/`) renders a
breadcrumb, the promoted `ClimbViewSeoFragment` heading, the board art as a
plain `<img>` at the Railway `/render/board` overlay URL with explicit
dimensions, a facts `<dl>`, a setter link, angle cross-links, beta videos,
similar climbs, the community section, and one CTA — "Climb this", a real
server-rendered `<a href>` at `APP_URL` + the same pathname, firing
`Climb Handoff Clicked`. Not `BoardRenderer` or `BoardImageLayers`: both are
hook-bearing client components, and this image is the page's LCP.

**The locale carve-out, recorded here because `buildAppHandoffUrl`'s docblock
says it is.** "The same pathname" is exact on `en-US` only. On `/es`, `/fr` and
`/de` the CTA href drops the locale segment — `buildAppHandoffUrl`
(`app/lib/app-handoff.ts`) strips every non-default prefix, deliberately and
with no locale argument to forget. The Expo app has no `/es`, `/fr` or `/de`
route tree, so a locale-prefixed app URL would match nothing and land on the
SPA's not-found; a Spanish reader following "Climb this" therefore arrives at
the right climb in the English app. That is the accepted regression, not a bug
in this CTA — and it is why the epic's definition-of-done box for this CTA reads
as "the same pathname" but is only literally true in one of the four locales.

**The `/list` front door** renders `StaticClimbList` with `virtualize={false}`.
The virtualized path emits a 375×812-worth of rows on the server (~18), and the
bar here is ≥50 crawlable climb links per page. `?page=N` is 1-based and clamped;
`?page=1` canonicalises onto the bare path (same page, one URL); pages 1–10 are
indexable with real prev/next anchors, and the `next` anchor **stops at page
10** — `noindex, follow` past the cap is an explicit "keep walking", so a chain
gated on "more climbs exist" would hand crawlers a corridor thousands of pages
deep, each hop a deeper `OFFSET` over the climb/stats join. Pages 11–20 still
render for a hand-typed or externally-linked URL — `noindex, follow`,
self-canonical, with a `prev` anchor back into the indexable set — and `?page=21`
and beyond 404s before any query runs. Filter/sort variants (`?minGrade=`,
`?sortBy=`, …) are `noindex, follow` too and canonicalise onto the clean base
URL; pagination stays
self-canonical, because `?page=3` is different climbs rather than a duplicate of
page 1. The one case that emits no canonical at all is an unlisted or private
`/b` board, where the noindex is about the board and its clean base is a public
config-tuple URL we do not want dragged down with it. All of it — including the
`?page` bounds — lives in `resolveListPageIndexation`
(`app/lib/seo/list-page-robots.ts`), called by both trees, and is pinned by
`list/__tests__/list-front-door.test.tsx` plus the two `page-metadata` suites.

**Both render anonymously, and must.** `middleware.ts` puts a shared
`Vercel-CDN-Cache-Control: s-maxage` on every climb-view and `/list` URL with no
session-cookie check, on the documented premise that these pages are
personalization-free. Server-rendering one viewer's ascent badges or logbook
would cache them for every later visitor and for Googlebot.
`ascent-status.tsx` states the same contract from the other end: anonymous SSR
renders no badge at all. If personalised badges are ever wanted here, the only
safe shapes are a post-hydration client island, or middleware emitting
`private, no-store` when a session cookie is present — which costs cache hit
rate on the highest-traffic pages.

**The Boardsesh-grade section is deliberately absent.** That flag is a live,
staged PostHog rollout; SSR-ing the section would end it for every visitor and
crawler in a single deploy, irreversibly without another one.

## W-17 — deleting the board-route siblings (#4433)

Twelve sibling routes came out of the two board trees (`create`, `import`,
`liked`, `logbook`, `playlists`, `playlists/[playlist_uuid]`), plus the session
providers and `BoardSeshHeader` above them. `next.config.mjs` holds the redirect
table, every rule with its three locale twins. Three of those rules carry
context rather than dropping it, and the reasons are worth keeping:

- **Create → the app, with the board attached.** A canonical numeric board URL
  hands `boardName`/`layoutId`/`sizeId`/`setIds`/`angle` to the app's create
  screen, which reads exactly those. Slug forms (`/kilter/original/…` and the
  whole `/b/{slug}` tree) hand over bare: the app parses the ids with `Number()`,
  so forwarding a slug would seed the editor with `NaN`, and resolving one needs
  a DB lookup a static redirect can't do. **Everything on www that used to link
  at `…/create` now links at the app directly** — the Create tab in the bottom
  bar, the remix/edit action — through `buildAppCreateClimbUrl`, so there is no
  redirect hop and no board context lost in it.
- **Import → `/moonboard-import`, with the hold sets.** Bulk import is
  MoonBoard-only, so `/moonboard/…/import` goes to the importer carrying
  `layout`, `sets` and `angle`, and every other board's `…/import` goes to that
  board's own list — the same split the deleted page made. It needs its own rule
  because `MOONBOARD_LAYOUTS` ids run 1–7 and collide with Aurora layout ids;
  without it `/kilter/1/…/import` would render the importer for MoonBoard 2010.
  The `sets` param matters for the same reason: without it a 2024 wall gets all
  six of the layout's hold sets stacked on the preview instead of the two it
  named. The `/b/{slug}` tree can't make that split — the slug names a DB row —
  so it goes to the importer and an unresolvable one lands on the picker.
- **Cross-origin rules stay `permanent: false`.** A permanent cross-origin
  redirect is cached by the browser indefinitely with no server-side hatch. They
  go 308 once the app route is proven in production.

**Parked, not forgotten.** `components/create-climb/` (the www climb editor,
including `drafts-drawer` and `create-climb-form`) lost its last route here and
is now reachable only through the MoonBoard importer's shared pieces
(`hold-indicator`, `hold-type-picker`, `use-hold-type-picker`,
`use-moonboard-create-climb`). Deleting the rest belongs with `teardown:components-create-climb`
in W-16, not here — it is a large cascade and the importer's edges have to be
lifted out first. `components/board-page/last-used-board-tracker.tsx` stays for
the same reason, as the one allowlisted edge W-16 cuts.

## W-16 (+W-18) — deleting the climbing UI and swapping the root chrome (#4435)

The irreversible one. `git diff --stat` against the merge base: roughly **1.7k
insertions against −131,350 deletions across ~680 files** — a net loss of about
**−130k** lines, against the epic row's estimate of −110k. (Run
`git diff --shortstat origin/main...HEAD` for the exact figure at merge; the
insertion count moves every time this section is edited.) The gap is second-order orphanage the row did not
name (the 338-line `persistent-session-wrapper` and its 402-line test, the
`climb-detail` tree, 22 `app/lib` modules, 19 orphaned hooks, four
`social/*-search-results`, the `lib/ble` adapters) plus the `public/help/`
screenshot set and the i18n prune.

**Rollback is `release/classic-web`, not `git revert`.** The restore procedure is
in the W-14 section below — reverting this commit would mean reintroducing ~130k
lines, re-mounting a provider tree and passing `check:i18n:orphans` under
incident pressure on a rebase over everything that merged since.

### What replaced the root chrome

`PersistentSessionWrapper` mounted the whole interactive climbing stack on
**every** route, `/about` and `/legal` included: a `connectionName: 'session'`
WebSocket, the queue bridge, the BLE provider, the queue control bar, the bottom
tab bar and the `ResizeObserver` that published `--bottom-bar-height-measured`.
`components/providers/site-chrome.tsx` keeps three providers and nothing else:

- `StatsFilterBridgeProvider` — the `/profile` and `/you` statistics filter button.
- `ProfileHeaderShareProvider` — the viewed-profile share button.
- `PlaylistsAdapterProvider` — **required**, not optional: every hook in
  `@boardsesh/playlists-react` calls `usePlaylistsAdapter()` unconditionally.

`AuthModalProvider` stayed exactly where it already was, at `app/layout.tsx`. It
was never inside the wrapper.

Socket counts, before → after: `/kiosk` **2 → 1** (only `connectionName: 'kiosk'`
remains); `/embed` **1 → 0**, which is what `embed-access.test.ts` and
`embed/gym/[gym_uuid]/leaderboard/page.tsx` already claimed. A kiosk regression
is invisible for up to 24 hours (`kiosk-reliability.tsx` reloads at 04:00 local,
and a kiosk is an unattended TV), so watch two reload cycles post-deploy, not one
hour.

### The nine IndexedDB stores that went with it

Deleted, with any unsent contents: `create-climb-autosave-db`,
`feedback-prompt-db`, `last-used-board-db`, `led-color-overrides-db`,
`onboarding-db`, `party-profile-db`, `saved-boards-db`, `session-history-db`,
`tick-draft-db`. Two of those held **unsaved user work** that
`app.boardsesh.com` cannot read (a different origin): `create-climb-autosave-db`
(one in-progress climb form per browser) and `tick-draft-db` (unsent per-climb,
per-angle tick drafts). Server-side `is_draft` climbs are a different artefact
and are unaffected.

Kept, all with live importers: `gym-welcome-db`, `moonboard-climbs-db`,
`oauth-pending-db`, `recent-playlists-db`, `user-preferences-db`.

### Two files that look deletable and are not

- **`app/lib/ble/capacitor-types.d.ts`** — the ambient `window.Capacitor`
  declaration. Six surviving source files type against it (`home-page-content`,
  `capacitor-retirement-gate`, `auth/social-login-buttons`, `use-geolocation`,
  `open-external-url`, `lib/hooks/use-wake-lock`) plus four test files — the
  count `import-graph-invariant.test.ts` records alongside `KEPT_BLE_FILES`.
  Taking the epic row's "delete `lib/ble/*` except `capacitor-utils.ts`"
  literally reds the whole typecheck in files that have nothing to do with
  Bluetooth. It is pinned in `KEPT_BLE_FILES`.
- **`middleware.ts`'s `?session=` → `CLIMB_SESSION_COOKIE` rewrite** — it lost
  its last client-side _reader_ here, but `api/internal/join/[sessionId]/route.ts`
  still _writes_ the same cookie and the app reads it. Written-and-not-read on
  www is the correct state; removing it is a separate call that belongs with
  W-19's `/session` review.

### The machine-checkable finish line

`app/__tests__/import-graph-allowlist.json` is `{"entries": []}` and both
assertions are green: no kept file imports the delete set, and no allowlist entry
is stale. The gate is not vacuous — adding `climb-icons` to
`DELETED_CLIMB_CARD_STEMS` still reports the five real edges into it.

### Couplings the A0 audit missed

Four edges the original audit didn't record, found by grepping for them at
W-26 (#4442) time. Three were cut by relocation rather than deletion — a future
audit that greps the delete-set path and finds no hit would wrongly read them as
gone-with-no-successor, when the edge just moved:

- **`social/proposal-card.tsx` → the deleted `climb-card/climb-list-item`.**
  Cut. `proposal-card.tsx:36` now imports `StaticClimbRow` from
  `climb-list/static-climb-row` — the W-11/W-15 relocation, not a deletion of
  the caller.
- **`social/comment-section.tsx` → the deleted `graphql-queue/graphql-client`.**
  Cut, and the trap: `comment-section.tsx:13` is still line 13, so a line-number
  diff looks unchanged. The import itself moved: it now reads from
  `app/lib/realtime/graphql-client`, the lifted module.
- **`climb-card/ascent-status.tsx` → the deleted `board-provider/board-provider-context`.**
  Cut. `ascent-status.tsx:4` now imports `LogbookEntry` as a type from
  `@boardsesh/board-react` — the lift into the shared package.
- **`activity-feed/*` → `climb-card/climb-icons`.** Still live, and the one this
  section is really about: `climb-icons` is a kept file, so this is an
  intra-kept-surface edge, not an edge into the delete set. Four importers:
  `activity-feed/feed-item-comment.tsx:16`, `social-feed-item.tsx:25`,
  `ascents-feed.tsx:31`, `feed-item-new-climb.tsx:23`.

## W-22 — the sitemap index and its shards (#4434)

`app/sitemap.ts` submitted 8 static paths × 4 locales — 32 URLs, and not one
board, gym, setter or playlist. It is gone. `/sitemap.xml` is now a
`<sitemapindex>` over `/sitemaps/{static,boards,gyms,setters,playlists}.xml`,
which is what W-23's climb shards plug into.

**`generateSitemaps()` is rejected, on evidence.** `MetadataRoute.Sitemap` can
only produce a `<urlset>`: `resolveSitemap()` in
`next/dist/build/webpack/loaders/metadata/resolve-route-data.js` writes that tag
unconditionally, and grepping the whole of `next@16.2.12`'s dist for
`sitemapindex` returns zero hits. `generateSitemaps` shards to
`/…/sitemap/[id].xml` with opaque numeric ids and still leaves the index to be
hand-written. Route handlers are a first-class shape instead —
`normalizeMetadataRoute` documents _"Support both /<metadata-route.ext> and
custom routes /<metadata-route>/route.ts"_ — with one caveat that makes
`export const dynamic = 'force-dynamic'` mandatory rather than decorative:
`isMetadataRoute('/sitemap.xml/route')` is true, and the app-route exporter uses
that to skip its static-gen bail-out, so without the opt-out Next would try to
prerender a database-backed route at build time. `vp run build` confirms the six
routes land at `/sitemap.xml` and `/sitemaps/*.xml`.

**The cap is 45,000 URLs, but the budget is 11,250 items.** Every item is
emitted once per locale with an identical five-entry `xhtml:link` block, so the
item budget is `45,000 / 4`. Measured against the dev database (same data shape
as production): 4 public playlists with climbs, 51 listed board configs
(→ 660 items, 2,640 URLs at all angles — 51 × 15 is the pre-filter upper bound,
which the MoonBoard 2-angle set and the zero-climb skip bring down to 660),
108,000 distinct (board, setter) pairs. Only the setters shard would need
paging, and it ships empty. The cap is enforced rather than merely declared:
`shardRouteHandler` counts the locale-expanded URLs it is about to serve and
503s past the budget instead of publishing a file Search Console rejects
wholesale.

**Failure doctrine: 503, never a truncated 200.** A shard whose builder throws
returns 503 so the crawler retries and keeps its last good copy; a short 200
tells Google the missing URLs were deleted. Three more cases fail the same way:
a shard past its URL budget, a shard that `expectsUrls` but built none (a
poisoned cache or a regressed query silently emptying `static` or `boards`), and
a boards fetch whose `hasMore` says the 100-config API cap — the schema's hard
max, so the fix is paging, not a bigger constant — dropped the tail. For the
same reason the boards shard uses a _throwing_ popular-configs fetch, not the
homepage's swallow-and-return-`[]` wrapper. `playlists` is deliberately **not**
`expectsUrls` — zero public playlists holding a climb is a legitimate state, and
failing closed there would take the whole index down over nobody having shared
a list.

**The index degrades; only the shard fails closed (#4476).** W-22 shipped the
index under the same all-or-nothing rule, and production disagreed: `/sitemap.xml`
503'd on a cold cache and failed the post-deploy smoke twice, while
`/sitemaps/static.xml` passed in the same run. The index is the one path that runs
_every_ builder, so one cold boards fetch took the four shards that were ready
down with it. The split is now by layer — a shard route still 503s when its own
builder throws, misses its budget or comes back unexpectedly empty, but the index
logs loudly, omits that shard's `<sitemap>` entry and still answers 200 with
whatever built. A partial sitemap beats no sitemap when every shard it does list
is served fail-closed at its own URL, and Google keeps the copy of the omitted
shard it already has. `buildSitemapIndexXml` throws only when nothing is left to
publish; an empty `<sitemapindex>` under an hour of `s-maxage` is the harm the
doctrine was written against.

**A degraded index is cached for a minute, not for 25 hours.** This is the half
that makes degradation safe rather than a worse bug. The full window is
`s-maxage=3600` plus a day of `stale-while-revalidate`, and the 503 it replaced
was `no-store` and therefore never cached at all — so before this change the copy
the CDN eventually held was always complete. Serving a partial index under the
full window would trade a self-healing 503 for a cacheable lie: one cold start
pinning "boards.xml does not exist" at the edge for 25 hours while the URL serves
perfectly the whole time. A degraded 200 gets `s-maxage=60, must-revalidate` and
an `X-Sitemap-Degraded` header naming the shards it dropped, so the next crawl
re-attempts and the degradation is visible on the response rather than only in a
log line.

The post-deploy smoke was widened in the same PR for the same reason. It asserted
"any one shard `<loc>`", which a degraded index satisfies — and `static` is a
hardcoded builder that cannot fail, so the detector that caught #4476 would have
been permanently green afterwards. It now names both `expectsUrls` shards
(`static.xml`, `boards.xml`); the three declared-empty ones are legitimately
absent and stay out of it.

**Slow is a failure mode, and a try/catch cannot see it.** Each fixed builder and
paged-shard summary in the index walk is raced against `SHARD_DEADLINE_MS` (3 s,
the value W-23 settled on for its summary, so both paths share one constant). Be
precise about why: the two recorded production failures were _rejections_ — a 503
is the route's own `unavailableResponse`, and `getAllBoardConfigsOrThrow`'s 10 s
abort surfaces as a throw — so the try/catch alone covers what was measured. The
deadline covers the mode a try/catch structurally cannot see, work that never
settles (`fetchPlaylistSitemapRows` has no bound of its own), which would hold the
index to the platform timeout and 5xx all six shards. The index's 3 s and the
boards builder's own 10 s are _supposed_ to disagree: failing the shard route
costs a working URL, while missing the index deadline costs one shard for sixty
seconds. Cheap to be wrong, so be impatient.

**Concurrent, with only a per-shard deadline.** An earlier draft of this fix
sequenced the fixed walk under a total 8 s budget, and that made the tail of the
registry the deterministic victim: five builders each a comfortable 1.9 s — every
one inside its own deadline — spend the budget before `playlists` runs, so it is
dropped for its position rather than its latency. The five fixed builders and the
paged climbs summary now settle concurrently, so the walk is bounded by their
maximum rather than their sum and no shard is dropped for its registry position.
The fan-out is one GraphQL fetch, the playlists query, the cached climbs summary,
and three hardcoded builders. The climbs summary still sequences its heavy
per-board scans internally, which is where #4461's pool-starvation guard belongs.
Sequencing at the registry would not bound pool load anyway: `withDeadline` stops
waiting, it does not cancel.

**Known follow-ups.** `withDeadline` bounds this request's latency, not the
abandoned query still holding a connection — a real bound needs an `AbortSignal`
threaded into `fetchPlaylistSitemapRows` or a statement timeout on its query.
`getAllBoardConfigsOrThrow` is uncached (the `unstable_cache` in that file wraps
`fetchPopularBoardConfigs`, the limit=12 homepage variant) and `/sitemap.xml` is
`force-dynamic`, so every CDN miss re-runs the fixed builders live; caching those
per-shard summaries is what would make 3 s comfortably attainable on a cold
instance. The climbs summary already has Data Cache plus in-process caching.

**Two shards ship declared-empty, and that is the point.** `gyms.xml` waits on
#4381's public-gyms enumeration query, which the gym-discovery epic (#4372)
gates behind draining the duplicate queue — indexing a directory with live
duplicates is an SEO own-goal. `setters.xml` waits on an SSR fragment for
`/setter/[setter_username]`, whose first HTML is a spinner today, and on
`getSetterOgSummary` learning to return null so `/setter/{anything}` stops
answering 200. Both routes exist and serve a valid empty `<urlset>`, so filling
them is one builder function away.

**The boards shard carries no `<lastmod>`, deliberately.** There is no per-config
content timestamp in the data, `<lastmod>` is optional in the protocol, and
inventing one with `new Date()` is the exact thing the standing rule bans. A
follow-up adds `lastClimbAt` to `popularBoardConfigs` so the real timestamp can
arrive from the backend.

**`/profile/[user_id]` stays indexable, explicitly.** Public profiles are named
as a search surface, `user_profiles` carries no privacy flag, and the page
`notFound()`s for real when the row is missing. What closed are the two
_accidental_ index paths: the not-found branch (now the house `index: false,
follow: true`) and the `catch` branch, which used to emit a canonical and no
robots at all, so an errored profile was indexable. Profiles are not sitemapped
— they stay link-discovered. Their titles also moved off the bare
`{name} | Boardsesh` shape onto `{name}'s {board} Sessions`, driven by the
climber's most-ticked board.

## W-23 — the climb shards and JSON-LD (#4436)

Tier 2 — listed, non-draft climbs with at least ten ascents — now ships as paged
sitemap shards, and the five JSON-LD types the front doors were missing are
emitted from one escaping helper.

**The climb shards submit the default locale only.** This is a deliberate
inconsistency with the boards shard, which does fan out to all four locales, and
the difference is volume: boards is 690 items → 2,760 URLs; production emits
52,842 climb items, which would fan out to 211,368 locale URLs, each carrying a
five-entry `xhtml:link` block. Even one 10,000-item climb page would expand to
40,000 URL entries and exceed Vercel's 4.5 MB serverless response ceiling.

(Measured against production with the branch's exact angle, size, set, listing,
ascent and alias predicates: 127,131 tier-2 climbs exist, while 52,842 resolve
through a selected public board configuration → 6 pages. All 73,412 MoonBoard
climbs are absent because there is no MoonBoard configuration, 69 Kilter layout-5
climbs have no selected layout, and the chosen size/set predicates exclude 808
more. An earlier 53,650 estimate stopped at the layout intersection and therefore
overstated the emitted set by those 808. Nothing in the code depends on the
snapshot count; the page count comes from the summary at request time.) Do not
"fix" the inconsistency by fanning climbs out.
Nothing is noindexed — the locked decision on `/es`, `/fr` and `/de` climbing
pages is untouched. They stay indexable, they stay link-discovered, and they
carry reciprocal HTML hreflang from `createPageMetadata`'s `alternates.languages`,
which is one of Google's three supported annotation methods and the one that is
symmetric by construction. A one-sided sitemap-side annotation would be a
_second_, non-reciprocal signal for the same cluster — strictly worse than none.
`/profile/[user_id]` already gets exactly this treatment.

**The byte guard runs on the rendered body, not on a row count.**
`CLIMB_URLS_PER_SHARD` is 10,000 (~2.5 MB at our path lengths), and the page it
renders is checked against `pagedShardByteBudget()` — its page size at 500
bytes/URL, so 5 MB. A constant that nothing measures is a comment, so
`pagedShardRouteHandler` byte-lengths the XML it is about to serve and 503s
instead of serving a page whose per-URL cost multiplied. Off Vercel (#4648) the
budget is no longer the platform's 4.5 MB response ceiling: `MAX_SHARD_BYTES`
(45 MB) is now the protocol backstop on *both* paths, and `shardRouteHandler`
checks it too (#4618). `MAX_URLS_PER_SHARD` (45,000) stays as the protocol URL
guard for the fixed shards.

**Shard shape is count-driven.** `app/sitemaps/climbs/[page]/route.ts` serves
`/sitemaps/climbs/1.xml … N.xml`; `N` comes from a cached summary at request
time. Next has no partial dynamic segments, so a `climbs-1.xml` shape would need
one directory per page and would freeze today's page count into the filesystem.
A malformed or out-of-range page 404s (a page that was never valid is not
transient); a page the summary listed that builds nothing 503s.

**Fail-closed at the shard, degrade at the index.** A climbs page that renders
zero URLs 503s — telling Google "no climbs exist" is worse than telling it to
retry. But `/sitemap.xml` does **not** inherit that: if the climbs summary throws
**or misses a three-second deadline**, the index logs loudly, omits the climb
`<sitemap>` entries and still answers 200 with the other five shards. The
deadline is the half that matters in practice: a try/catch only sees a summary
that rejects, and the likelier failure — a saturated pool, a stalled aggregate,
the #4461/#4476 condition — is a summary that never settles, which without a race
hangs the request to the platform timeout and 5xxes all six shards. That is
strictly worse than the 503 the doctrine was written to prevent. The six-hour
`unstable_cache` on the summary is the first line of defence, the in-process
single-flight is the second, and this is the third.

**A summary-advertised page whose cached item slice is empty 503s.** The
summary (Next Data Cache, global) and the item list (in-process TTL, per
instance) have independent epochs, so a warm instance can hold 10,000 items while
a refreshed summary reports 10,001 and the index publishes page 2. The route
therefore treats an empty slice as transient cache disagreement and returns
503/no-store until the item epoch catches up. A malformed page or one the current
summary itself says is past the end still 404s. When the summary reports zero
while `expectsUrls` is set, the index degrades under its one-minute cache window
and names `climbs` in `X-Sitemap-Degraded` rather than quietly dropping the whole
tier-2 surface.

**Page numbers are canonical or they 404.** `Number('007')` is 7, so a `\d+`
parser would give every real page an unbounded family of alias URLs — `01.xml`,
`0000001.xml` — each serving page 1's body under the six-hour cache header and
each looking to Search Console like a separate submission of the same URLs. The
parser is `^([1-9]\d*)\.xml$`.

**Config resolution.** A climb URL names a size and a set list, and neither is a
property of a climb — `board_climbs` carries `board_type`, `layout_id`,
`compatible_size_ids[]` and `required_set_ids[]`. The shard therefore picks one
configuration per `(board_type, layout_id)` from `getAllBoardConfigsOrThrow()`,
ranked by board count, then climb count, then lowest size id, then lowest set
list. Determinism is the point: an unstable pick churns every URL between crawls.
A group whose configuration has no readable URL is dropped whole (resolvability
depends only on board/layout/size/sets, never on the angle, uuid or name), which
is what keeps the count query and the item builder selecting one identical set. A
layout with no listed board config contributes zero URLs — that is the expected
gap against the addressable tier-2 universe.

**Drop, never fall back.** `tryConstructSlugViewUrl` is the first branch of
`buildCanonicalClimbViewUrl`, so anything it resolves is byte-identical to the
page's own canonical. If it returns null the climb is dropped and counted, not
published under the name-based or numeric fallback — a URL we cannot prove
matches is the "alternate page with proper canonical" own-goal at shard scale.
The name always goes through `resolveClimbDisplayName` first, so an unnamed
climb's sitemap URL carries the same `-{board} Climb-` slug its canonical does.
`static-climb-row.tsx` was fixed in the same PR for the same reason: its anchor
used the raw name, which made a third URL for one page.

**One angle per climb.** `DISTINCT ON (climb_uuid)` ordered by ascents desc, then
the climb's own angle, then the lowest angle. The tie-break is
`COALESCE(stats.angle = climbs.angle, false)` rather than a bare comparison —
**defensive, not load-bearing**, and an earlier draft of this section claimed
otherwise. `board_climbs.uuid` is the primary key and the join is on
`(uuid, board_type)`, so every row inside one `DISTINCT ON` group joins the same
`board_climbs` row: a null `climbs.angle` makes the comparison NULL for the whole
group, NULLs sort equal, and the ordering falls through to `asc(stats.angle)`
either way. Measured over kilter layout 1 (16,233 tier-2 climbs with a null
`board_climbs.angle`): zero differing rows. It is kept because it is free and
survives a future join that does compare across climbs. Other routable angles
stay reachable through W-15's cross-links but emit the chosen sitemap angle as
their canonical. Page metadata uses the same ordering and a deterministic
catalog/default fallback when a climb has no eligible stats.

Angle segments are exact catalog values, not arbitrary integers. Both the
config-tuple and `/b` route trees reject unsupported angles and numeric aliases
such as `040`, `40.0`, or `5e1` with a 404. MoonBoard's full published angle set
remains routable regardless of its picker feature flag; Grasshopper includes its
real -5° setting without widening negative-angle support on other boards.

**Genuine alias uuids are excluded — self-aliases are not.**
`board_climb_aliases` maps duplicate uuids onto a canonical one, and an alias URL
self-canonicalises to itself, so submitting both forms is duplicate content by
construction. But the table is mostly **self**-aliases: every synced Kilter climb
has a row mapping its uuid to itself, written by migration
`0160_backfill_kilter_self_aliases` and by catalog-sync's identity path, because
deletion reconciliation resolves upstream removals through this table. In
production, the broken predicate matches **106,550 of 127,131** tier-2 climbs
(84%), while zero genuine aliases currently reach tier 2. So the exclusion
carries `alias_uuid <> canonical_uuid`; without it most of the sitemap vanishes
silently while the remaining boards keep the shard non-empty.

**MoonBoard configurations are held out of the shard.** `generateSetSlug` joins
set-name slugs with `_`, while the MoonBoard page's parser
(`getMoonBoardSetsBySlug`) splits the slug on `-` and substring-matches the parts
— so the set slug the shard emits does not round-trip, and the page's own
canonical comes back with a different set-id list. 212 of 227 layout×set
combinations mismatch, the full set lists on masters-2017 and masters-2019
included. `tryConstructSlugViewUrl` returns a URL for all 227, so the
resolvability probe cannot see it; the hold-out is a separate, named exclusion.
Costs nothing today (`getPopularConfigs()` emits no MoonBoard rows, excluding all
73,412 production tier-2 MoonBoard climbs before this guard runs) and stops the
shard going wrong the moment a `board_product_sizes_layouts_sets` seed lands.
Lifting it means making `getMoonBoardSetsBySlug` an exact `generateSetNameSlug`
match on `_`-split parts — a routing-parser change, not a sitemap one.

**`<lastmod>` is the later of the climb-content and chosen-angle stats clocks.**
Ascents and grades advance `board_climb_stats.updated_at`; name, description and
frame edits independently advance `board_climbs.updated_at` through the live
`trg_board_climbs_set_sync_fields` trigger. Both per-URL items and the summary pick
the later clock (the summary through `GREATEST`) so a renamed climb cannot publish
a new slug with an older timestamp.
The known risk is that a bulk upstream stats refresh flattens the signal for one
cycle; dropping the field remains a one-line fallback if that hurts crawling.

**Four caching layers, because a 52,842-item grouped scan is not a playlists query.**
`dbzRead` (the read pool), `withSerialPlan` (the parallel-hash-join guard behind
the `could not resize shared memory segment` class), an in-process TTL plus
single-flight promise so one instance builds the list once, and a six-hour CDN
window with a seven-day stale-while-revalidate. Group queries run **sequentially**
— a fan-out of concurrent heavy scans on a ten-connection pool is the
pool-starvation failure #4461 describes, and the test that pins it asserts
_concurrency depth_, not a call count, because a `Promise.all` rewrite leaves the
call count identical. The index reads `summary()` and never `buildPage()`; a unit
test asserts zero builder calls, and it is the assertion most likely to be
quietly broken later. The full item list is **not** in `unstable_cache`: ~20 MB
serialised is past the Data Cache's 2 MB entry ceiling, so it would silently
never cache.

The summary's **result** is two numbers; its **cost** is not. It is the same
`DISTINCT ON` scan as the item build, once per `(board_type, layout_id)` group —
measured on the full-board dev image at 9.2 s cold and 0.94 s warm for the single
largest group; production currently resolves 12 groups. `unstable_cache` does not deduplicate
concurrent misses, so on a cold Data Cache the index plus every shard page would
each run their own full scan; the summary therefore carries the same in-process
TTL and single-flight the item build does.

**What none of this covers: a genuinely cold cross-instance crawl.** The item
list is per-instance by construction, so if Googlebot fetches N shard pages that
all miss the CDN and land on N lambdas, the cost really is N full builds. Per-page
Data Cache entries would not help — building page N still needs the whole ordered
list before it can slice. The real fix is a materialised tier-2 table, which is
the tier-3 follow-up. State this plainly rather than letting the four layers read
as more protection than they are.

**Every climb page in the index carries the same `<lastmod>`** — the shard's
global `max(GREATEST(climb_updated_at, stats_updated_at))` — so one content or
stats update anywhere makes all N pages look changed. Bounded to ~4×/day by the
summary cache. A per-page value would require
building the items to know which page a climb fell on, which is the exact scan the
summary/build split exists to avoid, so the uniform value is the deliberate trade.
The aggregate is read through `to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` and
not a bare `max()`: a raw `sql` aggregate bypasses drizzle's timestamp mapper, and
`new Date()` reads the resulting pg text in the _process_ timezone, which would
silently offset the index `<lastmod>` on any non-UTC runtime while the per-URL
`<lastmod>` from the same clocks stayed correct.

**JSON-LD.** `BreadcrumbList` already shipped in W-15. This wave adds
`CreativeWork` (+ `aggregateRating`) on the climb front door, `Organization` +
`WebSite` on `/`, `ProfilePage` on `/profile/[user_id]`, and `ItemList` on
`/list`, all through one `JsonLd` component that escapes `<` so user content
cannot close the script block.

Every JSON-LD `url` is built with `absoluteLocaleUrl(path, locale)` — the same
`localeHref` call `createPageMetadata` makes for the canonical — so on `/es`,
`/fr` and `/de` the structured data names the locale-prefixed URL the page itself
claims rather than the en-US twin. And on a `/b/{slug}` page for an unlisted or
private board the `CreativeWork` is not emitted at all: `generateMetadata`
withholds `alternates` there precisely so a noindex URL never names its indexable
twin, and `CreativeWork.url` — the field Google uses for page association — would
have walked straight around that guard. (The pre-existing `BreadcrumbList` leaf
still emits it; that is W-15 code and is left for a follow-up.)

`aggregateRating` is emitted only when three conditions hold: `quality_normalized`
is true, `quality_average` is present and inside [1, 5], and the rating count is
at least 1. The first is not paranoia — Aurora reports quality on 1-3 and ~235k
JSON-imported Kilter rows are still on that scale, so publishing an unnormalized
average with `bestRating: 5` understates every one of them. The count is the
blend's **own** denominator (`upstream_ascensionist_count` where the upstream side
actually supplied a quality, plus `boardsesh_quality_count`), not
`ascensionist_count`. Stated precisely, because the loose version — "never
ascents" — is not a promise the expression can make: on an upstream-sourced climb
with no native ratings yet the denominator _is_ `upstream_ascensionist_count`, and
that is right, since Aurora's quality average is itself taken over the ascents
that rated the climb. What is excluded is the Boardsesh ascent count, and the
upstream ascents of a climb upstream never rated at all.

`Organization`/`WebSite` carry **no** `potentialAction` / `SearchAction`. www has
no site search after the W-16 teardown, and pointing one at an endpoint that does
not exist is a fabricated capability; a deep-scan test fails if anyone adds one.
`sameAs` lists only the two external URLs the site already publishes.

`ProfilePage` renders on the success path only — the `notFound()` and the
metadata `catch` branch are both `noindex, follow`. Note the interaction with
#4473: `/setter/[username]` is a client-only shell today, and no JSON-LD was added
there.

**Not in this wave, and pinned by tests:** no `VideoObject` (beta links are
third-party embeds and need a policy call), and no tier 3 —
`TIER_2_MIN_ASCENTS === 10` is asserted, so lowering it is a deliberate act.

## Phase A0 — blocking pre-delete QA gate (real devices)

**Historical — the gate this section describes was for the classic-code delete
(the maintainer plan's A5/A6), which shipped as W-16 (#4435) and the W-17/W-19/
W-20b redirect wave. Left as a record of what was required before that delete;
not an open checklist.**

The teardown was a **hard delete** with no retained `?classic=1` runtime
fallback, so the RN-web interactive sheets had to be proven on real devices
before the classic code was deleted. `@gorhom/bottom-sheet`'s web fallback does
not implement the gesture-lock / keyboard contracts the native sheets rely on
(see the "Expo web" section of `CLAUDE.md`). It was to run on **real hardware**
(not just simulators) on **both** origins — the Next-embedded `/app` and
standalone `app.boardsesh.com`:

Devices: a physical iPhone (iOS Safari) and a physical Android phone (Chrome).

- [ ] **Log ascent (`LogAscentSheet`)** opens from a climb, the on-screen keyboard
      does not cover the notes/grade fields, the sheet doesn't jump or dismiss on
      focus, and submit records the tick (verify it appears in the logbook).
- [ ] **Queue (`QueueSheet`)** opens, scrolls its virtualized list without the
      whole sheet scrolling, reorders, and the gesture-lock holds (drag inside the
      list doesn't dismiss the sheet).
- [ ] Rotate the device with each sheet open — no layout break or stuck backdrop.
- [ ] Repeat both on `app.boardsesh.com` (standalone) — it has no `?classic`
      escape hatch after the redirect wave, so a failure here would have blocked
      the whole delete.
- [ ] Record crash-free confirmation for each sheet × device × origin.

Sign-off on every box was the gate to start the classic-code delete (W-16).
**No device pass is on record.** The boxes above are unchecked because this doc
has no record of one having been run, and nothing above should be read as saying
it was — only that W-16 shipped anyway. If a real-device regression turns up in
these sheets, this gate is the first place to look, not the last.

## W-14 — the classic-web rollback artifact (#4368)

W-16 deletes ~110k LOC of the interactive classic web app and swaps the root
chrome in one commit, with no `?classic=1` runtime fallback (W-09 removed the
last of that hatch). Reverting that under incident pressure with `git revert`
means reintroducing that much code, re-mounting a provider tree, rebasing over
every subsequent merge, and passing `check:i18n:orphans` — hours of work at the
worst possible time.

**The rollback is a deployable artifact, not a revert.** This is a locked
decision: **no downstream PR (W-15/W-16/W-17 or anything after) may propose
`git revert` as the recovery plan.** The recovery plan is always "promote
`release/classic-web`" (below).

### The artifact

- **Tag `classic-web-last-good`** — an annotated tag at
  `7bd5300d980f8c9a7b9c1f337ce57ec4d98d803f`, the last commit that serves the
  full interactive classic web app (pre-W-15 front doors, W-13a merged).
- **Branch `release/classic-web`** — pushed at the same commit, so it can be
  fast-forwarded/read from without resolving a tag ref.

Both were cut from `main` at that exact commit (verify with
`git log --oneline -1 classic-web-last-good`). If `main` advances past this
point before #4369 merges, **re-cut both** onto the new last-pre-W-15 commit —
don't leave the artifact pointing at a stale, no-longer-last-good SHA:

```bash
git fetch origin main
NEW_SHA=<last commit before #4369's merge, on main>
git tag -f -a classic-web-last-good "$NEW_SHA" -m "Last commit serving the full interactive classic web app (pre-W-15 front doors).

The web-reposition programme's rollback point: epic #4358, issue #4368 (W-14).
The deployable artifact is branch release/classic-web at this same commit.
Restore procedure: docs/web-reposition.md (W-14 section)."
git push origin refs/tags/classic-web-last-good --force
git branch -f release/classic-web "$NEW_SHA"
git push origin release/classic-web --force
```

The re-cut rule is about commits that change what the web app serves. `main`
gains automated `chore(changelog): refresh from merged PRs [skip ci]` commits
that touch `CHANGELOG.md` and `packages/mobile/src/data/changelog.generated.json`
only — it had already taken two of those within a day of the cut — and those
don't make the artifact stale. Anything that touches `packages/web` or the
packages it builds against does.

Update this section's SHA and the retention expiry date (below) after a re-cut,
and re-run the local verification and preview dispatch described below against
the new SHA before trusting the artifact again.

### Restore procedure

**Vercel's git auto-deploy is off** (`packages/web/vercel.json` →
`git.deploymentEnabled: false`), so pushing `release/classic-web` — or any
branch — deploys nothing by itself. **Production deploys only run from
`.github/workflows/production-deploy.yml` on push to `main`.** That workflow
also has a `workflow_dispatch` trigger, but every job that touches deploy
secrets declares `environment: Production`, and the `Production` GitHub
environment is scoped to the `main` branch — dispatching it from a non-`main`
ref will not resolve those secrets (see `docs/branch-deploys.md`). **Do not
attempt to dispatch `production-deploy.yml` from `release/classic-web`
directly** — it will build but fail (or silently no-op) on every
Production-environment step.

So the honest restore path is a **tree-restore commit onto `main`**, landed
through the normal PR + merge flow so it rides the existing pipeline. Build the
commit with plumbing, so the tree is byte-identical by construction and no hook
can rewrite it on the way in:

```bash
git fetch origin
RESTORE=$(git commit-tree origin/release/classic-web^{tree} -p origin/main -m "revert: restore the classic interactive web app (rollback via release/classic-web)

Refs #4368. This is the W-14 rollback artifact, not a git revert of the
individual web-reposition commits — see docs/web-reposition.md.")
git branch restore/classic-web "$RESTORE"
git push -u origin restore/classic-web

# Assert before opening the PR — must print nothing:
git diff --stat restore/classic-web origin/release/classic-web
```

If you want the files in the working tree first (to read them, or to run the app
locally before you ship it), the index form does the same job:

```bash
git checkout -b restore/classic-web origin/main
git read-tree -u --reset origin/release/classic-web
git commit -m "revert: restore the classic interactive web app …"
git diff --stat HEAD origin/release/classic-web   # must print nothing
```

— with one caveat: `git commit` runs this repo's pre-commit hook
(`core.hooksPath=.vite-hooks`, `pre-commit` → `vp staged`, i.e.
`vp check --fix`) across the **entire** staged restore. It is slow, it can abort
the commit outright (it did when this sequence was re-run in a fresh worktree),
and `--fix` rewrites staged files, which quietly breaks the byte-identical
property. `git commit-tree` sidesteps all of that: it writes the commit straight
from the artifact's tree object, touching no index and running no hook. Either
way the `git diff --stat` assertion is part of the procedure, not a flourish —
if it prints anything, the tree you are about to ship is not the artifact.

Then open a **fast-track PR** `restore/classic-web` → `main`. Merging it is an
ordinary push to `main`: `production-deploy.yml`'s `detect-changes` job sees a
normal file diff, `build-web`/`build-backend` build it, `migrate` gates it, and
`deploy-web`/`deploy-production-backend` ship it to `www.boardsesh.com`. It
rides the same `Production` GitHub environment secrets (`VERCEL_TOKEN`,
`DATABASE_URL`, `RAILWAY_TOKEN`, …) every other production release uses — no new
secrets, no Vercel alias surgery. **Who can do it:** anyone with merge rights on
`main`, no special access beyond the normal release path. The four subsections
below are the parts that are _not_ ordinary; read them before merging.

**The tree restore itself is verified**, not just written down: run in a
throwaway branch off `origin/main` with a dummy commit added first (to
simulate `main` having drifted from the rollback point), `git read-tree -u
--reset origin/release/classic-web` correctly staged the dummy file for
deletion, and the resulting commit's tree (`git rev-parse HEAD^{tree}`) came
back **identical** to `git rev-parse origin/release/classic-web^{tree}` —
`880b792ba7db3819c50c5d93d38a7b233dc86c10`, empty `git diff --stat` between the
two — regardless of what `main` looked like beforehand. That property belongs to
the restore **commit**; it does not survive the **merge** by itself.

#### Re-verify at merge time — the merge is not the commit

Merging `restore/classic-web` is a three-way merge (squash included) whose base
is `main` as it stood when you cut the branch. Anything that lands on `main`
afterwards survives that merge with no conflict and no warning: the restore
commit says nothing about files that didn't exist when it was written. Confirmed
with `git merge-tree --write-tree` — add one file to `main` after cutting the
restore branch and the merged tree contains it, so it differs from
`release/classic-web` by exactly that file. `main` here takes automated
`chore(changelog): refresh from merged PRs [skip ci]` pushes on top of normal
merges, so the window is never empty; `main` had already moved past the cut
point within a day of the cut.

A W-16-era file that only exists post-cut — a new expo-web front-door route,
say — would then ship next to the restored classic `layout.tsx`: neither
version, a red build at best and green-but-wrong at worst.

**The invariant to hold at merge time: `restore/classic-web`'s parent is the
current `main` tip**, i.e. the PR merges as a fast-forward. Immediately before
merging:

```bash
git fetch origin
git merge-base --is-ancestor origin/main restore/classic-web && echo "fast-forward OK"
```

If that fails, rebuild the branch — **`git rebase` does not re-restore the
tree**, it replays the old diff and keeps the post-cut files:

```bash
git branch -f restore/classic-web \
  "$(git commit-tree origin/release/classic-web^{tree} -p origin/main -m 'revert: restore the classic interactive web app (rollback via release/classic-web)')"
git push --force-with-lease origin restore/classic-web
git diff --stat restore/classic-web origin/release/classic-web   # must print nothing
```

#### The blast radius is the whole repo, not just the web app

`git read-tree` restores **every path**, not `packages/web`. That sweeps up the
paths the mobile pipeline watches — `packages/mobile/**`, `packages/shared/**`,
`packages/shared-schema/**`, `packages/board-constants/**`, `package.json`,
`pnpm-lock.yaml`, `patches/**` — and each of those is a push-to-`main` trigger for:

- `mobile-ota-production.yml` — publishes a **production OTA** to every install
  whose native fingerprint still matches, i.e. the restore merge republishes the
  artifact's (by then old) JS bundle to the live native fleet.
- `ios-testflight-rn.yml` and `android-apk-rn.yml` — native builds off the old
  tree.
- `production-deploy.yml`'s `deploy-app-web` job — its `app_changed` list is
  `packages/mobile/*`, `packages/shared/*`, `packages/shared-schema/*`,
  `scripts/build-expo-web-export.sh`, and the two CF Pages host files — so it
  rebuilds and ships `app.boardsesh.com`, the expo-web app, off the old tree too.

Not hypothetical: `main` already differs from `release/classic-web` in
`packages/mobile/src/data/changelog.generated.json`, so a whole-tree restore
today already touches `packages/mobile/**` and fires all four. The repo has form
here — a parity-restoring revert once shipped a whole drift backlog to
production (2026-07-17).

Pick one before merging:

1. **Scope the restore to the web surface** — the default when the incident is
   web-only. `packages/web` appears in none of the mobile trigger lists. Delete
   the current subtree first: a bare `git checkout <ref> -- packages/web`
   restores the artifact's files but leaves behind any file W-15/W-16 _added_
   under `packages/web`, which is how you get a tree that is neither version.

   ```bash
   git checkout -b restore/classic-web origin/main
   git rm -rq packages/web
   git checkout origin/release/classic-web -- packages/web
   git diff --stat origin/release/classic-web -- packages/web   # must print nothing
   ```

   Verified the same way as the whole-tree restore: with a dummy
   `packages/web/app/AFTER-CUT.ts` committed on top of `main`, the sequence
   above removed it and left `packages/web` byte-identical to the artifact
   (empty `git diff --stat`).

   If the web build then fails against a drifted shared package, add that
   package specifically (same delete-then-restore shape) and re-read the list
   above: anything under `packages/shared*` puts the mobile workflows back in
   play.

2. **Whole-tree restore with the mobile side held.** Before merging,
   `gh workflow disable mobile-ota-production.yml` (and `ios-testflight-rn.yml`,
   `android-apk-rn.yml`), and set the repo variable `APP_WEB_DEPLOY_HOLD` —
   `deploy-app-web` skips while it is non-empty, and `notify-app-web-held` posts
   a reminder so the hold can't be silently forgotten. Re-enable all four and
   publish forward once the web incident is closed.

#### A pinned Instant Rollback stops the restore reaching www

Instant Rollback is the first-line incident mitigation
(`docs/branch-deploys.md` § "Instant Rollback interaction"), so the realistic
order of events is: someone pins production to an older deployment, _then_ the
restore PR merges. When `check-rollback` sees an active rollback, `deploy-web`
runs `vercel deploy --prebuilt --prod --skip-domain` — uploaded, not assigned to
the production domain — `deploy-production-backend` pushes the image to GHCR
without redeploying Railway, and the post-deploy smoke against www is skipped.
Every job goes green. The only signal is the `notify-no-promote` Discord
message.

Clear the Instant Rollback in the Vercel dashboard before merging the restore
(or promote the staged deployment afterwards), and confirm www is actually
serving it. A green pipeline is not proof here.

#### The restore rolls back code, never the database

`migrate` runs `db:migrate` forward only; nothing un-applies a migration. The
`VERIFY_MIGRATION_JOURNAL=1` gate only fails when a migration file exists but is
missing from the ledger (`findUnappliedMigrations`,
`packages/db/scripts/migration-journal.ts`), so a restored tree with _fewer_
migrations than the database passes it silently. Harmless for expand-phase
migrations (new columns the classic code ignores); fatal for a contract-phase
one — a column dropped or renamed after the cut is still gone after the restore,
and classic code that reads it breaks.

While this artifact is the rollback plan, every production migration must stay
backward-compatible with `release/classic-web` — the same expand/contract rule
`docs/branch-deploys.md` already states for Instant Rollback. If a
contract-phase migration has landed since the cut, the restore needs a paired
forward migration that re-adds what it removed: write that before the incident,
not during it.

### Preview verification — the alias gate is UNMET

The issue's gate is "the alias serves a working classic climb page with the
queue drawer," proven by hand, not just a green build. **That gate is not met**,
and two independent pieces of infrastructure have to come back before it can be
— the runner is only half of it:

1. **No runner.** `pull_request` triggers are commented out in
   `branch-deploy.yml`, `branch-deploy-cleanup.yml`, and
   `branch-deploy-sweep.yml` (commit `b2276e456`, "these workflows are currently
   broken and will be fixed later"), so opening a PR auto-triggers nothing. The
   remaining `workflow_dispatch` path's `deploy` job wants
   `runs-on: [self-hosted, homelab, ephemeral]`, and
   `gh api repos/boardsesh/boardsesh/actions/runners` returns `total_count: 0`.
   The last real dispatch before this work (2026-07-20, run `29720371986`) shows
   `build-images` succeeding and `deploy` giving up after 24h "awaiting a
   runner".
2. **No DNS.** The wildcard `*.preview.boardsesh.com` CNAME → Cloudflare Tunnel
   that `docs/branch-deploys.md` § 2.2 describes does not resolve at all:
   `getent hosts 4427.preview.boardsesh.com` returns nothing (as does any other
   `*.preview` name), while `www.boardsesh.com` resolves and answers 200 from
   the same shell. Even with a healthy runner, the Traefik `Host()` rule the
   deploy job writes has nothing routing to it until the record and the tunnel
   are back.

**Preview PR #4427** (`preview/classic-web-rollback`, one empty commit on top of
`release/classic-web`, draft, never-merge) is the standing verification route
once both are fixed. Dispatch it **against the branch**, not just the PR number:

```bash
gh workflow run branch-deploy.yml \
  --ref preview/classic-web-rollback \
  -f pr_number=4427
```

`--ref` is what decides which code gets built. `build-images` checks out with a
bare `- uses: actions/checkout@v6` (no `ref:`), so on `workflow_dispatch` it
builds the ref the workflow was dispatched against; `pr_number` only names the
GHCR image tag (`boardsesh-web:pr-4427`), the Traefik `Host()` rule
(`4427.preview.boardsesh.com`), and the `BASE_URL` / `NEXT_PUBLIC_WS_URL` build
args. Dispatch from the default branch with `pr_number=4427` and you build
`main` and serve it at the 4427 hostname — which is exactly what the first
attempt here did (run `31797731863`: `headBranch: main`, `headSha: 31ccf56a6`).

So confirm which build you are looking at before believing anything:

```bash
curl -s "https://4427.preview.boardsesh.com/kilter/original/12x12-square/screw_bolt/40/list" \
  | grep -c 'data-testid="queue-control-bar-shell"'   # 1 = classic chrome, 0 = wrong build
```

Only then do the part that needs a human: open the page, open the queue drawer,
drag a climb in. Re-run this periodically to keep the artifact honest, and again
before ever promoting `release/classic-web` for a real incident.

Until both prerequisites are back, verification of this commit is markup-level
and local — `vp run dev` in a worktree checked out at `classic-web-last-good`,
against the shared dev Postgres:

```bash
# Use whatever host/port `[dev]` prints on startup. The default is
# http://localhost:3000; the run recorded here was on a Tailscale-TLS dev
# server that had fallen through to 3001.
curl -s -o list-page.html -w "HTTP_CODE=%{http_code}\n" \
  "http://localhost:3000/kilter/original/12x12-square/screw_bolt/40/list"
# HTTP_CODE=200

grep -o 'data-testid="bottom-bar-wrapper"' list-page.html   # 1 match
grep -o 'data-testid="bottom-tab-bar"' list-page.html       # 1 match
grep -o 'data-testid="queue-control-bar-shell"' list-page.html  # 1 match
```

All three mount markers from
`packages/web/app/components/providers/persistent-session-wrapper.tsx`
(`RootBottomBar`) are present — the persistent bottom-bar wrapper, the bottom
tab bar, and the queue-control-bar shell (shown because a cookie-less request
has no active queue yet, which is expected). This proves the classic chrome
renders server-side at this commit. It proves nothing about the interactive
drawer.

**The drawer-level check that can run today**, with no preview infrastructure,
is the repo's own Playwright suite against a local checkout of the artifact —
`packages/web/e2e/queue-persistence.spec.ts` double-clicks a climb card, waits
for `[data-testid="queue-control-bar"]`, and asserts the queue survives
navigation:

```bash
git worktree add ../classic-check classic-web-last-good
cd ../classic-check && vp run test:e2e
```

Run that before promoting the artifact for a real incident. It is not a
substitute for the alias gate — it says nothing about the image building or
Traefik routing to it — but it is the only browser-level evidence available
while the runner and the DNS record are both down.

### Retention — 90 days

Cut **2026-08-14**. **Expires 2026-11-12.** Put a reminder on the epic
(#4358) before that date:

- If the web-reposition programme has shipped cleanly and nothing has needed
  the rollback, **delete both** — `git push origin --delete release/classic-web`
  and `git push origin --delete classic-web-last-good` (plus the local tag
  with `git tag -d classic-web-last-good` if you have it checked out) — don't
  let it silently rot as an ever-growing, never-reviewed fork of history.
- If the programme is still mid-flight (W-16 not yet landed, or there's
  active incident risk), **consciously re-cut** — same commands as the
  "advances past this point" case above — and push the expiry another 90 days.

Do not let this artifact linger unreviewed past its expiry date in either
direction: it is either actively re-justified for another 90 days, or gone.
