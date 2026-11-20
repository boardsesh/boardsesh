# Web architecture: the SSR front door

`packages/web` serves marketing, public climb/list/profile/playlist pages, account,
and gym surfaces. Interactive climbing, queue control, tick logging, authoring,
and Bluetooth live in the Expo app. The browser app's hosted origin is resolved
by `packages/web/app/lib/app-origin.ts` and the redirects in `next.config.mjs`.
Local Expo web can use the gated `/app` development bridge; do not assume hosted
handoffs need that prefix.

## App handoffs and route compatibility

`buildAppHandoffUrl` creates an app-origin URL with the same pathname after
stripping every supported website locale prefix. Query strings and fragments
are intentionally dropped. The app chooses its own locale; it has no translated
`/es/`, `/fr/`, `/de/`, or `/it/` route tree. `buildAppCreateClimbUrl` is the
separate authoring handoff that carries explicit board geometry and remix/edit
parameters.

`packages/web/next.config.mjs` owns current compatibility redirects, expands
localized variants, and orders board-specific rules before catch-alls. Preserve
board identity when a route needs it: redirecting every old board list to bare
`/climbs` would select the app's stored board instead of the linked wall.
Cross-origin app redirects retain their configured temporary/permanent behavior.

The website's retained authentication and bridge endpoints still serve released
clients. Do not remove a route because the old web climbing UI no longer imports
it. Inspect native/browser auth clients and the authentication migration contract
before changing session, provider, native-callback, or WebSocket token endpoints.
The removed Aurora proxy URLs are not a compatibility path; manufacturer writes
and sync run through the backend.

### Hardware-pinned URLs

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

## Public rendering and cache boundaries

Public climb and list pages render useful content and crawlable links on the
server. Climb pages include their heading, board image, facts, related links, and
app handoff. Board image URLs use the backend renderer rather than mounting a
native/browser rendering engine; see [web board rendering](../rendering/wasm-worker-rendering.md).

These shared-cache pages render anonymously. The CDN policy does not separate
responses by session cookie, so server-rendered personal logbook records or
viewer-specific badges would expose one user's content to later visitors.
Personalization requires an explicitly private response or a separate client
island with the correct account-scoped authorization.

`resolveListPageIndexation` in `app/lib/seo/list-page-robots.ts` owns both list
route trees. Pages contain 50 climbs. Pages 1–10 are indexable; published next
links stop at 10. Pages 11–20 render as `noindex, follow`; greater page numbers
404 before the data query. Page 1 canonicalizes to the clean URL, while other
unfiltered pagination pages retain their page canonical. Filter/sort variants
are `noindex, follow` and canonicalize to the clean base.

A hidden/private board has no public canonical inferred from its catalog tuple.
Public catalog aliases retain their canonical configuration route and their
explicit crawler-following policy; physical-board `/b/` paths remain valid human
and app links. Spray-wall routes need their own visibility and canonical handling
because they are not interchangeable with a public catalog tuple.

## Root chrome and live presence

`app/components/providers/site-chrome.tsx` supplies the marketing header/footer,
consent banner, and three retained bridges: StatsFilterBridgeProvider,
ProfileHeaderShareProvider, and PlaylistsAdapterProvider. The playlist adapter is
required by shared playlist hooks. The root does not mount the retired queue,
Bluetooth, session WebSocket, or persistent climbing bar.

Kiosk and embed presence are explicit exceptions to static public content.
`app/components/kiosk/presence/kiosk-presence-hub.tsx` shares one live connection
among distinct boards and distinguishes anonymous public displays from
viewer-scoped authenticated previews. The anonymous public hub connects without
calling `/api/internal/ws-auth`; the old migration task claiming that this was
still unimplemented is obsolete. Keep spray-wall/public-visibility admission and
subscribe/backfill ordering intact when changing these clients.

The ambient Capacitor types and session-cookie compatibility code must be judged
by their remaining callers rather than the removed climbing provider tree.
Current import-graph and removed-surface tests under `app/__tests__/` protect
those boundaries.

## Translation payloads on public pages

Next sends the namespaces needed by the root chrome and each route for hydration.
`loadServerResources` additionally excludes the top-level `mobile` tree from
`common`, `climbs` and `feed`: those branches belong to app-only screens and have
no consumers on the surviving web surfaces. The projection creates fresh objects;
shared catalogs and `getServerTranslation` keep their full resources.

This is an explicit three-namespace rule. Web board-management forms still use
`boards.mobile`, shared workout summaries use `session.mobile`, and connected
account tools use `aurora.mobile`; those remain available. Browser lazy loading,
server-rendered copy and per-request locale isolation are unchanged. The resource
tests compare every retained key in every locale and check compressed payloads.
They also check web and shared copy-helper references against the projected
catalogs, including templates that could enter an omitted branch.

## Search discovery

`/sitemap.xml` is a sitemap index. `app/lib/seo/sitemap/shard-registry.ts` registers
the static/public-entity shards and paged climb/setter sources. Include public,
canonical, indexable URLs only; preserve real content timestamps and shard
failure/size limits. See [sitemap operations](sitemap.md) and
[share metadata](og-smartlinks-roadmap.md).

## Historical rollback artifact

The classic-web branch/tag was cut on August 14, 2026 with retention expiring
November 12, 2026. That old artifact and its whole-repository restore procedure
are not a current recovery guarantee. A restore of that tree also rolls back
unrelated mobile, backend, shared-package, and workflow source while leaving the
production database unchanged. It requires an explicit compatibility review and
fresh qualification before use; the expired handover is not authority to force
retag, delete remote refs, or publish a restore.

Use [production deployment](../operations/production-deploy.md) and [branch deployment](../operations/branch-deploys.md)
for the maintained deployment controls. This documentation cleanup does not alter
remote branches, tags, deployed services, or data.
