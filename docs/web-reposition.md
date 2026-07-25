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
web proxies. The only web endpoints `packages/mobile/src` fetches are
`/api/auth/session`, `/api/internal/ws-auth`, and `/api/internal/beta-link-thumbnail`.

| Route                                                                     | Runtime callers                                                                                                    | Verdict                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `/api/v1/[board]/proxy/{login,saveAscent,saveClimb,getLogbook,user-sync}` | **None** — already migrated to GraphQL (see `docs/branch-deploys.md`)                                              | delete (dead code)                    |
| `/api/internal/{join,controllers,favorites}`                              | Only web session-app UI slated for teardown (`join/*` page, `settings/controllers-section.tsx`, `climb-actions/*`) | delete with that UI                   |
| `/api/internal/ws-auth`                                                   | `use-ws-auth-token.ts` → ~85 web files incl. kiosk presence; mobile `auth-store.web.ts:343`                        | **KEEP** — `/app` + kiosk auth bridge |

Loose ends to clean when the routes go (not runtime callers, but they'd go stale):
`app/lib/api-docs/openapi-routes.ts` (documents `proxy/login`, `proxy/saveAscent`),
`docs/branch-deploys.md` migration table, and the routes' own `__tests__`.

### `/app` redirect destinations (for the route redirects in A6)

| Web route removed  | `/app` destination                                          | Status                                                                                                                                         |
| ------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `join/[sessionId]` | `/app/join/{sessionId}`                                     | exists (`packages/mobile/app/join/[sessionId].tsx`; universal-link `/join` registered)                                                         |
| `/you`             | `/app/profile`                                              | exists (`(tabs)/profile/index.tsx`)                                                                                                            |
| `/settings`        | `/app/profile/more`                                         | no bare `/app/settings` — redirect to `/app/profile/more`                                                                                      |
| `/notifications`   | —                                                           | **no mobile route** — point at `/app/profile` or defer                                                                                         |
| climb view         | `/app/climbs/{uuid}?boardName&layoutId&sizeId&setIds&angle` | exists; **all five query params required**, numeric IDs                                                                                        |
| `/list`            | `/app/climbs`                                               | exists, but the Climbs tab reads its board from the persisted active board, **not** the URL — board context is lost on a bare `/list` redirect |

### Board layout provider mounts (asymmetric — matters for A5)

- **Legacy tree:** `BoardProvider` is mounted at the top in `[board_name]/layout.tsx`, wrapping **all** children. The deep `[angle]/layout.tsx` mounts the session providers (`GraphQLQueueProvider`, `WebSocketConnectionProvider`, `ConnectionSettingsProvider`, `BoardSessionBridge`, `UISearchParamsProvider`, `QueueBridgeInjector`, `BoardSeshHeader`) and the `<main id="content-for-scrollable">` shell + `I18nProvider`, but **not** `BoardProvider`.
- **Slug tree:** no `[board_slug]`-level layout — `b/[board_slug]/[angle]/layout.tsx` mounts `BoardProvider` **and** all the session providers together (nested inside `I18nProvider`).
- **Coupling to break first:** `b/[board_slug]/[angle]/list/layout.tsx` imports `ListLayoutClient` from the **legacy** tree (`[board_name]/…/list/layout-client.tsx`), and that client consumes the queue (`useQueueActions`/`useQueueList`). The static `/list` (A3) must replace this before the legacy tree can be deleted.

### Kiosk / embed presence dependencies (relocate before A5 deletes them)

`components/kiosk/presence/kiosk-presence-hub.tsx` imports, from dirs slated for
deletion: `graphql-queue/graphql-client` (`createGraphQLClient`),
`board-presence/board-presence-client` (`createWebBoardPresenceClient`, which
also pulls `board-presence/board-presence-events` + `-context`), and
`useWsAuthToken` (kept). The hub renders on `/kiosk/*`, `/embed/board/*`, and the
gym-manage `kiosk-preview.tsx`. **Not** on `/embed/gym/*/leaderboard` (that's a
historical period leaderboard, no presence socket). A5-pre relocates the two
clients into a kept module and builds the login-less "now on the wall" query.

### `/playlists` is NOT clean (blocks the `climb-actions/*` delete)

The kept `/playlists/[playlist_uuid]` detail page depends on `climb-actions/*`:
`playlist-detail-content.tsx` imports `PlaylistActivationProvider` directly, and
renders `climb-list/multiboard-climb-list.tsx`, which imports both
`FavoritesProvider` and `PlaylistsProvider` (defined only in `climb-actions/`)
plus `useOptionalPlaylistActivation`. Refactor `multiboard-climb-list.tsx` and
`playlist-detail-content.tsx` off `climb-actions/*` before deleting that dir. The
`/playlists` library index page is clean.

## Phase A0 — invariant tests added

- `app/__tests__/crawler-classic-invariant.test.ts` — an anonymous request (no
  session cookie) never redirects to `/app` on any board surface, even with
  `BOARDSESH_WEB=1` + the flag cookie on. Protects the SEO/crawler audience
  through the teardown.
- `app/__tests__/climb-canonical-parity.test.ts` — documents that the legacy and
  `/b` view trees self-canonicalize into different URLs today (split PageRank).
  **Flip at A1:** once the `url-utils` helpers emit `/b`, change the legacy
  assertion to `.startsWith('/b/')` and assert parity.
- `b/[board_slug]/[angle]/view/[climb_uuid]/__tests__/view-seo-fragment.test.tsx`
  — the climb-view page SSR-emits `ClimbViewSeoFragment` (the crawlable payload).
  Guards A2's drawer→static swap from dropping it.

## Phase A0 — blocking pre-delete QA gate (real devices)

The teardown is a **hard delete** with no retained `?classic=1` runtime fallback,
so the RN-web interactive sheets must be proven on real devices before A5/A6
delete the classic code. `@gorhom/bottom-sheet`'s web fallback does not implement
the gesture-lock / keyboard contracts the native sheets rely on (see the "Expo
web" section of `CLAUDE.md`). Run this on **real hardware** (not just simulators)
on **both** origins — the Next-embedded `/app` and standalone `app.boardsesh.com`:

Devices: a physical iPhone (iOS Safari) and a physical Android phone (Chrome).

- [ ] **Log ascent (`LogAscentSheet`)** opens from a climb, the on-screen keyboard
      does not cover the notes/grade fields, the sheet doesn't jump or dismiss on
      focus, and submit records the tick (verify it appears in the logbook).
- [ ] **Queue (`QueueSheet`)** opens, scrolls its virtualized list without the
      whole sheet scrolling, reorders, and the gesture-lock holds (drag inside the
      list doesn't dismiss the sheet).
- [ ] Rotate the device with each sheet open — no layout break or stuck backdrop.
- [ ] Repeat both on `app.boardsesh.com` (standalone) — it has no `?classic`
      escape hatch after A6, so a failure here blocks the whole delete.
- [ ] Record crash-free confirmation for each sheet × device × origin.

Sign-off on every box is the gate to start A5. If any fails, hold the delete and
fix the sheet on expo-web first.
