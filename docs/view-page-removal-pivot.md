# Remove the Climb View Page — Drawer Becomes the Surface, URL Becomes a Sync Channel

**Status:** Implemented in [PR #2194](https://github.com/boardsesh/boardsesh/pull/2194)
**Decision date:** 2026-05-16
**Owner:** Marco de Jongh
**Builds on:** `docs/queue-control-bar-pivot.md` (Phase 1 already merged into this branch — the drawer is now a browsing surface that does not yank the wall in party sessions). This plan extends that direction by making the drawer the _only_ surface for climb detail and folding the standalone `/view/` page into it.

---

## Problem

We currently render climb detail in two completely different surfaces:

1. **The `/view/{climb_uuid}` page** — a full-screen Next.js route that renders `ClimbDetailPageServer` → `ClimbViewActions` + `ClimbDetailInfoShellClient`. Used for share links, activity-feed deep links, draft links, and the OG share image. Reachable at:
   - `/{board_name}/{layout_id}/{size_id}/{set_ids}/{angle}/view/{climb_uuid}` (canonical, indexable)
   - `/b/{board_slug}/{angle}/view/{climb_uuid}` (short alias)
2. **The Play View Drawer** — a bottom-sheet that opens on top of any list page. Used for the tap-a-climb-in-the-list flow.

Both surfaces compose the _same_ underlying pieces (`ClimbCard` for the board image, `useBuildClimbDetailSections` for the info accordion, `ClimbActions` for the action menu). The duplication has three concrete costs:

- **Two layouts to maintain.** `ClimbDetailPageServer` (full page) and `PlayViewDrawer` (drawer) drift independently. The drawer has `SwipeBoardCarousel`, prev/next, swipe-as-preview, tick FAB, mirror, favorite, share, angle selector, queue badge, climb actions menu, playlist selector, and nested queue drawer. The full page has none of that and would have to grow each one separately if we kept it.
- **Two interaction models.** Tapping a list row opens the drawer (party-safe, browse-doesn't-yank). Following an external link opens the full page (no drawer chrome, no swipe, no in-context navigation). A user who lands from a share link cannot prev/next through suggestions without going back to the list first.
- **Two analytics surfaces, one event.** `Climb List Row Clicked` fires from the list. The full page is silently entered without an equivalent event. `Set Active Climb` semantics differ between surfaces (the drawer just opens; the page does not auto-set).

## The pivot

Delete the standalone view page. The PlayViewDrawer becomes the only climb-detail surface. The `/view/{climb_uuid}` URLs continue to exist as _shareable, indexable URLs_ — but loading one renders the climbs list for that board with the drawer pre-opened on the requested climb.

Five rules:

1. **One UI for climb detail: the drawer.** All paths into climb detail (list tap, share link, activity-feed thumbnail, draft link, OG share) render the climbs list with the PlayViewDrawer on top displaying the requested climb. There is no second layout.
2. **URL reflects the drawer.** When the drawer opens, the URL changes to `…/view/{climb_uuid}` via `history.pushState`. When it closes, the URL returns to `…/list`. Inside the drawer, prev/next/swipe call `history.replaceState` to track the displayed climb. The browser's share button, address bar, and back button all do the right thing — the user can copy from the URL bar and paste in iMessage and the recipient lands on the same climb.
3. **The view route is one route, not a special server page.** The `/{board_name}/…/{angle}/view/{climb_uuid}` and `/b/{slug}/{angle}/view/{climb_uuid}` routes survive, but their `page.tsx` becomes a thin wrapper around the same list-page renderer plus an "open the drawer on mount with this uuid" hint. The server still emits unique metadata (title, description, OG image, hreflang) for SEO; only the visible content changes shape.
4. **SEO content lives in a dedicated visually-hidden fragment.** The drawer's content depends on client-side queue state (`currentClimbQueueItem` is null at SSR time), so it can't carry the climb name in its initial HTML. The view route renders `ClimbViewSeoFragment` — a server component that emits `<h1>{climbName}</h1>` plus a summary inside an `sx={visuallyHidden}` `<section>` so crawlers (and the brief pre-hydration paint) get the climb name without doubling up with the drawer's own header once interactive.
5. **The dedicated full-page detail components get deleted.** `ClimbDetailPageServer`, `ClimbDetailInfoShellClient`, `ClimbViewActions`, `climb-view-actions.module.css`, `climb-view-sidebar.tsx`, and `climb-view.module.css` no longer have a caller after this pivot. They go away. The pieces they composed — `ClimbCard`, `useBuildClimbDetailSections`, `ClimbDetailHeader`, `ClimbDetailShellClient`, `ClimbActions` — stay, because the drawer composes them too.

## Why this is the Next.js-native shape

Next.js App Router has three idiomatic patterns for "the same content rendered as a page sometimes and as an overlay other times":

- **Parallel + intercepting routes** (`@modal/(.)view/[climb_uuid]`). This is the Instagram photo pattern — soft-navigate from the list intercepts and shows the drawer; hard-navigate to the URL shows the full page. Powerful, but requires duplicating the route tree under the existing `[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/` slug chain, and the intercept doesn't survive a hard refresh — you'd still need a "real" page fallback. Net: two UIs to maintain, the original problem in a different shape.
- **One route, conditionally render a modal based on a search param** (e.g. `…/list?view={climb_uuid}`). Clean state model but loses pretty URLs and breaks all the existing share links to `/view/{climb_uuid}`.
- **One route per surface, drawer mounted in the layout, page tells the drawer to open** (this plan). The `/list` and `/view/{uuid}` routes are sibling pages under the same `[angle]/layout.tsx`. The layout already mounts the queue providers, the BluetoothProvider, and (via `QueueControlBar` mounted by `persistent-session-wrapper`) the `PlayViewDrawer`. The view page just needs to dispatch the existing `dispatchOpenPlayDrawer(climb)` event on mount. No new route topology, no intercept gymnastics, no second renderer.

The third option is the cheapest fit for our existing layout tree and is the one this plan adopts.

## Architecture sketch

```
[angle]/layout.tsx
  └── I18n + GraphQLQueue + Party + Bluetooth + UISearchParams providers
      └── <BoardSeshHeader />
      └── {children}                        ← /list, /view, /play, etc.
      └── <QueueControlBar />               ← rendered by persistent-session-wrapper
            └── <PlayViewDrawer keepMounted /> ← already keep-mounted; opens on event
```

**`/list/page.tsx`** (today): SSR-fetches the first page of climbs, renders `<BoardPageClimbsList initialClimbs=… />`. Stays unchanged.

**`/view/[climb_uuid]/page.tsx`** (today): SSR-fetches the climb, renders `<ClimbDetailPageServer />`.

**`/view/[climb_uuid]/page.tsx`** (after this pivot):

1. SSR-fetches the climb (same as today) for metadata + slug redirect.
2. SSR-fetches the first page of climbs (same query as `/list`) so the list under the drawer is real, not empty.
3. Emits the same `generateMetadata` output as today (unique title, description, OG image, canonical, hreflang) — SEO unchanged.
4. Renders `<BoardPageClimbsList initialClimbs={…} initialOpenClimbUuid={parsedParams.climb_uuid} initialOpenClimb={climb} />`.

**`<BoardPageClimbsList>`** gets one new pair of optional props (`initialOpenClimbUuid`, `initialOpenClimb`). When they're present, on first mount it calls `dispatchOpenPlayDrawer(initialOpenClimb)` so the drawer is open before paint. The drawer is already mounted in the layout tree via the queue control bar, so this is a synchronous open with no flash.

**`<PlayViewDrawer>`** grows a URL-sync side-effect:

- When `isOpen` flips from `false` → `true`: if the current pathname does not already contain `/view/{uuid}`, call `history.pushState(state, '', viewUrl)`.
- When the displayed climb changes (prev/next/swipe): call `history.replaceState(state, '', viewUrl)`.
- When `isOpen` flips from `true` → `false`: if the current URL contains `/view/`, call `history.back()` to pop the entry the drawer pushed (mirrors today's `#playing` hash trick).
- A `popstate` listener already syncs the queue with the URL on browser back; extend it to also trigger drawer close when the user navigates off `/view/`.

## URL sync — the details that matter

The drawer today uses `window.history.pushState(null, '', '#playing')` and a `popstate` listener that closes the drawer when the hash goes away. This plan replaces that with a full-path push so the URL is shareable.

The interesting cases:

- **List page → tap climb → drawer opens.** Pathname goes from `/{board}/…/list?search=…` to `/{board}/…/view/{climb_uuid}?search=…`. Search params preserved. No Next.js navigation — `history.pushState` only; the page tree does not re-render.
- **List page → tap climb → swipe to next.** Pathname changes from `/view/{a_uuid}` to `/view/{b_uuid}` via `history.replaceState`. The list under the drawer is unchanged. No history entries added per swipe (replacement, not push).
- **Drawer open → close button or backdrop tap.** `history.back()` pops the entry from the open, taking the URL back to `/list?search=…`. Identical to today's `#playing` close behavior.
- **Drawer open → browser back button.** `popstate` fires; the drawer's listener closes it. The URL is now `/list?search=…` because that was the previous history entry.
- **Direct hit to `/view/{climb_uuid}` from a share link.** The page SSR-renders the list with the drawer pre-opened. `history` already shows `/view/{uuid}` as the current entry; the drawer's open effect detects "URL already matches" and skips the pushState (so closing it does _not_ try to go back past the share link's entry — instead it pushes the list URL forward).
- **Direct hit → close drawer.** Since there's no history entry to pop back to, the close handler calls `router.push(listUrl)` instead of `history.back()`. This keeps the browser back button working — pressing back from the list takes the user where they came from (the iMessage, the share link, etc.), not into a dead drawer state.
- **In-drawer prev/next on a direct hit.** `history.replaceState` — same as the list-tap case. The "I navigated within the drawer" entries don't accumulate.

Two pieces of state need to be encoded in the `history.state` payload so the browser back/forward dance survives reloads and tab restores:

- `{ openClimbUuid: 'abc-123', source: 'list-tap' | 'direct' }` — `source` tells the close handler whether to `history.back()` or `router.push(listUrl)`.

The PlayViewClient at `/play/{climb_uuid}/play-view-client.tsx` already does this exact pattern (pathname-based pushState, popstate listener that syncs queue from the URL — see lines 49-66, 85-105). Lift it into a small shared hook (`useDrawerUrlSync`) so the drawer and the play view stop duplicating the logic.

## What we delete

After this pivot, the following have no callers and get removed:

- `packages/web/app/components/climb-detail/climb-detail-page.server.tsx`
- `packages/web/app/components/climb-detail/climb-detail-info-shell.client.tsx`
- `packages/web/app/components/climb-view/climb-view-actions.tsx`
- `packages/web/app/components/climb-view/climb-view-actions.module.css`
- `packages/web/app/components/climb-view/climb-view-sidebar.tsx` (verify no other callers first)
- `packages/web/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/view/[climb_uuid]/climb-view.module.css`
- The `back-button` import path in `ClimbViewActions` may still be used elsewhere — verify before deleting.

The route files **stay** with new contents:

- `packages/web/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/view/[climb_uuid]/page.tsx` — keep `generateMetadata` and the numeric-to-slug redirect; replace the body with the list-page renderer.
- `packages/web/app/b/[board_slug]/[angle]/view/[climb_uuid]/page.tsx` — same treatment.

The URL helper functions (`constructClimbViewUrl`, `constructClimbViewUrlWithSlugs`, `tryConstructSlugViewUrl`, `getContextAwareClimbViewUrl`) all stay — they're still needed for share-link generation, OG image links, activity-feed thumbnails, draft links, etc.

The `back-button` component and `ClimbActions` component stay (the drawer uses them).

## SEO — what must survive

Per CLAUDE.md the view page is an indexable SEO surface. The post-pivot version must keep:

- **Unique `generateMetadata`** — title, description, OG image, canonical, hreflang alternates. The existing `metadata.view.*` i18n keys stay. No `robots: { index: false, follow: true }`; the page remains indexable.
- **First-render content with the climb's name, grade, setter** — today this lives in `ClimbDetailHeader` inside `ClimbDetailPageServer`. After the pivot, the keep-mounted drawer SSRs the same content because it composes `ClimbDetailHeader` and `useBuildClimbDetailSections`. Crawlers see climb name in `<h1>` (currently `ClimbDetailHeader` uses `<Typography variant="h2">` — check whether the drawer keeps that semantic level; raise to `h1` if needed for SEO).
- **JSON-LD if we already emit it.** Verify with grep before pivoting — if `createPageMetadata` doesn't already produce structured data, this pivot is neutral. If it does, keep it.
- **Sitemap.** `/view/` pages are not currently in `packages/web/app/sitemap.ts` (only static marketing routes are). No change needed.
- **`/b/{slug}/{angle}/view/{climb_uuid}`** — same treatment. The page wrapper does the same thing but uses `boardToRouteParams` to derive the deep params.

The one SEO regression risk is that the drawer's first-render HTML is positioned _visually on top of_ the list, but a crawler sees a flat DOM. Make sure the drawer's content is real DOM (not in a portal) on SSR, and that the drawer's content order in the markup is `climb-detail` → `list`, not the reverse. The existing `SwipeableDrawer` uses MUI Portal by default; verify that `disablePortal` or equivalent applies on SSR. **If the drawer cannot be SSRd inline, the page must server-render the climb detail content as a separate visible fragment** (e.g. `<noscript>`-style or visually-hidden) so crawlers still see the climb name and grade. The simpler path: render `<ClimbDetailHeader>` + the climb's `frames` summary + sections as SSR fragments _inside_ the page body, and let the drawer hydrate over them on the client.

## What we preserve

- All existing share URLs (`getContextAwareClimbViewUrl`, the share action, `use-climb-actions`) keep producing `…/view/{climb_uuid}` URLs. They now land on the new drawer-over-list surface; the URL contract to external systems (iMessage, Twitter, embedded thumbnails) does not change.
- The activity feed (`ascent-thumbnail.tsx`), new-climb feed (`new-climb-feed-item.tsx`), and drafts drawer (`drafts-drawer.tsx`) keep their `LocaleLink href={…/view/…}` patterns. They navigate the user to the new wrapper which opens the drawer pre-loaded.
- `getBackToListUrl()` in `BoardSeshHeader` and `QueueControlBar` keeps working — `isViewPage` still resolves true on the new route because the pathname still contains `/view/`. Header back button → list URL is unchanged in behavior.
- The numeric → slug `permanentRedirect` in `/view/{climb_uuid}/page.tsx` is preserved.
- The `revalidate-climb` and `climb-redirect` API routes keep using the view URLs.

## What changes for users

- Tapping a climb in the list opens the drawer **and** updates the URL bar to `…/view/{climb_uuid}`. The user can hit the iOS "share" button on the URL bar or the system share sheet and send a working link.
- Loading a share link drops the user directly into the drawer-over-list view, with prev/next available (walks the suggested climbs from the same search context as the list).
- The back button works the way users expect: from a drawer-on-list state, back closes the drawer and returns to the list. From a direct-hit drawer, back returns to the previous site or tab.
- The "full page" climb-view layout (with sidebar, two-column on desktop) disappears. **This is a real visual change on desktop.** Today's view page has a desktop sidebar layout via `ClimbViewActions` + `climb-view-sidebar.tsx`. The drawer is a bottom sheet. On desktop the drawer expands to ~80% viewport height. Confirm with design that this is acceptable; if not, scope a desktop drawer variant (wider, side-anchored) as Phase 3.

## Known regressions

Two intentional regressions on direct hits to `/view/{uuid}` (share-link flow) — both fall out of "the drawer is the first paint, not the list":

- **Climbs list under the drawer is empty on SSR.** The view route passes `initialClimbs=[]` and lets React Query load the list asynchronously after the drawer hydrates. Users only see the list when they close the drawer; before then the empty list is hidden behind the drawer. Crawlers see no list at the view route, but the climb-list rows on `/list` (and the dedicated `ClimbViewSeoFragment`) carry the SEO weight. Acceptable per the pivot's "drawer first, list async" rule.
- **`communityGrade` is no longer SSR-injected into the header.** The old standalone view page fetched `fetchClimbDetailData()` server-side and rendered the community grade in `ClimbDetailHeader`. The drawer's header reads `communityGrade` from a client-side GraphQL call, so direct-hit users briefly see the board's `difficulty` before the community value arrives. Worth restoring with a Suspense-friendly SSR query if community-grade share-links become a load-bearing surface.

## Implementation phases

Each phase should ship behind a small, scoped change and be independently verifiable in dev.

### Phase 1 — Drawer learns to drive the URL

**Goal:** the drawer becomes the source of truth for the URL when open, without removing or changing the view route yet. Verifiable: open the drawer from the list, see `/view/{uuid}` in the URL bar; close, see `/list` again; copy the URL, open in a new tab — lands on today's existing view page (still rendered by `ClimbDetailPageServer`). No regressions for users who don't know about the new behavior.

- Extract a shared hook `useDrawerUrlSync({ open, climbUuid, listUrl, viewUrlForClimb })` in `packages/web/app/components/play-view/use-drawer-url-sync.ts`. Encapsulates `pushState` on open, `replaceState` on climb change, `popstate` listener that closes the drawer, and the "source: list-tap | direct" state encoding.
- Wire the hook into `PlayViewDrawer`. Replace the `#playing` hash trick at `play-view-drawer.tsx:523-539` with the new hook. Make sure `viewOnlyMode` skips the URL sync (we don't want viewers' URLs changing under them).
- Listen for `popstate` and close the drawer if the URL no longer contains `/view/{climb_uuid}` matching the displayed climb. Re-use today's listener — extend, don't replace.
- Verify the existing `/play/{climb_uuid}` PlayViewClient still works (it uses its own `pushState`/`popstate`; the new hook should coexist, not collide). If both fire, decide which one wins on `/play/` (the play view, since the drawer isn't open there).

Files: `packages/web/app/components/play-view/play-view-drawer.tsx`, new `packages/web/app/components/play-view/use-drawer-url-sync.ts`. No backend or schema changes.

### Phase 2 — View route becomes a drawer-open hint

**Goal:** the view route renders the list + drawer-open instead of the full-page detail layout. Verifiable: load `/view/{climb_uuid}` directly, see the climbs list with the drawer pre-opened on the climb. Back button takes you off-site (or to previous tab). Refresh keeps you in the same state.

- Update `packages/web/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/view/[climb_uuid]/page.tsx`:
  - Keep `generateMetadata` unchanged.
  - Keep the numeric → slug `permanentRedirect`.
  - Replace `ClimbDetailPageServer` with the same SSR-list-page flow used in `/list/page.tsx` (call `cachedSearchClimbs`, derive `searchParamsObject`, etc.). Extract the list-page server logic into a shared helper (`fetchListPageData(parsedParams, searchParams)`) so the two pages don't duplicate it.
  - Render `<BoardPageClimbsList initialClimbs={…} initialOpenClimbUuid={climb_uuid} initialOpenClimb={climb} />`.
- Update `packages/web/app/b/[board_slug]/[angle]/view/[climb_uuid]/page.tsx` the same way.
- Update `<BoardPageClimbsList>` to accept `initialOpenClimbUuid` / `initialOpenClimb`. On first client mount, if the queue context doesn't already have a current climb (or if it differs), call `dispatchOpenPlayDrawer(initialOpenClimb)`. Race condition note: the queue context hydrates async; the dispatch needs to happen _after_ the context is ready, or the drawer will open with a stale climb. Easiest: pass the climb directly to `dispatchOpenPlayDrawer` as we already do post-pivot.
- Verify the SSR'd HTML on `/view/{climb_uuid}` still contains the climb's name, grade, setter near the top. This is the SEO test — view-source on the page, grep for the climb name, confirm it's there before the search-results JSON blob.

Files: both `view/[climb_uuid]/page.tsx` files, `board-page-climbs-list.tsx`, possibly a new `app/lib/list-page-server.ts` helper for the shared list-fetching logic. No deletions yet — keep the old components around until Phase 4 confirms nothing else references them.

### Phase 3 — In-drawer URL sync for prev/next/swipe

**Goal:** swiping in the drawer updates the URL bar via `replaceState`. Browser back from `/view/{b_uuid}` after swiping from `/view/{a_uuid}` takes the user back to the list, not back through every swipe.

- In `useDrawerUrlSync`, when the climb changes (effect on `displayedClimbUuid`), call `history.replaceState` with the new view URL.
- Make sure the URL helper used here matches `constructClimbViewUrlWithSlugs` (slug form) when board names are available, and falls back to numeric otherwise.
- Confirm that the existing `Climb List Row Clicked` analytics event continues to fire correctly when row-tap also pushes a URL. No double-fire.
- Add a small `Climb View URL Sync` analytics event (or extend `Queue Navigation` properties) so we can measure how often users actually use the shareable URL vs how often it just decorates.

Files: `use-drawer-url-sync.ts`, possibly `packages/web/app/lib/analytics.ts` for the new event signature.

### Phase 4 — Delete the dead components

**Goal:** remove the now-unused full-page climb detail components. CI / typecheck verifies nothing else imports them.

- Grep one more time for callers of: `ClimbDetailPageServer`, `ClimbDetailInfoShellClient`, `ClimbViewActions`, `ClimbViewSidebar`, `climb-view-actions.module.css`, `climb-view.module.css`.
- Delete the files in `packages/web/app/components/climb-detail/climb-detail-page.server.tsx`, `climb-detail-info-shell.client.tsx`, the `packages/web/app/components/climb-view/` directory (verify `climb-view-sidebar.tsx` truly has no other caller — it currently lives in a separate folder, suggesting it may be referenced from elsewhere).
- Delete `packages/web/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/view/[climb_uuid]/climb-view.module.css`.
- Delete the test at `packages/web/app/b/[board_slug]/[angle]/view/[climb_uuid]/__tests__/page-metadata.test.tsx` only if it tests `ClimbDetailPageServer` rendering; if it tests metadata, keep and adjust.
- Run `vp run check:i18n:orphans` — the `climbs:metadata.view.imageAlt` and any newly-orphaned keys must be cleaned up or kept with a `i18n-keep` annotation.

Files: deletions only, plus updated imports in any test files that referenced the removed components.

### Phase 5 — QA + dev-server validation

Standard project flow per CLAUDE.md:

- Write `.boardsesh/qa-notes.md` with the QA plan before starting `vp run dev`.
- Cover the matrix:
  - **Solo, list → tap row → drawer opens.** URL changes to `/view/{uuid}`. Copy URL, open in new private window, drawer pre-opens on the right climb.
  - **Solo, list → tap → swipe next.** URL updates via `replaceState`; address bar reflects current climb. Back button takes you to `/list`, not through the swipes.
  - **Solo, list → tap → close button.** URL returns to `/list?search=…` with search params preserved.
  - **Solo, list → tap → browser back.** Drawer closes; URL back to `/list`.
  - **Direct hit on `/view/{uuid}` (incognito).** SSR HTML contains climb name + grade. Drawer animates open. Back button takes user off-site.
  - **Direct hit → close.** Pushes `/list` forward (since there's nothing to pop). Back from list returns to off-site.
  - **Direct hit → swipe next.** URL `replaceState` to next climb. Close returns to `/list`.
  - **Party session, list → tap row → drawer opens.** Drawer shows the tapped climb locally. URL changes to `/view/{tapped_uuid}` for the _local_ user; the URL change does _not_ broadcast (it's per-client browser state). Activating that climb (via setCurrentClimb) does broadcast — sessions are always-live.
  - **Party session, direct hit on `/view/{uuid}` while the shared climb is different.** Drawer pre-opens on the share-link climb locally. The bar shows the shared current climb. Closing the drawer returns the local user to `/list`.
  - **Share button on the drawer.** The URL it shares matches the URL in the address bar.
  - **OG image.** Crawl `curl /view/{uuid}` and check `og:image` resolves to the board render of the right climb.
  - **iOS/Android system back gesture.** Same behavior as browser back button.
  - **`b/{slug}/{angle}/view/{uuid}` alias.** Direct hit → same drawer-on-list flow. URL stays in the short form (don't accidentally rewrite to the long form via `replaceState`).
  - **Onboarding tour `climb-list` step.** Row tap during the tour still skips the drawer and signals the tour (per `climbs-list.tsx:425-429`). The URL must _not_ change during the tour skip.
- Run `vp check` and `vp run typecheck` before pushing.
- Open a PR with screen recordings of the URL-sync behavior on solo + party.

## Risks / things to watch

- **Drawer SSR.** MUI's `SwipeableDrawer` uses a Portal by default. Portals only render client-side. For the SSR'd first-render content to contain the climb name (the SEO requirement), the page may need to render the climb detail content inline _and_ the drawer hydrates over it. The fallback plan documented above (render `ClimbDetailHeader` + sections as a normal SSR fragment under the drawer, drawer animates open on hydrate) is the safe path. Confirm in Phase 2 whether `disablePortal` on the play drawer produces shippable SSR output.
- **`history.state` shape collisions.** The PlayViewClient on `/play/` and the drawer's URL sync both write to history. They run on different routes today, so they don't overlap. But if a user navigates from `/list` → drawer open (`/view/{a}`) → router.push to `/play/{a}`, the drawer's `popstate` listener and the PlayViewClient's `popstate` listener may both fire. Define one shared state shape (`{ source: 'drawer' | 'play', climbUuid: string }`) and have each handler only react to its own.
- **Search-param preservation.** `getBackToListUrl()` already preserves search params (see `header.tsx:91-96`). The drawer's URL sync must do the same — copying the current `?search=…` onto the pushed `/view/{uuid}` URL. The hook needs `useSearchParams` so it can read them at push time, not at hook init.
- **Hard-refresh on `/view/{uuid}` with a search filter applied to the list.** Currently the view page has no notion of the list's search params. After the pivot, the underlying list should respect any `?search=…` carried on the URL. The wrapper page already calls the same `parsedRouteSearchParamsToSearchParams` the list page does — confirm parity.
- **`/b/{slug}/{angle}/view/{climb_uuid}` short route.** This page doesn't have the deep `[layout_id]/[size_id]/[set_ids]` segments visible in the URL; its `boardToRouteParams` derivation runs server-side. Make sure the drawer's URL sync respects the short slug form when the user is on this route (the sync re-pushes the short URL, not the long one).
- **Existing tests.** `packages/web/app/b/[board_slug]/[angle]/view/[climb_uuid]/__tests__/page-metadata.test.tsx`, `packages/web/app/components/climb-detail/__tests__/build-climb-detail-sections.test.tsx`, and the row-click test in `climbs-list.tsx` may all need updates. Audit and update in Phase 2/4.

## Non-goals / explicit nos

- Do **not** introduce parallel/intercepting routes (`@modal/(.)view/`). The single-route plan is simpler and fits the existing layout tree.
- Do **not** rename the `/view/` URL path. All external links and share URLs continue to work.
- Do **not** change the OG image generation or `createPageMetadata` shape. Same metadata flows through.
- Do **not** redesign the climb detail content. The drawer composes the same pieces as today; layout work is out of scope.
- Do **not** ship a desktop-side-anchored drawer variant in this PR. If desktop UX regresses, file as follow-up.
- Do **not** delete the `/play/` route. It still serves its own purpose (in-session full-screen play). It just happens to also use `pushState`-based URL sync; the shared hook is the only overlap.

## Code pointers (verified, may drift)

- View page (long form): `packages/web/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/view/[climb_uuid]/page.tsx`
- View page (short form): `packages/web/app/b/[board_slug]/[angle]/view/[climb_uuid]/page.tsx`
- Full-page detail renderer (to delete): `packages/web/app/components/climb-detail/climb-detail-page.server.tsx`
- Full-page detail client (to delete): `packages/web/app/components/climb-detail/climb-detail-info-shell.client.tsx`
- Full-page actions (to delete): `packages/web/app/components/climb-view/climb-view-actions.tsx`
- List page (template for the new view page): `packages/web/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/list/page.tsx`
- List page client wrapper: `packages/web/app/components/board-page/board-page-climbs-list.tsx`
- PlayViewDrawer (URL sync target): `packages/web/app/components/play-view/play-view-drawer.tsx`
- Existing hash-based back implementation (to replace): `play-view-drawer.tsx:523-539`
- Drawer open event helper: `packages/web/app/components/queue-control/play-drawer-event.ts`
- Layout that hosts both routes + the drawer: `packages/web/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/layout.tsx`
- Existing PlayView pushState pattern to lift into the shared hook: `packages/web/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/play/[climb_uuid]/play-view-client.tsx` (lines 49-66, 85-105)
- URL helpers (kept): `packages/web/app/lib/url-utils.ts` — `constructClimbViewUrl`, `constructClimbViewUrlWithSlugs`, `tryConstructSlugViewUrl`, `getContextAwareClimbViewUrl`
- Header back-button logic (works without change): `packages/web/app/components/board-page/header.tsx:55-98`
- Activity-feed thumbnail link target: `packages/web/app/components/activity-feed/ascent-thumbnail.tsx`
- Share action: `packages/web/app/components/climb-actions/actions/share-action.tsx`
- Drafts deep-link: `packages/web/app/components/create-climb/drafts-drawer.tsx`
- Numeric → slug redirect API: `packages/web/app/api/internal/climb-redirect/route.ts`
- Revalidation API: `packages/web/app/api/internal/revalidate-climb/route.ts`

## Open questions (remaining)

Not blockers. Decide before merging Phase 2.

1. **Desktop layout.** The bottom-sheet drawer on desktop currently feels mobile-shaped. Acceptable as v1, or do we need a wider/side-anchored desktop variant? Recommend ship v1 as-is, file desktop variant as follow-up.
2. **Soft-navigation vs hard-navigation from external links.** The activity feed uses `LocaleLink` (Next.js client-side soft-nav). After the pivot, clicking an ascent thumbnail soft-navigates to `/view/{uuid}` and the page re-renders the list + drawer. Is that fast enough, or do we need to intercept the click and just dispatch `dispatchOpenPlayDrawer` directly when already on the same `[angle]/` subtree? Recommend: ship soft-nav, optimize later if Vercel Analytics shows it's slow.
3. **Drawer SSR strategy.** Render `ClimbDetailHeader` + sections inline + let the drawer hydrate over them, OR render the drawer with `disablePortal` so its SSR output is in the page tree? Recommend the former — simpler, decouples SEO from MUI's portal behavior.
4. **`h1` semantics.** The drawer currently uses `<Typography variant="h2">` inside `ClimbDetailHeader`. The view page is an indexable surface; SEO wants exactly one `h1` per page. Either bump the header to `h1` when rendered on the view route, or add a visually-hidden `<h1>{climbName}</h1>` on the view page that the drawer composes around. Recommend the visually-hidden h1 — keeps the drawer visually identical wherever it opens.
