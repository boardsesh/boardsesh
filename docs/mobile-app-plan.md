# Boardsesh Mobile App Distribution Plan (Capacitor)

## Executive Summary

This document describes how Boardsesh ships as native iOS and Android apps using **Capacitor**, and the parallel work to make the app fully usable offline. v5.0 launched the Capacitor shell pointing at the hosted Next.js app at `https://boardsesh.com` and added a read-only embedded SQLite climb database (Milestone 1.5). v7.0 commits to an **offline-first** direction: the Capacitor app ships a **bundled Next.js static export** (`output: 'export'`) so the app launches and runs without a network round-trip, backed by a **local SQLite cache for both refdata and user-specific data** with a write queue that syncs to the server when online. The web at `boardsesh.com` continues to run Next.js as a standalone SSR build — no framework migration. Hosting consolidates onto **Railway** (Postgres, backend, web), and the in-progress REST → GraphQL migration in `packages/backend` continues per `CLAUDE.md` rules.

**Pinned user story.** A user opens Boardsesh in airplane mode at the gym. They can launch the app, browse and search climbs for their board, build a queue, connect via BLE, **send climbs to the board (LEDs light up)**, and tick the ones they sent. Real-time-only features (party mode, comments, others' profiles) gracefully show "needs network." When the user reconnects, queued ticks and edits sync to the server transparently. This is the 80% offline target.

**Why now:** the iOS native shell already drives BLE, LiveActivity, and (in flight, PR #1509) a native tab bar with per-tab WKWebViews. The remaining cold-start latency, hosting cost, and basement-gym connectivity pain are addressed by bundling the app and caching data locally — without a framework migration. Each phase is independently shippable.

**Key advantages preserved:** zero UI rewrite. The same Next.js + MUI codebase produces both the web SSR build (boardsesh.com) and the static export bundled into Capacitor. Native plugins continue to bridge BLE, push, haptics, LiveActivity.

**v7.0 supersedes v6.0** (TanStack Start migration), which is preserved in the alternatives section as considered-and-deferred.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Why Capacitor Over React Native](#why-capacitor-over-react-native)
3. [Architectural Pivot to Offline-First (Next.js Dual-Build + Local Cache)](#architectural-pivot-to-offline-first-nextjs-dual-build--local-cache)
4. [Why Bundling Next.js Now Works](#why-bundling-nextjs-now-works)
5. [Hosting Migration: Vercel + Neon → Railway](#hosting-migration-vercel--neon--railway)
6. [REST → GraphQL Completion](#rest--graphql-completion)
7. [Analytics & Observability](#analytics--observability)
8. [Package Structure](#package-structure)
9. [Capacitor Bridge Injection Strategy](#capacitor-bridge-injection-strategy)
10. [Web App Adaptations](#web-app-adaptations)
11. [Authentication in WebView](#authentication-in-webview)
12. [Implementation Milestones](#implementation-milestones)
13. [Bluetooth Strategy](#bluetooth-strategy)
14. [Development Workflow](#development-workflow)
15. [App Store Distribution](#app-store-distribution)
16. [Risk Assessment](#risk-assessment)
17. [Success Criteria](#success-criteria)
18. [Considered Alternatives](#considered-alternatives)

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│                Native Shell                  │
│  ┌───────────────────────────────────────┐   │
│  │          Capacitor WebView            │   │
│  │                                       │   │
│  │   loads https://boardsesh.com         │   │
│  │   (existing Next.js app, unchanged)   │   │
│  │                                       │   │
│  │   ┌─────────────────────────────┐     │   │
│  │   │  Capacitor JS Bridge        │     │   │
│  │   │  - BLE plugin               │     │   │
│  │   │  - Geolocation              │     │   │
│  │   │  - Browser (ext. URLs)      │     │   │
│  │   │  - StatusBar                 │     │   │
│  │   │  - Keyboard                  │     │   │
│  │   │  - App (deep links)          │     │   │
│  │   │  - KeepAwake                 │     │   │
│  │   │  - PushNotifications         │     │   │
│  │   │  - Haptics                   │     │   │
│  │   └─────────────────────────────┘     │   │
│  └───────────────────────────────────────┘   │
│                                              │
│  Native Layer (Swift / Kotlin)               │
│  - BLE Central Manager                       │
│  - Push notification handling                │
│  - Deep link routing                         │
│  - Status bar / safe area                    │
└─────────────────────────────────────────────┘
```

### Hosted Mode

The app operates in **hosted mode**: the Capacitor WebView loads the production URL (`https://boardsesh.com`). This means:

- **Instant updates:** Web deployments to Vercel automatically update the app for all users — no app store review needed for UI/logic changes.
- **Server-side rendering works:** Next.js SSR, API routes, and server components function normally.
- **Requires internet:** The app needs a network connection. Offline support is handled by existing IndexedDB caching and a future service worker.
- **Native plugins available:** Capacitor's JS bridge gives the web code access to native BLE, push notifications, haptics, etc. when running inside the native shell.

---

## Why Capacitor Over React Native

| Factor             | Capacitor                               | React Native                           |
| ------------------ | --------------------------------------- | -------------------------------------- |
| UI rewrite needed  | **None** — existing web app runs as-is  | Full rewrite of every screen/component |
| Time to MVP        | **2-4 weeks**                           | 4-6 months                             |
| Code reuse         | **~95%** — same codebase                | ~30% (shared-logic, types, schemas)    |
| MUI components     | **Keep all**                            | Replace with Tamagui/NativeBase        |
| SSR / API routes   | **Work normally** (hosted mode)         | Need separate API client layer         |
| Update speed       | **Instant** via web deploy              | App store review (1-7 days)            |
| BLE support        | Via `@capacitor-community/bluetooth-le` | Via `react-native-ble-plx`             |
| Native feel        | Good with proper meta tags/CSS          | Excellent                              |
| App store presence | Yes                                     | Yes                                    |
| Bundle size        | Small shell (~5MB) + web loads remotely | Larger (~30-50MB)                      |
| Maintenance burden | **Low** — one codebase                  | High — two codebases diverge over time |

**Bottom line:** The web app already works well on mobile browsers. The primary reason for native apps is BLE on iOS (Safari doesn't support Web Bluetooth) and app store discoverability. Capacitor delivers both without rewriting the app.

---

## Architectural Pivot to Offline-First (Next.js Dual-Build + Local Cache)

**v7.0 change.** The Capacitor app stops loading `https://boardsesh.com` over the network and instead ships a **bundled Next.js static export**. The same `packages/web` codebase produces two build outputs:

- **Standalone build** (`next build`) → deployed to Railway, serves `boardsesh.com` for the web. SSR for SEO surfaces (homepage, profile, climb detail, playlist) preserved as-is.
- **Static export build** (`next build` with `output: 'export'`) → produces a static `out/` directory that is bundled into the Capacitor app. App launches locally with no network round-trip.

The data layer becomes **local-first** for the Capacitor app: a query router backed by SQLite serves most reads from local data, falls through to remote GraphQL on miss, and queues writes for later sync when offline. Web users continue to read from the server directly; the local cache only exists inside Capacitor.

No web framework migration. No new package. The existing Next.js + MUI codebase keeps working everywhere; the export build adds a packaging target.

### What "offline-first" means in scope

The user is the source of truth for what works offline:

| Surface | Offline behavior |
|---------|------------------|
| App launch | Always works (bundled static assets) |
| Climb search + browse | Local SQLite refdata (per-board ODR / Asset Pack from v5.0 M1.5) |
| Climb detail | Local SQLite refdata |
| Build/edit queue | Local IndexedDB (existing pattern) |
| BLE connect + send | Native BLE adapter — already independent of network |
| Tick a climb | Optimistic local write + queued mutation, syncs on reconnect |
| Own profile, ticks, playlists | Local cache, populated by background sync when online |
| Real-time party mode | Requires network — gracefully degrades |
| Comments, follows, notifications | Requires network — gracefully degrades |
| Others' profiles | Requires network — gracefully degrades |

### The query router

TanStack Query's `queryFn` calls a router that decides local vs. remote per query name:

```typescript
// packages/web/app/lib/data/query-router.ts
const ROUTES: Record<string, RouteSpec> = {
  'climbs.search':    { local: searchClimbsSqlite,   remote: SEARCH_CLIMBS_GQL,   prefer: 'local' },
  'climbs.byUuid':    { local: getClimbSqlite,       remote: GET_CLIMB_GQL,       prefer: 'local' },
  'ticks.forUser':    { local: getTicksSqlite,       remote: GET_TICKS_GQL,       prefer: 'cache-first' },
  'playlists.forUser':{ local: getPlaylistsSqlite,   remote: GET_PLAYLISTS_GQL,   prefer: 'cache-first' },
  'queue.partyState': {                              remote: PARTY_STATE_GQL,     prefer: 'remote-only' }, // real-time
};

export async function boardseshQuery(name: string, args: unknown) {
  const route = ROUTES[name];
  if (!isCapacitor()) return route.remote!(args); // web: server-only
  if (route.prefer === 'local') return route.local!(args);
  if (route.prefer === 'cache-first') return cacheFirst(route, args);
  return route.remote!(args);
}
```

Mutations follow a similar pattern with a write queue:

```typescript
async function boardseshMutate(name: string, args: unknown) {
  if (await isOnline()) {
    try { return await callServerMutation(name, args); }
    catch (e) { if (isNetworkError(e)) await enqueueMutation(name, args); else throw e; }
  } else {
    await enqueueMutation(name, args);
  }
}
```

### Single codebase, two builds

```
                  ┌────────────────────────────────────┐
                  │          packages/web              │
                  │   (Next.js App Router + MUI;       │
                  │    in-app routes refactored to     │
                  │    client-side fetch via the       │
                  │    query router)                   │
                  └─────────────┬──────────────────────┘
                                │
                ┌───────────────┴────────────────┐
                │                                │
       next build (standalone)        next build (output: 'export')
                │                                │
                ▼                                ▼
    ┌────────────────────────┐     ┌───────────────────────────┐
    │  Railway (Node)        │     │  Static out/ directory    │
    │  boardsesh.com         │     │  bundled into Capacitor   │
    │  SSR + dynamic routes  │     │  app via cap sync         │
    │  (SEO, OG images)      │     │  Loads from               │
    │                        │     │  capacitor://localhost    │
    └────────────────────────┘     └───────────────────────────┘
```

### Mobile shell trajectory

Unchanged from v5.0/v6.0:

1. **Today:** single WKWebView at `https://boardsesh.com`, with native BLE / LiveActivity / tab-bar overlays.
2. **After PR #1509 lands:** native `NativeTabBarView` drives the WebView via JS events.
3. **Phase 2 (this plan):** the WebView's URL flips from `https://boardsesh.com` to `capacitor://localhost`, served from the bundled `out/` directory. PR #1509's tab bar continues to work; tab switches are now instant since they don't need network. Per-tab WKWebView remains a future option but isn't required by Path A.

---

## Why Bundling Next.js Now Works

The v5.0 doc analysed bundling Next.js into Capacitor (via `output: 'export'`) and rejected it because the Boardsesh app was deeply server-dependent: 33+ API routes, server components with direct DB access, NextAuth, Aurora API proxies, middleware.

**v7.0 reframes the conclusion.** That work has been happening anyway:

- **REST → GraphQL migration is in progress** per `CLAUDE.md` rules — `packages/backend` becomes the home for data operations, eliminating the API-route dependency from the export build.
- **Server components doing DB reads** can be converted to client components fetching via TanStack Query → the query router → either local SQLite or remote GraphQL. The conversion is required for the local-first cache anyway.
- **NextAuth** can keep working in the standalone web build (cookies served by Railway-hosted Next.js); inside Capacitor the WebView loads bundled HTML from `capacitor://localhost`, and authenticates against the backend's Auth.js endpoints (or NextAuth-on-Railway, since the cookie shape is the same JWT). No `cookies()` or `headers()` from `next/headers` in the export build's server components.
- **Aurora API proxies** are part of the GraphQL completion (Phase 0b) — they become backend GraphQL mutations, not Next.js API routes.
- **Middleware** for board name validation moves to client-side route guards (or to `generateStaticParams` enumeration of valid board configs).

The export build's known caveats are manageable for Boardsesh:

- **Dynamic routes need `generateStaticParams` or client-side rendering.** Tens of thousands of climbs, profiles, and playlists can't be pre-rendered. The pattern: dynamic per-item routes (`/[board]/.../view/[uuid]`, `/profile/[id]`, `/play/[uuid]`) are emitted as client-rendered shells. The page reads its param from the URL on mount and fetches via the query router. SPA fallback in Capacitor's WKWebView ensures unknown URLs route to the shell.
- **`next/image`** uses a custom loader for the export build (or `<img>` with manual `srcset` for the limited cases where the app needs responsive images).
- **`generateMetadata`** runs at build time only. Fine for SEO routes (boardsesh.com rebuilds on deploy). Inside Capacitor, share-cards don't apply, so client-side metadata updates suffice.
- **No middleware.** Validation moves to route loaders / client guards. CDN cache headers come from Railway / Cloudflare in front of the standalone build, not from the export.
- **No `cookies()`, `headers()`, server actions, ISR.** Already removed from in-app routes during the GraphQL migration.

The remaining cost is **converting in-app server components to client components**, which is folded into Phase 1 below. SEO surfaces (homepage, profile public view, climb public view, playlist public view) keep server components — those routes are only built into the standalone build, not the export.

---

## Hosting Migration: Vercel + Neon → Railway

The web and database move off Vercel and Neon onto **Railway** in Phase 0a.

### Target topology

| Component | Today | After migration |
|-----------|-------|------------------|
| Postgres | Neon (serverless WebSocket pool) | Railway Postgres (long-lived) |
| Backend (`packages/backend` — graphql-ws + Hono + Redis pub/sub) | Self-hosted / mixed | Railway |
| Web (`packages/web` standalone Next.js) | Vercel | Railway, co-located with backend + DB |
| Capacitor bundle (`packages/web` static export) | n/a (today: hosted URL) | Bundled assets shipped inside the app |
| CDN / edge cache | Vercel | Cloudflare in front of Railway origin (cache headers from route handlers) |

Single vendor, single region, lowest DB latency.

### Cutover sequence

Phase 0a (see [Implementation Milestones](#implementation-milestones)). Order matters:

1. **Database first.** Stand up Railway Postgres + PostGIS. Apply Drizzle migrations. Bulk-copy from Neon (logical replication or `pg_dump | pg_restore` during a brief maintenance window). Verify PostGIS-dependent queries (heatmap, climb stats spatial filters) return identical results.
2. **Switch the DB client.** `packages/db/src/client/` switches the production path from `drizzle-orm/neon-serverless` to `drizzle-orm/postgres-js`. Local dev already uses `postgres-js`, so the schema is proven against that driver. **No schema changes.**
3. **Backend onto Railway.** Redeploy `packages/backend` (graphql-ws + Redis) onto Railway. Update env vars. Verify subscriptions reconnect cleanly.
4. **Next.js standalone onto Railway.** `next build` standalone deploys to Railway behind a staging hostname. Validate against current Vercel deploy. Once green, flip DNS for `boardsesh.com`.
5. **Vercel project retained** for preview deploys (optional) or shut down entirely.

### Risks specific to this move

- **Connection pool sizing.** Neon's serverless pool auto-scales; Railway is a fixed-size Postgres instance. Validate pool max under load (especially during sync jobs and party-session bursts).
- **PostGIS feature parity.** Confirm the Railway PostgreSQL image includes PostGIS. Run `\dx` and the heatmap/spatial test suite against it before flipping production traffic.
- **Cron / scheduled jobs.** Aurora sync currently runs on a schedule somewhere — confirm the runner location (likely already in `packages/aurora-sync`) and re-point its `DATABASE_URL`. Vercel Cron (if used) needs replacing with Railway-native scheduling or a GitHub Action.
- **Edge cache behavior.** Vercel's automatic asset caching disappears. Set explicit `Cache-Control` on routes and front the origin with Cloudflare.

---

## REST → GraphQL Completion

Per `CLAUDE.md`: *"We are slowly moving away from running rest-apis and backend operations in the next.js service, instead `packages/backend` should implement all backends, ideally using graphql."* Phase 0b finishes that migration. The static export build can't include API routes anyway, so anything still in `/api/*` has to move out before Phase 1.

### Inventory and destinations

The current Next.js app exposes ~42 API routes under `packages/web/app/api/`. Destination for v7.0:

| Group | Count (approx) | Destination |
|-------|---------------:|-------------|
| `/api/internal/*` (data ops, search, sync, ws-auth) | 18 | **GraphQL queries/mutations** in `packages/backend`. Tiny exceptions (e.g. `ws-auth` returning a token) stay as Hono routes. |
| `/api/v1/[board]/*` (public data, grades, slugs, heatmap, climb stats) | 14 | **GraphQL** with the same shape exposed via the GraphQL schema. Preserve URL shape only if external consumers depend on it. |
| `/api/v1/[board]/proxy/*` (login, saveAscent, saveClimb, getLogbook, user-sync) | 4 | **GraphQL mutations** that wrap Aurora calls server-side. Aurora credentials stay in `packages/web` env (where NextAuth runs) or move to backend env if Auth.js migration is later pursued. |
| `/api/auth/[...nextauth]`, `register`, `verify-email`, `resend-verification`, `providers-config`, `native/callback` | 6 | **Stay in `packages/web` (standalone build)** for v7.0. NextAuth keeps working as-is for the web; the bundled Capacitor app makes cross-origin auth requests to `https://boardsesh.com/api/auth/*`. Migrating these to backend Hono is optional future work. |
| `/api/og/*` (4 dynamic image routes) | 4 | **Hono in backend** with `satori` + `@resvg/resvg-js`. **Same URL shape preserved** so existing share cards on Discord/Twitter don't invalidate. (These can't live in the export build, and they're SEO-only — they don't need to work inside the Capacitor bundle at all.) |
| Webhooks (any external POST receivers) | TBD | **Hono in backend.** |

### Migration discipline

- **GraphQL is the default destination.** A new HTTP route is justified only when GraphQL genuinely can't express the operation: redirect responses (OAuth), binary responses (OG images), incoming webhooks, or browser endpoints that need to be hit before JS loads.
- **Shim during overlap.** While Phase 0b runs, the standalone Next.js build keeps thin proxy shims at the old URLs that forward to the backend. The export build (Phase 1) cannot ship these shims and must use the GraphQL endpoints directly.
- **Sitemap and robots.txt** — stay as Next.js route handlers in the standalone build. Not needed in the export build (Capacitor doesn't serve crawlers).

---

## Analytics & Observability

v7.0 consolidates analytics on **PostHog** and keeps **Sentry** for errors.

### PostHog

Replaces any current `vercel/analytics` or `gtag` usage.

- **Client side** (`posthog-js`) initialized in the Next.js root layout — runs in browsers (standalone build) and inside the Capacitor WebView (export build, in WKWebView and Android WebView). Autocapture for page views, button clicks, form submits.
- **Server side** (`posthog-node`) initialized in `packages/backend` for events that originate server-side (logins, sync runs, error rates, GraphQL operation timings).
- **Identification:** user identify on auth success (both client and server), with anonymous → identified merge. Match the existing user identifier (`user.id` from NextAuth / Auth.js).
- **Build-time guard:** stub PostHog during `next build` (both standalone and export) so SSR / static-generation doesn't fire events.
- **Native shell:** the iOS / Android Capacitor processes can post a thin `app_open` event with platform / shell version via the PostHog Capacitor plugin (or directly via the JS SDK once the WebView is up — whichever is simpler).

### Sentry

Already in JS today; v7.0 keeps and extends it.

- **Next.js Sentry integration** — covers SSR errors (standalone build), client-side React errors, and the export build's client errors. Same DSN as today.
- **GraphQL backend** — Sentry instrumentation for unhandled errors in resolvers and ws lifecycle.
- **Native iOS / Android Sentry SDKs** — already scheduled in M2 for crashes outside the WebView (BLE plugin crashes, native code crashes, WebView process kills). Same DSN with `platform: ios | android` tag.
- **Source maps** uploaded on every deploy (Next.js standalone + export bundle + native dSYMs / ProGuard).

### What gets tracked where

| Signal | PostHog | Sentry |
|--------|---------|--------|
| Page views, screen transitions, feature usage | ✓ | — |
| Auth events (login, logout, signup) | ✓ | — |
| BLE connect / send / disconnect | ✓ (event with platform tag) | ✓ on errors |
| Party session join / leave | ✓ | ✓ on errors |
| GraphQL operation latency | ✓ (sample) | ✓ on errors only |
| Unhandled JS errors | — | ✓ |
| WebView process kills, native crashes | — | ✓ (native SDK) |

---

## Embedded Climb Database (SQLite)

### Motivation

Embedding a local copy of the climb database solves three critical problems simultaneously:

1. **App Store approval:** The app has genuine native value beyond a WebView — a searchable offline climb database with BLE board control. This is clearly not "just a web wrapper."
2. **Offline functionality:** Users can browse and search climbs, build a queue, and send climbs to their board via BLE — all without internet. Only social features (comments, follows, party mode) require connectivity.
3. **Performance:** Climb search queries hit a local SQLite database instead of making network requests. No latency, no loading spinners for search results.

### Architecture

```
┌─────────────────────────────────────────────────┐
│                Native Shell                      │
│                                                  │
│  ┌──────────────────────┐  ┌──────────────────┐  │
│  │   Capacitor WebView  │  │  SQLite Database  │  │
│  │   (hosted mode)      │  │  (bundled asset)  │  │
│  │                      │  │                   │  │
│  │  boardsesh.com ──────┼──┤  board_climbs     │  │
│  │  (auth, social,      │  │  board_climb_stats│  │
│  │   party, queue sync) │  │  board_holes      │  │
│  │                      │  │  board_layouts    │  │
│  │  BLE Adapter ────────┼──┤  board_sets       │  │
│  │  (native bridge)     │  │  board_grades     │  │
│  │                      │  │  ...              │  │
│  └──────────────────────┘  └──────────────────┘  │
│                                                  │
│  Server (boardsesh.com) provides:                │
│  - Auth (NextAuth cookies)                       │
│  - Real-time queue sync (GraphQL WS)             │
│  - Social features (comments, follows)           │
│  - Aurora API proxy (data sync)                  │
│  - User ticks/logbook                            │
└─────────────────────────────────────────────────┘
```

### What Gets Embedded

**Read-only reference data** (bundled as SQLite per board):

| Table                              | Est. Rows (per board) | Purpose                                                    |
| ---------------------------------- | --------------------- | ---------------------------------------------------------- |
| `board_climbs`                     | 30,000-50,000         | Climb name, description, frames, setter, edges             |
| `board_climb_stats`                | 30,000-50,000         | Difficulty, ascensionist count, quality rating (per angle) |
| `board_difficulty_grades`          | ~30                   | Grade name translations (V0, V1, etc.)                     |
| `board_holes`                      | ~2,000                | Hold position grid (x, y coords for rendering)             |
| `board_layouts`                    | ~80                   | Layout definitions                                         |
| `board_product_sizes`              | ~150                  | Size/edge data (for edge filtering)                        |
| `board_products`                   | ~5                    | Product metadata                                           |
| `board_sets`                       | ~50                   | Set definitions                                            |
| `board_product_sizes_layouts_sets` | ~500                  | Configuration junction table                               |

**NOT embedded** (stays server-side):

| Data                      | Reason                            |
| ------------------------- | --------------------------------- |
| User accounts & auth      | NextAuth server-side sessions     |
| User ticks / logbook      | Synced via GraphQL, user-specific |
| Queue state               | Real-time sync via WebSocket      |
| Comments, follows, social | Server-side features              |
| Aurora API sync state     | Server-side sync tracking         |

### Database Size Estimates

| Board     | Uncompressed | Compressed (ZIP/SQLite) |
| --------- | ------------ | ----------------------- |
| Kilter    | ~400-500 MB  | ~120-150 MB             |
| Tension   | ~300-400 MB  | ~90-120 MB              |
| MoonBoard | ~100-150 MB  | ~30-50 MB               |

The `frames` column (hold positions as text like `p1234r12p5678r13`) dominates the size and compresses well.

### Delivery Strategy

To avoid bloating the initial app download:

- **iOS:** Use **On-Demand Resources (ODR)** — each board's SQLite database is a separate ODR tag. Downloaded when the user first selects that board. App Store hosts up to 20 GB of ODR.
- **Android:** Use **Play Asset Delivery** (asset packs) — similar concept, each board is a separate asset pack downloaded on demand.
- **Initial app size:** ~10-15 MB (native shell + BLE plugin, no board data)
- **Per-board download:** ~100-150 MB (one-time, on first board selection)

```
First launch flow:
1. User opens app → sees board selection screen (no download needed)
2. User selects "Kilter" → "Downloading Kilter climb data (120 MB)..."
3. SQLite database is copied to app documents directory
4. User can now search and browse Kilter climbs offline
5. Periodic sync updates the local database with new climbs
```

### Query Layer

The web app's climb search currently goes through the GraphQL backend → PostgreSQL. In Capacitor, we add a **local search path**:

```typescript
// packages/web/app/lib/ble/climb-search-adapter.ts
export async function searchClimbsLocal(
  params: ParsedBoardRouteParameters,
  searchParams: ClimbSearchParams,
): Promise<ClimbSearchResult> {
  if (!isNativeApp()) {
    // Fall through to server-side search
    return searchClimbsRemote(params, searchParams);
  }

  const db = await getLocalDatabase(params.board_name);

  // The search query is equivalent to the PostgreSQL version but in SQLite SQL
  const results = await db.query(
    `
    SELECT c.uuid, c.name, c.description, c.frames, c.setter_username,
           cs.ascensionist_count, cs.quality_average, cs.display_difficulty,
           dg.boulder_name as difficulty
    FROM board_climbs c
    LEFT JOIN board_climb_stats cs
      ON cs.climb_uuid = c.uuid AND cs.board_type = ? AND cs.angle = ?
    LEFT JOIN board_difficulty_grades dg
      ON dg.difficulty = ROUND(cs.display_difficulty) AND dg.board_type = ?
    WHERE c.board_type = ? AND c.layout_id = ? AND c.is_listed = 1
      AND c.is_draft = 0 AND c.frames_count = 1
      AND c.edge_left > ? AND c.edge_right < ?
      AND c.edge_bottom > ? AND c.edge_top < ?
    ORDER BY cs.ascensionist_count DESC
    LIMIT ? OFFSET ?
  `,
    [
      params.board_name,
      params.angle,
      params.board_name,
      params.board_name,
      params.layout_id,
      sizeEdges.edgeLeft,
      sizeEdges.edgeRight,
      sizeEdges.edgeBottom,
      sizeEdges.edgeTop,
      pageSize + 1,
      page * pageSize,
    ],
  );

  // Transform to Climb[] (same shape as server response)
  return transformResults(results);
}
```

**Key differences from server query:**

- No `boardsesh_ticks` subqueries (user progress filters only work online)
- No `ILIKE` (SQLite uses `LIKE` which is case-insensitive by default for ASCII)
- `ROUND()` works the same in SQLite
- Offline search returns climb data without user-specific ascent/attempt counts

### Sync Strategy

The local database needs periodic updates as new climbs are added to Aurora's platform:

1. **Initial load:** `copyFromAssets()` copies the bundled SQLite database
2. **Periodic sync (background):** When online, query the server for climbs updated since `last_sync_timestamp`
3. **Delta updates:** Insert/update only changed climbs — don't re-download the entire database
4. **Sync endpoint:** New API route `GET /api/internal/climb-sync?board=kilter&since=2026-03-01` returns recent climbs as JSON
5. **Sync frequency:** On app launch (if online) + every 24 hours in background

```typescript
// Sync flow
async function syncClimbDatabase(boardName: BoardName) {
  const lastSync = await getPreference(`${boardName}_last_sync`);
  const response = await fetch(`/api/internal/climb-sync?board=${boardName}&since=${lastSync}`);
  const { climbs, stats, deletedUuids } = await response.json();

  const db = await getLocalDatabase(boardName);
  await db.transaction(async (tx) => {
    for (const climb of climbs) {
      await tx.run('INSERT OR REPLACE INTO board_climbs ...', climb);
    }
    for (const stat of stats) {
      await tx.run('INSERT OR REPLACE INTO board_climb_stats ...', stat);
    }
    for (const uuid of deletedUuids) {
      await tx.run('DELETE FROM board_climbs WHERE uuid = ?', [uuid]);
    }
  });

  await setPreference(`${boardName}_last_sync`, new Date().toISOString());
}
```

### Build Pipeline

**Key insight:** The Kilter and Tension data originally comes from **Aurora's own SQLite databases** extracted from their APKs (see `packages/db/docker/Dockerfile.dev-db`). The dev database pipeline already extracts these SQLite files, converts them, and imports into PostgreSQL via pgloader. For the mobile app, we can **reverse this pipeline** — export from PostgreSQL back to SQLite, but only the tables/columns needed for mobile search.

The database uses a **unified table design** with a `board_type` discriminator column (not separate `kilter_*`/`tension_*` tables), so per-board export is a simple `WHERE board_type = ?` filter.

```bash
# packages/db/scripts/export-mobile-sqlite.sh
# Run periodically (e.g., weekly via GitHub Action) to generate fresh SQLite snapshots

for BOARD in kilter tension moonboard; do
  echo "Exporting $BOARD..."

  # Create SQLite database with schema
  sqlite3 "$BOARD.db" < packages/db/scripts/mobile-sqlite-schema.sql

  # Export from PostgreSQL → SQLite using the unified tables
  # Only export listed, non-draft climbs with their stats
  psql $DATABASE_URL -c "\COPY (
    SELECT uuid, board_type, layout_id, setter_username, name, description,
           frames, frames_count, edge_left, edge_right, edge_bottom, edge_top,
           is_listed, is_draft, created_at
    FROM board_climbs
    WHERE board_type = '$BOARD' AND is_listed = true AND is_draft = false
  ) TO STDOUT WITH CSV HEADER" | sqlite3 "$BOARD.db" ".import --csv /dev/stdin board_climbs"

  # Export climb stats (per angle)
  psql $DATABASE_URL -c "\COPY (
    SELECT climb_uuid, board_type, angle, display_difficulty, benchmark_difficulty,
           ascensionist_count, difficulty_average, quality_average
    FROM board_climb_stats
    WHERE board_type = '$BOARD'
  ) TO STDOUT WITH CSV HEADER" | sqlite3 "$BOARD.db" ".import --csv /dev/stdin board_climb_stats"

  # Export reference tables (small, export all rows for this board)
  # board_holes, board_layouts, board_product_sizes, board_sets,
  # board_products, board_difficulty_grades, board_product_sizes_layouts_sets

  # Create indexes for search performance
  sqlite3 "$BOARD.db" < packages/db/scripts/mobile-sqlite-indexes.sql

  # Vacuum and compress
  sqlite3 "$BOARD.db" "VACUUM;"
  zip "$BOARD.db.zip" "$BOARD.db"

  echo "$BOARD: $(du -h $BOARD.db.zip | cut -f1) compressed"
done
```

A GitHub Action runs this weekly and publishes the SQLite snapshots as release assets or to a CDN for On-Demand Resources / Play Asset Delivery.

### SQLite Indexes for Mobile Search

The search query needs these indexes for good performance:

```sql
-- packages/db/scripts/mobile-sqlite-indexes.sql

-- Primary search index (matches the main WHERE clause)
CREATE INDEX idx_climbs_search ON board_climbs(
  board_type, layout_id, is_listed, is_draft, frames_count
);

-- Edge filtering (size-specific boundary checks)
CREATE INDEX idx_climbs_edges ON board_climbs(
  board_type, layout_id, edge_left, edge_right, edge_bottom, edge_top
);

-- Stats lookup (JOIN condition + sort columns)
CREATE INDEX idx_stats_lookup ON board_climb_stats(
  board_type, climb_uuid, angle
);

-- Difficulty range filtering
CREATE INDEX idx_stats_difficulty ON board_climb_stats(
  board_type, angle, display_difficulty
);

-- Name search (SQLite's LIKE is case-insensitive for ASCII by default)
CREATE INDEX idx_climbs_name ON board_climbs(name COLLATE NOCASE);

-- Setter filtering
CREATE INDEX idx_climbs_setter ON board_climbs(setter_username);
```

### Impact on Milestones

This feature adds a new **Milestone 1.5: Embedded Climb Database** between BLE Integration and Native Polish:

**Milestone 1.5: Embedded Climb Database (2 weeks)**

Tasks:

- [ ] Set up `@capacitor-community/sqlite` plugin
- [ ] Create PostgreSQL → SQLite export script with proper schema translation
- [ ] Generate SQLite databases for each board (Kilter, Tension, MoonBoard)
- [ ] Implement On-Demand Resources (iOS) / Play Asset Delivery (Android) for per-board downloads
- [ ] Create `searchClimbsLocal()` query function mirroring the server-side search
- [ ] Implement board selection → download → database init flow
- [ ] Create sync endpoint (`/api/internal/climb-sync`)
- [ ] Implement delta sync on app launch
- [ ] Add offline indicator and graceful degradation (hide user-specific features when offline)
- [ ] Test search performance locally vs server (should be faster)
- [ ] Test offline flow: airplane mode → search → build queue → connect BLE → send climb

Exit criteria:

- Users can search and browse climbs offline after initial board download
- Climb search is at least as fast as the server-side search
- Delta sync keeps local database current when online
- Offline queue + BLE works end-to-end without internet

### Hybrid Offline Strategy

With the embedded database, the offline story becomes much stronger:

| Feature                    | Online                    | Offline                       |
| -------------------------- | ------------------------- | ----------------------------- |
| Climb search               | Local SQLite (fast)       | Local SQLite (same)           |
| Climb details              | Local + server enrichment | Local only (no user stats)    |
| Queue management           | Synced via GraphQL WS     | Local queue in IndexedDB      |
| BLE board control          | Works                     | Works                         |
| User progress (ticks)      | Available                 | Hidden (requires server)      |
| Social (comments, follows) | Available                 | Hidden                        |
| Party mode                 | Available                 | Unavailable                   |
| Auth                       | NextAuth cookies          | Cached session (if persisted) |

---

## Package Structure

> **v7.0 note:** `packages/web` (Next.js) **stays** and gains a second build target. The same package produces both the standalone web deploy and the static export bundled into Capacitor. `packages/backend` keeps growing the GraphQL surface area as REST routes migrate per Phase 0b.

```
boardsesh/
├── packages/
│   ├── web/                    # Existing Next.js. Two builds:
│   │                           #   - next build (standalone) → Railway, boardsesh.com
│   │                           #   - next build (output: 'export') → bundled into Capacitor
│   │                           # Adds: lib/data/query-router.ts, lib/data/sqlite-cache/
│   ├── backend/                # Existing graphql-ws + thin Hono HTTP for auth/OG/webhooks
│   ├── shared-schema/          # Existing (surface area grows as REST → GraphQL)
│   ├── db/                     # Existing (Phase 0a: neon-serverless → postgres-js)
│   │
│   └── mobile/                 # Capacitor native shell
│       ├── android/            # Android project (generated by Capacitor)
│       │   ├── app/
│       │   │   ├── src/main/
│       │   │   │   ├── AndroidManifest.xml
│       │   │   │   ├── java/.../MainActivity.java
│       │   │   │   └── res/
│       │   │   └── build.gradle
│       │   └── build.gradle
│       ├── ios/                # iOS project (generated by Capacitor)
│       │   └── App/
│       │       ├── App/
│       │       │   ├── AppDelegate.swift
│       │       │   ├── Info.plist
│       │       │   └── capacitor.config.json
│       │       └── App.xcworkspace
│       ├── capacitor.config.ts # Capacitor configuration
│       ├── package.json
│       └── tsconfig.json
```

### capacitor.config.ts

```typescript
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.boardsesh.app',
  appName: 'Boardsesh',
  // Hosted mode: load from production URL
  server: {
    url: 'https://boardsesh.com',
    // Allow navigation within the app's domain
    allowNavigation: ['boardsesh.com', '*.boardsesh.com'],
  },
  ios: {
    // Use WKWebView (default, supports modern JS)
    contentInset: 'automatic',
    backgroundColor: '#121212', // Match dark theme
    preferredContentMode: 'mobile',
  },
  android: {
    // Allow mixed content for dev
    allowMixedContent: true,
    backgroundColor: '#121212',
  },
  plugins: {
    StatusBar: {
      style: 'dark',
      backgroundColor: '#121212',
    },
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
    SplashScreen: {
      launchAutoHide: true,
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: true,
      backgroundColor: '#121212',
    },
  },
};

export default config;
```

---

## Capacitor Bridge Injection Strategy

**Critical architectural decision:** In hosted mode, the Capacitor WebView loads `https://boardsesh.com` — a regular web app that doesn't bundle `@capacitor/core` or any Capacitor plugins. The Capacitor native bridge is injected into the WebView by the native shell, making `window.Capacitor` available. However, **plugin JS code** (e.g., `@capacitor-community/bluetooth-le`) also needs to be available in the page context.

### How Plugin JS Gets Loaded

In hosted mode, Capacitor automatically injects the core bridge and registered plugin JS into the WebView before the page loads. This means:

1. **`window.Capacitor`** is available — the core bridge is injected by the native shell
2. **Registered plugin classes** are available on `window.Capacitor.Plugins` — each native plugin registers its JS interface during injection
3. **The web app does NOT need `@capacitor/core` or plugin packages as dependencies** — the JS bridge is injected, not bundled

### Web Package Strategy

The BLE abstraction layer in `packages/web/app/lib/ble/` should:

- **Use `window.Capacitor.Plugins.BluetoothLe`** directly (or dynamic import) instead of importing from `@capacitor-community/bluetooth-le`
- **Guard all Capacitor plugin access** with `isCapacitor()` checks
- **Never add Capacitor packages to the web package's `dependencies`** — they add unnecessary bundle size for browser users and their JS isn't needed (the bridge injects it)

```typescript
// packages/web/app/lib/ble/capacitor-adapter.ts
// Access the plugin via the injected bridge, not via npm import
async function getBleClient() {
  if (!isCapacitor()) throw new Error('Not in Capacitor');
  // The plugin JS is injected by the native shell
  const { BleClient } = await import('@capacitor-community/bluetooth-le');
  return BleClient;
}
```

> **Note:** If the dynamic import approach doesn't work in hosted mode (since the package isn't in node_modules on the web server), fall back to accessing `window.Capacitor.Plugins.BluetoothLe` directly and wrapping it with a typed interface. Validate this in Milestone 0.

### Type Safety

Install Capacitor plugin packages as **devDependencies** in the web package for TypeScript types only:

```json
{
  "devDependencies": {
    "@capacitor-community/bluetooth-le": "^6.0.0"
  }
}
```

This gives TypeScript type checking without adding anything to the production bundle.

### v7.0: Bundled mode via Next.js static export (Phase 2 onward)

The bridge injection rules above apply to **hosted mode** (the WebView loads `https://boardsesh.com`). After Phase 2, the Capacitor app ships the Next.js static export as bundled assets and loads it from `capacitor://localhost`. In that mode:

- **The plugin JS bridge is still injected by the native shell** — the `window.Capacitor` global and `window.Capacitor.Plugins` are available before any JS runs, regardless of hosted vs bundled.
- **The bundle CAN import Capacitor packages directly** from `node_modules` (e.g. `import { BleClient } from '@capacitor-community/bluetooth-le'`) because the bundle ships with the app and there's no bandwidth cost. The `isCapacitor()` guard pattern still applies — the same Next.js code also runs in browsers, where Capacitor packages need to no-op.
- **PR #1509 native tab bar continues working** — the JS bridge events from `NativeTabBarPlugin` reach the bundled WebView the same way they reach the hosted one. Per-tab WKWebView remains a future option but isn't required by Path A.
- **Migration:** during Phase 2, swap the BLE adapter from "access via `window.Capacitor.Plugins.BluetoothLe`" to "import directly from `@capacitor-community/bluetooth-le`." The interface in `packages/web/app/lib/ble/types.ts` is unchanged.

---

## Web App Adaptations

The web app needs minimal changes to work well inside the Capacitor shell. All changes are backward-compatible — the app continues to work in regular browsers.

### 1. Detect Capacitor Environment

```typescript
// packages/web/app/lib/capacitor.ts
export const isCapacitor = (): boolean => typeof window !== 'undefined' && window.Capacitor !== undefined;

export const isNativeApp = (): boolean => isCapacitor() && window.Capacitor?.isNativePlatform();

export const getPlatform = (): 'ios' | 'android' | 'web' =>
  isCapacitor() ? (window.Capacitor?.getPlatform() as 'ios' | 'android') : 'web';
```

### 2. BLE Abstraction Layer

The existing `bluetooth.ts` uses Web Bluetooth API directly. We need an abstraction that uses the native BLE plugin when running in Capacitor and falls back to Web Bluetooth in regular browsers.

See [Bluetooth Strategy](#bluetooth-strategy) for details.

### 3. Remove X-Frame-Options for Capacitor

The Capacitor WebView loads the site in a frame-like context. The current `X-Frame-Options: SAMEORIGIN` header in `next.config.mjs` needs to be relaxed for Capacitor requests. This can be done by checking the User-Agent or using a custom header:

```typescript
// In next.config.mjs headers()
{
  source: '/:path*',
  headers: [
    // Only set X-Frame-Options for non-Capacitor requests
    // Capacitor WebView doesn't actually use iframes, so SAMEORIGIN
    // usually works fine. Test and adjust if needed.
    { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  ],
},
```

> Note: Capacitor's WKWebView on iOS and Android WebView don't load pages via iframes — they load the URL directly in the WebView. So `X-Frame-Options: SAMEORIGIN` should not cause issues. Verify during Milestone 0.

### 4. Safe Area Insets

Add CSS for device safe areas (notch, rounded corners):

```css
/* Already in the web app's global styles or MUI theme */
:root {
  --safe-area-top: env(safe-area-inset-top);
  --safe-area-bottom: env(safe-area-inset-bottom);
  --safe-area-left: env(safe-area-inset-left);
  --safe-area-right: env(safe-area-inset-right);
}
```

The app layout's top app bar and bottom navigation need to respect these insets. MUI's `AppBar` and `BottomNavigation` should add padding using these CSS variables when `isNativeApp()` is true.

### 5. Deep Link Handling

Configure Capacitor's App plugin to handle deep links:

```typescript
import { App } from '@capacitor/app';

// Listen for deep links (boardsesh://climb/xxx, universal links)
App.addListener('appUrlOpen', ({ url }) => {
  const path = new URL(url).pathname;
  router.push(path);
});
```

### 6. Hide Web-Only Elements

Some elements should be hidden in the native app:

- Browser install prompts / PWA banners
- "Use Bluefy for iOS Bluetooth" messages (native BLE works)
- Any browser-specific instructions

```typescript
// Use isNativeApp() to conditionally render
{!isNativeApp() && <BluefyBanner />}
```

---

## Authentication in WebView

**This is a critical concern the plan must address.** The app uses NextAuth with JWT strategy, storing sessions in cookies (`__Secure-next-auth.session-token` and `next-auth.session-token`).

### Cookie Behavior in WebViews

| Platform        | Cookie Jar           | Persistence                       | Shared with Browser? |
| --------------- | -------------------- | --------------------------------- | -------------------- |
| iOS WKWebView   | Separate from Safari | May be cleared on app termination | No                   |
| Android WebView | Separate from Chrome | Generally persistent              | No                   |

**Key implications:**

- Users logged in via Safari/Chrome will **not** be logged in when they open the Capacitor app — they must log in again
- WKWebView on iOS can lose cookies when the OS terminates the app process (memory pressure, user force-quit)
- The `__Secure-` cookie prefix requires HTTPS, which works for production but complicates local development

### WebSocket Auth Chain

The real-time queue/party features use this auth flow:

1. Web app calls `GET /api/internal/ws-auth` which reads the NextAuth session cookie via `getToken()`
2. If the cookie is missing or expired, `getToken()` returns `null` → WebSocket connects without auth
3. Backend receives `null` token → mutations and subscriptions that require auth fail silently

**If cookies don't persist, users appear logged in (cached UI state in IndexedDB) but real-time features break.**

### Mitigation Strategy

1. **Milestone 0: Validate cookie persistence** — Test login → force-quit app → relaunch → verify session on both platforms
2. **If cookies are unreliable, implement a fallback:**
   - On successful login, store the JWT token in `@capacitor/preferences` (secure storage)
   - On app launch, check if session cookie exists; if not, restore from secure storage
   - Pass the stored token to WebSocket connection params as a backup
3. **Session refresh:** Add logic to detect expired sessions and prompt re-login with a native-feeling sheet, not a full page redirect

### Native OAuth (Implemented)

Social login (Google, Apple, Facebook) cannot use `signIn()` from the WebView because the WebView and external browser have separate cookie jars. Instead, the app opens `/auth/native-start` in the Capacitor Browser plugin, which runs the entire OAuth flow in the external browser's cookie context. After OAuth completes, the server issues a short-lived HMAC-signed transfer token and redirects to a `com.boardsesh.app://` deep link. The native app intercepts the deep link, closes the browser, and uses the transfer token to create a session inside the WebView via a `native-oauth` credentials provider.

See [OAuth Setup: Native App Authentication](./oauth-setup.md#native-app-authentication-capacitor) for the full flow and file references.

### CORS Considerations

The backend CORS handler (`packages/backend/src/handlers/cors.ts`) whitelists specific origins:

- iOS WKWebView loading `https://boardsesh.com` sends `Origin: https://boardsesh.com` — should work
- Android WebView may send `Origin: null` for certain requests
- The backend currently allows connections without an origin header (for native app support), which helps but should be combined with auth token validation for defense in depth

**Action:** Verify Android WebView origin behavior in Milestone 0.

### v7.0: Auth in bundled mode

In v7.0, **NextAuth stays in `packages/web`** by default. The Capacitor app loads a bundled static export from `capacitor://localhost`, but auth requests still go to the standalone Next.js deploy on Railway over the network. This matches the v6.0 story for auth flows but doesn't require migrating NextAuth out of Next.js.

- **Cookie acquisition.** During login, the WebView opens the OAuth flow through the Capacitor Browser plugin (existing native OAuth pattern). The transfer token round-trip lands the session cookie inside the WebView's `WKWebsiteDataStore`. After login, the bundled app makes authenticated GraphQL calls by reading that cookie.
- **Cross-origin from `capacitor://localhost` to `https://boardsesh.com` (or backend host).** Backend CORS already allows the Capacitor origin for native requests. Verify in Phase 2 that the cookie is sent on cross-origin GraphQL requests with `credentials: 'include'`, and that `SameSite=None; Secure` is set on the auth cookie for the cross-origin case (this is the only meaningful auth change between hosted and bundled).
- **Native OAuth flow unchanged at the user level.** `/auth/native-start` and the `native-oauth` credentials provider keep working. The `com.boardsesh.app://` deep link is unchanged.
- **Token in IndexedDB as fallback.** The existing fallback path (JWT stored via `@capacitor/preferences`) covers cases where the WebView cookie jar gets cleared between launches.

**Optional future work.** Migrating NextAuth → Auth.js core in `packages/backend` is **not required by v7.0** but remains useful long-term cleanup. It removes the Next.js dependency for auth (helpful if v6.0 framework migration is ever revisited) and lets the auth host scale independently of the SEO web. Defer until there's a concrete reason to do it.

---

## Implementation Milestones

### Milestone 0: Proof of Concept + Auth Validation (2 weeks)

> **Goal:** Verify the web app loads correctly in Capacitor WebView, native BLE plugin can connect, auth works end-to-end, and the Capacitor bridge injection strategy works in hosted mode.

**Tasks:**

- [ ] Initialize Capacitor project in `packages/mobile/`
- [ ] Configure `capacitor.config.ts` with hosted URL (use staging/dev URL initially)
- [ ] Add iOS and Android platforms
- [ ] Build and run on iOS simulator (verify web app loads)
- [ ] Build and run on Android emulator (verify web app loads)
- [ ] Test on physical iOS device (verify web app loads, navigation works)
- [ ] Test on physical Android device
- [ ] **Auth validation:** Log in → force-quit app → relaunch → verify session persists (both platforms)
- [ ] **Auth validation:** Verify WebSocket connection authenticates correctly in the WebView
- [ ] **Auth validation:** If cookies are unreliable, prototype `@capacitor/preferences` token backup
- [ ] **Bridge injection:** Verify `window.Capacitor` is available on page load in hosted mode
- [ ] **Bridge injection:** Verify plugin classes are accessible via `window.Capacitor.Plugins`
- [ ] **Bridge injection:** Test dynamic import vs direct `window.Capacitor.Plugins.BluetoothLe` access
- [ ] Install `@capacitor-community/bluetooth-le` plugin
- [ ] Write a minimal test: scan for Aurora boards, connect, send one LED command
- [ ] Verify that Web Bluetooth still works in Android Chrome (no regressions)
- [ ] Verify `X-Frame-Options` doesn't block Capacitor WebView
- [ ] **CORS:** Verify Android WebView origin header behavior with the backend
- [ ] **Bluefy banner:** Verify iOS detection behavior in WebView (confirm `isIOS` is true, `isBluetoothSupported` is false — must fix in Milestone 1)

**Exit Criteria:**

- Web app loads and is fully functional in Capacitor on both platforms
- Auth works end-to-end: login, session persistence across app restarts, WebSocket auth
- Bridge injection strategy validated (dynamic import or window.Capacitor.Plugins approach chosen)
- Native BLE successfully connects to a Kilter or Tension board and lights LEDs on iOS
- Android CORS behavior documented, no blockers
- No regressions to the web app in regular browsers

---

### Milestone 1: BLE Integration (2-3 weeks)

> **Goal:** Replace Web Bluetooth with native BLE when running inside Capacitor, while maintaining Web Bluetooth for regular browser usage.

**Tasks:**

- [ ] Create BLE abstraction layer (`packages/web/app/lib/ble/`)
  - [ ] Define common interface (`BluetoothAdapter`) — see expanded interface below
  - [ ] Implement `WebBluetoothAdapter` (wraps existing `navigator.bluetooth` code)
  - [ ] Implement `CapacitorBleAdapter` (wraps native BLE plugin via bridge injection strategy from Milestone 0)
  - [ ] Factory function that returns the right adapter based on environment
- [ ] **Fix chunking responsibility:** The adapter's `write()` must handle all transport-level chunking internally. Remove `splitMessages()` from the call site in `use-board-bluetooth.ts`. Callers pass the full packet (`getBluetoothPacket()` output); the adapter splits it for transport.
- [ ] Port protocol logic (packet framing, encoding) to work with both adapters
- [ ] Update `use-board-bluetooth.ts` to use the abstraction
- [ ] Update `bluetooth-context.tsx`:
  - [ ] Remove iOS/Bluefy-specific warnings when `isNativeApp()` is true
  - [ ] `isBluetoothSupported` returns `true` when `isCapacitor()` is true
  - [ ] Hide Bluefy download banner in native app context
- [ ] Handle BLE permissions on both platforms
  - [ ] iOS: Request Bluetooth permission
  - [ ] Android: Request location + Bluetooth permissions (Android 12+ vs older)
- [ ] Test connect/disconnect/reconnect cycles
- [ ] Test sending multiple climbs in sequence
- [ ] Test BLE when app is backgrounded and foregrounded
- [ ] Test on multiple physical devices (at least 2 iOS, 2 Android)

**Exit Criteria:**

- BLE works reliably on iOS and Android via native plugin
- Web Bluetooth continues to work in Chrome/Bluefy
- No double-chunking — verified by inspecting BLE traffic on a physical board
- Switching climbs auto-sends correct LEDs
- Wake lock keeps screen on during session
- Bluefy banner hidden in Capacitor on iOS

---

### Milestone 2: Native Polish (1.5 weeks)

> **Goal:** Make the app feel native — proper status bar, splash screen, safe areas, deep links, offline handling.

**Tasks:**

- [ ] Configure splash screen (icon, colors matching brand) — dedicated native screen, not just WebView spinner
- [ ] Configure app icons for all required sizes (iOS + Android)
- [ ] Implement safe area inset handling in CSS
- [ ] Configure status bar (dark/light based on theme)
- [ ] Set up deep link handling
  - [ ] `boardsesh://` custom scheme
  - [ ] Universal links (iOS) / App links (Android) for **specific paths only** (`/party/*`, `/invite/*`) — not the entire domain, to avoid hijacking all boardsesh.com links from users who prefer the browser
  - [ ] Handle party session join links
  - [ ] Handle climb detail links
  - [ ] Add "Open in browser" option in the app
- [ ] Add haptic feedback for key actions (via `@capacitor/haptics`)
  - [ ] Climb sent to board
  - [ ] Queue item added
  - [ ] Bluetooth connected
- [ ] Add `@capacitor/keyboard` for proper keyboard behavior
- [ ] Add `@capacitor/app` for back button handling (Android)
- [ ] Test pull-to-refresh behavior
- [ ] **Offline handling:**
  - [x] Install `@capacitor/network` plugin _(superseded: implemented native Android/iOS connectivity monitoring directly in shell code)_
  - [ ] Add offline detection screen showing cached queue from IndexedDB
  - [ ] Show "reconnecting..." banner when connectivity is lost mid-session
  - [ ] Ensure app has _some_ functionality without internet (cached queue view, BLE connection to board)
- [ ] **Native crash reporting:** Add Sentry iOS/Android SDKs for crashes outside the WebView (BLE plugin crashes, WebView crashes)

**Exit Criteria:**

- App looks and feels native (no web artifacts visible)
- Deep links open correct screens (scoped paths only)
- Status bar, safe areas, and keyboard behavior are correct
- Haptic feedback on key interactions
- Offline screen shows cached content instead of blank page
- Native crashes are reported to Sentry

---

### Milestone 3: App Store Submission (2 weeks)

> **Goal:** Prepare and submit to both app stores. Moved before push notifications — the app can ship without push for v1.0.

**Tasks:**

- [ ] Create app store listings
  - [ ] App description emphasizing BLE board control (not "web wrapper")
  - [ ] Screenshots (iPhone, iPad, Android phone, Android tablet)
  - [ ] Feature graphic (Play Store)
  - [ ] Keywords / categories
- [ ] Prepare legal documents
  - [ ] Privacy policy (what data is collected, BLE usage)
  - [ ] Terms of service
- [ ] Configure app signing
  - [ ] iOS: Certificates, provisioning profiles, App Store Connect
  - [ ] Android: Keystore, Play Console setup
- [ ] Set up CI/CD for app builds
  - [ ] GitHub Actions workflow for building iOS (via Xcode Cloud or Fastlane)
  - [ ] GitHub Actions workflow for building Android
  - [ ] Automated version bumping
- [ ] **Version handshake:** Add `NATIVE_SHELL_MIN_VERSION` to web app config. On launch, web app checks native shell version via `window.Capacitor` and shows "update your app" prompt if too old.
- [ ] Beta testing
  - [ ] iOS TestFlight distribution
  - [ ] Android Play Store internal testing track
  - [ ] Gather feedback from 5-10 beta users
- [ ] **App Store review preparation:**
  - [ ] In review notes, guide Apple reviewers to BLE connection feature with video demo
  - [ ] Highlight native features: BLE, haptics, offline mode, native splash screen
  - [ ] Ensure the offline screen demonstrates the app isn't just a web wrapper
  - [ ] Address any review feedback
- [ ] Submit to app stores

**Exit Criteria:**

- Apps accepted and published on both stores
- CI/CD pipeline builds and signs apps automatically
- Beta feedback addressed
- Version handshake works (old native shells prompt for update)

---

### Milestone 4: Push Notifications (2-3 weeks, post-launch)

> **Goal:** Native push notifications for party invites, session events, and social interactions. This is a significant backend + frontend effort and can ship as a v1.1 update.

**Tasks:**

- [ ] Install `@capacitor/push-notifications`
- [ ] **Backend: device token storage** — new database table for device tokens, user association, platform type
- [ ] **Backend: push sending service** — Firebase Admin SDK (Android) + APNs (iOS)
- [ ] Set up Firebase Cloud Messaging project (Android)
- [ ] Set up Apple Push Notification service certificates/keys (iOS)
- [ ] Create backend endpoints to register/unregister device tokens
- [ ] Implement push notification types:
  - [ ] Party session invite
  - [ ] Climb comment/reply
  - [ ] New follower
  - [ ] Session activity (someone joined/left)
- [ ] Handle notification tap → deep link to relevant screen
- [ ] Handle foreground notifications (in-app banner)
- [ ] Implement notification permissions request flow
- [ ] Test both platforms in foreground, background, and killed states

**Exit Criteria:**

- Push notifications arrive on both platforms
- Tapping notification opens correct screen
- Foreground notifications show as in-app banners
- User can control notification preferences

---

### v7.0 Offline-First Phases (parallel to / after M0–M4)

The phases below run alongside the Capacitor work above. **M0–M4 still apply to the native shell.** Each phase is independently shippable, and the offline happy path lands by Phase 5.

| Phase | Duration | Goal |
|-------|----------|------|
| **0a: Hosting cutover** | 2-3w | Postgres lifted from Neon to Railway. `packages/db` client switched from `neon-serverless` → `postgres-js`. Backend redeployed to Railway. Vercel `packages/web` keeps running, pointing at Railway DB. No user-visible change. Independent of all other phases. |
| **0b: REST → GraphQL completion** | 4-6w | Continue the in-progress migration per `CLAUDE.md`. All `/api/internal/*` and `/api/v1/*` data routes move to GraphQL in `packages/backend`. Hono carve-outs in backend for OG images and webhooks. Aurora proxy mutations move to GraphQL. Auth.js migration from NextAuth → backend Hono is **optional** in v7.0 (NextAuth-on-Next.js works fine with bundled WebView; deferring this work is fine). |
| **1: Dual-build pipeline** | 3-4w | `next.config.mjs` reads `NEXT_BUILD_TARGET`. Standalone (default) for web; export for Capacitor. CI publishes both artifacts. **In-app routes refactored** to client components fetching via the query router. SEO routes (homepage, public profile, public climb, public playlist) stay server-rendered in the standalone build only. |
| **2: Capacitor bundle switch** | 2w | `capacitor.config.ts` drops `server.url`; `webDir` points at the export output. Build script copies `packages/web/out/` into the mobile package. SPA fallback for unknown routes. **App launches in airplane mode** with bundled assets. PR #1509 native tab bar continues working — tabs switch instantly without network. |
| **3: Refdata SQLite (formerly v5.0 M1.5)** | 2w | Per-board SQLite via ODR (iOS) / Asset Pack (Android). Query router activates `climbs.search`, `climbs.byUuid`, `holds.forLayout` against local DB. Falls through to remote on miss. **Search and climb detail work offline.** |
| **4: User-data read cache** | 3-4w | New SQLite tables for `cached_ticks`, `cached_playlists`, `cached_queues`, `cached_profile`, `cache_metadata`. Stale-while-revalidate via TanStack Query. Background sync on launch / resume / pull-to-refresh. **Profile, ticks, playlists render instantly offline.** |
| **5: Mutation queue** | 3-4w | `pending_mutations` table. Optimistic UI on enqueue. Drain on reconnect with exponential backoff. Server-wins conflict policy; failed mutations surface in UI. **Tick a climb in airplane mode → syncs on reconnect.** This is the offline-happy-path completion milestone. |
| **6: Connectivity polish** | 1-2w | Persistent online/offline banner. Sync status ("12 actions pending"). Per-mutation retry UI for failures. Onboarding for "your boards have downloaded refdata." |
| **(cross-cutting): Analytics + observability** *(rolling)* | — | PostHog client + server SDKs in place. Sentry SSR + native SDK integration. Runs alongside any phase, not gated. |

**Total v7.0 scope: ~5-6 months.** Critical path for the offline happy path is **Phases 1, 2, 3, 5** (~3-4 months). Phase 4 expands the offline surface beyond happy path; Phase 6 is finish work.

#### Phase exit criteria

- **0a:** Existing Next.js + backend run against Railway DB without errors. Playwright e2e suite green against staging. PostGIS queries (heatmap, climb stats) verified. Connection-pool sizing confirmed under load.
- **0b:** GraphQL surface covers former REST endpoints. Backend Hono carve-outs reachable. Existing tests pass against new GraphQL queries. No regressions in `vp test`.
- **1:** `bun run build` produces standalone Next.js (Vercel/Railway-deployable). `bun run build:capacitor` produces a static `out/` directory with no API routes, no server-only imports inside in-app pages, no middleware references. Both green in CI. Existing web deploy unaffected.
- **2:** Capacitor build with bundled assets installs and launches on iOS + Android. **Airplane-mode launch reaches the home screen.** Static routes render. Dynamic routes render their client shells. BLE connect + send still works. Deep links (`boardsesh://`) route to the right page. LiveActivity continues to receive queue updates when online.
- **3:** Airplane-mode search returns results within 100ms. Climb detail page renders from local SQLite. First refdata sync runs on next online launch and applies deltas without re-downloading the database.
- **4:** User opens app offline, sees their full ticks list, playlists, profile. UI is identical online/offline except for absent realtime data. Stale-while-revalidate refreshes happen in background within 2s of regaining network.
- **5:** **Pinned user story end-to-end:** open in airplane mode → search Kilter → add 3 climbs to queue → BLE send first climb → tick it → advance queue → tick second → reconnect → all 3 ticks present on server within 10s. Optimistic UI never flickers. No duplicate ticks.
- **6:** Online/offline indicator visible at all times. Sync banner shows pending counts. Failed mutations surface a tap-to-retry UI. New-user onboarding mentions the offline capability.

---

## Bluetooth Strategy

### Current Architecture (Web Bluetooth)

```
bluetooth.ts          → Packet encoding, framing (platform-agnostic)
use-board-bluetooth.ts → React hook using navigator.bluetooth
bluetooth-context.tsx  → React context providing BLE to the component tree
```

### Target Architecture (Abstracted)

```
packages/web/app/lib/ble/
├── types.ts              # Common BluetoothAdapter interface
├── web-adapter.ts        # Web Bluetooth implementation (existing logic)
├── capacitor-adapter.ts  # Capacitor BLE plugin implementation
├── adapter-factory.ts    # Returns correct adapter based on environment
└── index.ts

packages/web/app/components/board-bluetooth-control/
├── bluetooth.ts          # Protocol encoding (unchanged, platform-agnostic)
├── use-board-bluetooth.ts # Updated to use BluetoothAdapter interface
└── bluetooth-context.tsx  # Updated, removes Bluefy warnings in native
```

### BluetoothAdapter Interface

```typescript
// packages/web/app/lib/ble/types.ts
export interface BluetoothAdapter {
  /**
   * Whether BLE is actually available and enabled (not just supported).
   * On native: checks BleClient.isEnabled() — BLE can be disabled in device settings.
   * On web: checks navigator.bluetooth existence.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Scan for and connect to a board. Returns a connection handle.
   * Shows platform-appropriate device picker (Web Bluetooth dialog or native scan sheet).
   */
  requestAndConnect(serviceUUIDs: string[]): Promise<BleConnection>;

  /** Disconnect from the current device */
  disconnect(): Promise<void>;

  /**
   * Write the COMPLETE packet to the board's UART characteristic.
   * The adapter handles transport-level chunking internally (20-byte for default MTU,
   * or larger if MTU negotiation succeeded).
   *
   * IMPORTANT: Callers pass the full output of getBluetoothPacket() — do NOT pre-chunk
   * with splitMessages(). The adapter owns fragmentation.
   */
  write(data: Uint8Array): Promise<void>;

  /**
   * Register a callback for disconnection events. Returns an unsubscribe function.
   */
  onDisconnect(callback: () => void): () => void;
}

export interface BleConnection {
  deviceId: string;
  deviceName?: string;
}
```

### Capacitor BLE Plugin Usage

```typescript
// packages/web/app/lib/ble/capacitor-adapter.ts
import { BleClient, numberToUUID } from '@capacitor-community/bluetooth-le';

const AURORA_SERVICE_UUID = '4488b571-7806-4df6-bcff-a2897e4953ff';
const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_WRITE_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

export class CapacitorBleAdapter implements BluetoothAdapter {
  private deviceId: string | null = null;
  private disconnectCallback: (() => void) | null = null;
  private mtu = 20; // Default conservative MTU; updated after negotiation

  async isAvailable(): Promise<boolean> {
    try {
      await BleClient.initialize();
      return await BleClient.isEnabled();
    } catch {
      return false;
    }
  }

  async requestAndConnect(serviceUUIDs: string[]): Promise<BleConnection> {
    await BleClient.initialize();

    // Request device (shows native scan dialog)
    const device = await BleClient.requestDevice({
      services: [serviceUUIDs[0]],
      optionalServices: serviceUUIDs.slice(1),
    });

    // Connect
    await BleClient.connect(device.deviceId, () => {
      this.disconnectCallback?.();
    });

    // Negotiate larger MTU on Android (iOS negotiates automatically)
    try {
      const negotiatedMtu = await BleClient.requestMtu(device.deviceId, 512);
      this.mtu = negotiatedMtu - 3; // MTU minus ATT header
    } catch {
      // MTU negotiation failed, use default 20
    }

    this.deviceId = device.deviceId;
    return {
      deviceId: device.deviceId,
      deviceName: device.name,
    };
  }

  async disconnect(): Promise<void> {
    if (this.deviceId) {
      await BleClient.disconnect(this.deviceId);
      this.deviceId = null;
    }
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.deviceId) throw new Error('Not connected');

    // Adapter owns chunking — callers pass the full packet from getBluetoothPacket().
    // Chunk size based on negotiated MTU (default 20 bytes).
    const chunkSize = this.mtu;
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize);
      await BleClient.write(this.deviceId, UART_SERVICE_UUID, UART_WRITE_UUID, chunk);
    }
  }

  onDisconnect(callback: () => void): () => void {
    this.disconnectCallback = callback;
    return () => {
      this.disconnectCallback = null;
    };
  }
}
```

### Protocol Layer

The existing `getBluetoothPacket()` and encoding functions in `bluetooth.ts` are already platform-agnostic — they work with `Uint8Array` and don't touch any browser APIs. They remain unchanged.

**Important change:** `splitMessages()` (which splits into 20-byte chunks) must be **moved into the adapters**, not called by the hook. The hook currently calls `splitMessages(bluetoothPacket)` then `writeCharacteristicSeries()`. After refactoring, the hook calls `adapter.write(fullPacket)` and the adapter handles chunking internally. This prevents double-chunking when the Capacitor adapter also splits, and allows the Capacitor adapter to use a larger chunk size via MTU negotiation.

---

## Development Workflow

### Local Development Setup

For day-to-day development, the Capacitor app points at the local dev server instead of production:

```typescript
// capacitor.config.dev.ts (not committed — or use environment variable)
const config: CapacitorConfig = {
  ...baseConfig,
  server: {
    url: 'http://LOCAL_IP:3000', // Use machine's LAN IP, not localhost
    cleartext: true, // Allow HTTP for local dev
  },
};
```

Run with live reload:

```bash
# Start web dev server
npm run dev

# Run on iOS with live reload
cd packages/mobile
npx cap run ios --livereload --external

# Run on Android with live reload
npx cap run android --livereload --external
```

### BLE Testing

BLE requires **physical devices** — simulators/emulators do not support Bluetooth:

- **iOS:** Requires an Apple Developer account, provisioning profile, and a physical iPhone/iPad
- **Android:** Enable USB debugging, connect via ADB
- Test with at least one Kilter board and one Tension board if possible

### Debugging

- **iOS WebView:** Safari → Develop menu → select device → inspect WebView
- **Android WebView:** Chrome → `chrome://inspect` → select device → inspect WebView
- **Native logs:** Xcode console (iOS), Logcat (Android) — useful for BLE plugin debugging
- **Network:** WebView network requests appear in Safari/Chrome DevTools just like regular browser requests

### Device Testing Matrix

| Device         | OS Version  | Screen      | Purpose                               |
| -------------- | ----------- | ----------- | ------------------------------------- |
| iPhone 13+     | iOS 16+     | Notched     | Safe areas, primary iOS testing       |
| iPhone SE      | iOS 16+     | Non-notched | Small screen, no safe area top        |
| iPad           | iPadOS 16+  | Large       | Tablet layout                         |
| Pixel 6+       | Android 12+ | Standard    | Primary Android testing               |
| Samsung Galaxy | Android 11  | Variable    | Older Android, Samsung WebView quirks |

---

## App Store Distribution

### App Store Review Considerations

**Apple App Store:**

- Apps that are primarily web wrappers may be rejected under guideline 4.2 (Minimum Functionality). Mitigation: The native BLE integration provides genuine native functionality that isn't available in Safari. The app is not a "thin client" — it enables hardware control that is impossible via the browser.
- BLE usage description must clearly explain why the app needs Bluetooth access.
- Privacy nutrition labels must accurately describe data collection.

**Google Play Store:**

- WebView apps are generally accepted if they provide value.
- BLE permissions must be justified in the app listing.
- Target API level requirements must be met (currently API 34+).

### Version Strategy

Since the web app updates independently of the native shell:

- **Native shell version** (e.g., 1.0.0, 1.1.0): Bumped when native plugins, configs, or platform code changes. Requires app store review.
- **Web app version**: Deploys via Vercel as usual. No app store review needed. Updates are instant for all users.

In practice, the native shell should rarely need updates after initial launch — most changes happen in the web layer.

### CI/CD Pipeline

```yaml
# .github/workflows/mobile-build.yml (simplified)
name: Mobile Build
on:
  push:
    paths:
      - 'packages/mobile/**'
    branches: [main]

jobs:
  build-android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cd packages/mobile && bun install
      - run: bunx cap sync android
      - run: cd android && ./gradlew assembleRelease
      - uses: actions/upload-artifact@v4
        with:
          name: android-release
          path: packages/mobile/android/app/build/outputs/apk/release/

  build-ios:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - run: cd packages/mobile && bun install
      - run: bunx cap sync ios
      - run: xcodebuild -workspace ios/App/App.xcworkspace -scheme App -archivePath build/App.xcarchive archive
      # ... signing and export steps
```

---

## Risk Assessment

### Technical Risks

| Risk                                                      | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple rejects as "web wrapper"                            | **Medium** | High   | Strong mitigations: embedded SQLite climb database with offline search, native BLE board control, haptics, On-Demand Resources for per-board data. Reviewers see genuine native functionality even without a board. Include guided review notes with video demo. |
| WebView cookie/auth persistence issues                    | **High**   | High   | Milestone 0 validates auth end-to-end. Fallback: store JWT in `@capacitor/preferences` and restore on launch.                                                                                                                                                    |
| Capacitor bridge injection in hosted mode                 | **Medium** | High   | Milestone 0 validates plugin JS availability. Test both dynamic import and `window.Capacitor.Plugins` approaches.                                                                                                                                                |
| BLE double-chunking in adapter layer                      | **Medium** | High   | Adapter owns all chunking. Verify with physical board that LED patterns are correct.                                                                                                                                                                             |
| Capacitor BLE plugin incompatibility with Aurora protocol | Low        | High   | Milestone 0 validates end-to-end BLE. Plugin uses CoreBluetooth (iOS) / Android BLE APIs directly.                                                                                                                                                               |
| WebView performance on older devices                      | Low        | Medium | Capacitor uses WKWebView (iOS) and modern Chromium WebView (Android). The web app already runs well in mobile browsers.                                                                                                                                          |
| Network dependency (hosted mode)                          | Medium     | Medium | Offline detection screen with cached queue. Service worker for API response caching.                                                                                                                                                                             |
| Android WebView CORS origin issues                        | Medium     | Medium | Verify in Milestone 0. Backend allows null origin but should validate auth token.                                                                                                                                                                                |
| Version mismatch between web and native shell             | Medium     | Medium | Version handshake on launch; "update your app" prompt for old shells.                                                                                                                                                                                            |

### Schedule Risks

| Risk                                       | Likelihood | Impact | Mitigation                                                                               |
| ------------------------------------------ | ---------- | ------ | ---------------------------------------------------------------------------------------- |
| App store review delays                    | Medium     | Medium | Submit early, have contingency time. Budget 2 weeks for review cycles.                   |
| BLE edge cases on specific devices         | **High**   | Medium | Budget extra time in Milestone 1. Test on multiple physical devices (see device matrix). |
| Auth/cookie debugging in WebView           | **High**   | Medium | Budget extra time in Milestone 0. Cookie persistence varies by OS version.               |
| Push notification backend scope creep      | Medium     | Medium | Defer to v1.1 post-launch. Ship MVP without push.                                        |
| Safe area / CSS issues on specific devices | Low        | Low    | Test on notched and non-notched devices.                                                 |

### v7.0 Migration Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------:|-------:|------------|
| Server components in in-app routes resist export-mode conversion | **High** | Medium | Phase 1 audits each route. SEO surfaces stay server-rendered in standalone build only. In-app routes get a mechanical conversion to client + GraphQL. Dual-build CI catches regressions. |
| Dynamic routes (`[uuid]`, `[id]`) misbehave in static export | Medium | High | Each dynamic route gets `generateStaticParams: () => []` + a client shell. SPA fallback in Capacitor's WKWebView routes unknown URLs to the shell. Validated end-to-end in Phase 2. |
| Auth cookie not sent on cross-origin requests from `capacitor://localhost` | **High** | High | Phase 2 verifies `SameSite=None; Secure` on auth cookies and `credentials: 'include'` on all GraphQL fetches. Backend CORS already allows the Capacitor origin. Fallback: store JWT via `@capacitor/preferences` and attach to GraphQL requests as a bearer token. |
| SQLite write queue + WebSocket party state conflict | Medium | High | Phase 5 routes party-mode mutations through the existing real-time WebSocket only (`prefer: 'remote-only'` in the router) — they are never queued. Local mutations are restricted to non-realtime data (ticks, playlists, profile). |
| Local cache drifts from server (stale data) | Medium | Medium | Stale-while-revalidate pattern in TanStack Query refreshes on every focus / pull-to-refresh / online transition. `cache_metadata` table tracks per-table `last_synced_at`; cache TTLs configurable per query. |
| Mutation conflicts on reconnect (server rejects optimistic write) | Medium | Medium | Server-wins policy: failed mutations roll back optimistic local entry, surface error in UI with retry. Validated for ticks (idempotent), queue edits (last-write-wins by client timestamp), and playlist edits (manual conflict prompt). |
| Bundle size grows past App Store reasonable limits | Low | Medium | Static export ships only used JS; refdata SQLite via ODR / Asset Pack stays out of base bundle. Track bundle size in CI. |
| `next/image` regressions in export build | Medium | Low | Custom loader in Phase 1; switch to plain `<img srcset>` for the few cases that need responsive images in-app. |
| Neon → Railway connection-pool sizing | Medium | High | Phase 0a includes load testing during sync runs and party-session bursts. Pool max tunable in Drizzle's `postgres-js` config. |
| GraphQL surface-area growth strains backend | Medium | Medium | Migrate REST → GraphQL endpoint-by-endpoint with tests, not in a big-bang push. Reuse existing GraphQL patterns in `packages/backend/src/`. |
| Refdata sync fails silently and search returns empty | Medium | Medium | Phase 3 surfaces sync state in UI ("Kilter refdata last updated 2 days ago"). On stale > 30 days, prompt user to force-sync. Log to Sentry on failure. |
| PostHog autocapture pollutes telemetry | Low | Low | Configure capture allowlist; review event volume after Phase 6 ships. |

---

## Success Criteria

### Native shell MVP (M0–M3, unchanged from v5.0)

The native MVP ships independently of the v6.0 web migration:

- Native app shell loading the web app with validated auth persistence
- BLE working on iOS (primary motivation) and Android via abstraction layer
- **Embedded SQLite climb database** with offline search (per-board On-Demand Resources)
- Native look and feel (safe areas, status bar, splash screen, haptics)
- Deep linking for party sessions (scoped paths, not entire domain)
- Offline fallback with local climb search + BLE board control

Milestone 3 (App Store submission, ~2 weeks) completes the v1.0 native release.
Push notifications (Milestone 4) ship as a v1.1 update post-launch.

**Native shell timeline: 12-15 weeks** (including app store review cycles, device-specific debugging, and SQLite integration).

### v7.0 offline-first success (Phases 0a–6)

Independent of the native MVP, the v7.0 work is successful when:

- The pinned user story works end-to-end: airplane-mode launch → search → queue → BLE send → tick → reconnect → sync.
- The Capacitor app loads from `capacitor://localhost` (no `https://boardsesh.com` round-trip on launch).
- `next.config.mjs` produces both standalone (web) and export (Capacitor) builds from the same `packages/web` codebase. Both green in CI.
- Postgres + backend + standalone web all run on Railway. Vercel project shut down (or kept for preview deploys, optional).
- All `/api/internal/*` and `/api/v1/*` data routes have moved to GraphQL in `packages/backend`. Auth.js / NextAuth still live in `packages/web` as kept-by-design.
- Cold start in airplane mode reaches the home screen in < 1 second on a mid-tier device.
- Sync queue drains within 10 seconds of regaining network. No duplicate writes, no lost mutations under normal use.
- PostHog receives client + server events; Sentry receives JS + native crashes.

**v7.0 timeline: ~5-6 months.** Critical path for the offline happy path: Phases 1, 2, 3, 5 (~3-4 months). Phase 0a/0b can run in parallel; Phase 4 and 6 expand and polish after the happy path lands.

### Milestone Summary

| Milestone | Duration | Key Deliverable |
|-----------|----------|------------------|
| **Native shell (v5.0 carryover)** | | |
| 0: PoC + Auth         | 2 weeks   | WebView loads, auth works, bridge injection validated |
| 1: BLE Integration    | 2-3 weeks | Native BLE with abstraction layer, no double-chunking |
| 1.5: Embedded DB      | (folded into v7.0 Phase 3) | Per-board SQLite refdata |
| 2: Native Polish      | 1.5 weeks | Safe areas, deep links, haptics, offline UI           |
| 3: App Store          | 2 weeks   | Store submission, beta testing, review cycles         |
| 4: Push (post-launch) | 2-3 weeks | FCM + APNs, device token backend, notification types  |
| **v7.0 offline-first (new)** | | |
| 0a: Hosting cutover     | 2-3 weeks | Postgres on Railway, `postgres-js` client, backend redeployed |
| 0b: REST → GraphQL      | 4-6 weeks | All data routes migrated; Hono carve-outs for OG/webhooks |
| 1: Dual-build pipeline  | 3-4 weeks | Standalone + export from one Next.js codebase |
| 2: Capacitor bundle     | 2 weeks   | App loads bundled assets; airplane-mode launch succeeds |
| 3: Refdata SQLite       | 2 weeks   | Search and climb detail offline (folded v5.0 M1.5) |
| 4: User-data cache      | 3-4 weeks | Profile, ticks, playlists render offline |
| 5: Mutation queue       | 3-4 weeks | Offline ticks → sync on reconnect (happy path complete) |
| 6: Connectivity polish  | 1-2 weeks | Online indicator, sync status, retry UI, onboarding |
| Analytics + obs (rolling) | —        | PostHog + Sentry, runs alongside |

### Performance Targets

| Metric                    | Target                                          |
| ------------------------- | ----------------------------------------------- |
| App launch to interactive | < 3 seconds (depends on network + web app load) |
| BLE connection            | < 5 seconds                                     |
| BLE LED send              | < 1 second                                      |
| Native shell size         | < 10 MB                                         |
| Memory usage              | < 200 MB                                        |

### Platform Requirements

| Platform | Minimum Version                       |
| -------- | ------------------------------------- |
| iOS      | 16.0+ (Capacitor 6 requirement)       |
| Android  | API 33 (Android 13)+ / Target API 34+ |

---

## Appendix

### Dependencies

```json
{
  "dependencies": {
    "@capacitor/core": "^6.0.0",
    "@capacitor/app": "^6.0.0",
    "@capacitor/haptics": "^6.0.0",
    "@capacitor/keyboard": "^6.0.0",
    "@capacitor/push-notifications": "^6.0.0",
    "@capacitor/splash-screen": "^6.0.0",
    "@capacitor/status-bar": "^6.0.0",
    "@capacitor-community/bluetooth-le": "^6.0.0",
    "@capacitor-community/sqlite": "^6.0.0",
    "@capacitor-community/keep-awake": "^6.0.0",
    "@capacitor/network": "^6.0.0"
  },
  "devDependencies": {
    "@capacitor/cli": "^6.0.0"
  }
}
```

### Platform Permissions

**iOS (Info.plist):**

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>Boardsesh needs Bluetooth to connect to your climbing board and control LED holds</string>
<key>NSBluetoothPeripheralUsageDescription</key>
<string>Connect to your climbing board to control LED holds</string>
```

**Android (AndroidManifest.xml):**

```xml
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.BLUETOOTH_SCAN"
    android:usesPermissionFlags="neverForLocation" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<!-- For Android 11 and below -->
<uses-permission android:name="android.permission.BLUETOOTH" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" />
```

### Deep Linking Configuration

**Custom URL Scheme:**

- `boardsesh://party/join/{sessionId}` — Join party session
- `boardsesh://climb/{uuid}` — Open climb detail
- `boardsesh://board/{boardName}/{layoutId}/{sizeId}/{setIds}/{angle}` — Open board config

**Universal Links (iOS) / App Links (Android):**

- `https://boardsesh.com/join/*` → opens app if installed (session invite links only)
- **Do NOT register the entire `boardsesh.com` domain** — this would hijack all links and prevent users from using the website in their browser
- Requires `apple-app-site-association` file on `boardsesh.com` (iOS)
- Requires `assetlinks.json` on `boardsesh.com` (Android)
- Include "Open in browser" option in the app for users who prefer the web

### Capacitor vs Web Feature Matrix

| Feature                       | Web (Chrome)         | Web (Safari iOS)     | Capacitor iOS (hosted, today)  | Capacitor iOS (bundled, Phase 2) | Capacitor Android (bundled) |
| ----------------------------- | -------------------- | -------------------- | ------------------------------ | -------------------------------- | --------------------------- |
| BLE                           | Web Bluetooth        | Not supported        | Native plugin                  | Native plugin                    | Native plugin               |
| Offline Climb Search          | Not available        | Not available        | SQLite (bundled)               | SQLite (bundled)                 | SQLite (bundled)            |
| Offline User Data (Phase 4)   | Not available        | Not available        | Not available                  | **SQLite cache**                 | **SQLite cache**            |
| Offline Writes (Phase 5)      | Not available        | Not available        | Not available                  | **Mutation queue**               | **Mutation queue**          |
| Push Notifications            | Web Push             | Limited              | APNs                           | APNs                             | FCM                         |
| Haptics                       | Not available        | Not available        | Native                         | Native                           | Native                      |
| Deep Links                    | N/A                  | N/A                  | Universal links                | Universal links                  | App links                   |
| Wake Lock                     | Screen Wake Lock API | Not supported        | KeepAwake plugin               | KeepAwake plugin                 | KeepAwake plugin            |
| App Store Presence            | N/A                  | N/A                  | App Store                      | App Store                        | Play Store                  |
| **Cold start to interactive** | < 2s (cached)        | < 2s (cached)        | 2-4s (network)                 | **< 1s (bundled assets)**        | **< 1s (bundled assets)**   |
| **Offline app shell**         | Service worker (TBD) | Service worker (TBD) | Requires network               | **Always available**             | **Always available**        |
| **Real-time party mode**      | WebSocket            | WebSocket            | WebSocket                      | WebSocket (when online)          | WebSocket (when online)     |

---

## Considered Alternatives

Two earlier directions were evaluated and recorded here for posterity. v7.0 picks **Path A** (offline-first on Next.js dual-build).

### Path B: Migrate to TanStack Start (Vite SSR + SPA) — *was v6.0*

The v6.0 direction was to move the entire web stack from Next.js to **TanStack Start** (Vite + TanStack Router + TanStack Query, file-based routing, mature SSR + server functions). One Vite codebase, two builds: SSR for `boardsesh.com`, SPA for Capacitor. It addressed the same offline / cold-start goals as v7.0 plus stack consolidation (escape Vercel gravity, faster dev builds, smaller Capacitor bundle).

**Why deferred:**

- **8-10 weeks of route file rewrites** (Phase D in the v6.0 plan) — `next/link` → TanStack `Link`, `next/navigation` → `useNavigate`, `generateMetadata` → route `meta` exports — on top of the data-layer changes that v7.0 also requires.
- **No marginal benefit for the offline user story.** v7.0 solves cold-start, offline launch, and offline writes on Next.js. The framework migration is stack hygiene, not user value.
- **Stronger argument later if it's still motivated.** Once v7.0 ships and the React Router → file-based routing landscape settles further, the cost/benefit of a framework swap can be reassessed without time pressure.

The v6.0 plan structure (Phases B0, A, B, C, D, E, F, G, H) is preserved in version control history and remains the reference if framework migration is revived.

### Path C: React Native + Tamagui (native shell with WebView surfaces)

Considered as a Spotify-style hybrid: native shell with Tamagui for the critical-path screens (climb list, playlist, profile, queue, search, board canvas), `react-native-webview` embedding `boardsesh.com` for the long tail. True native rendering for gesture-heavy surfaces.

**Why rejected:**

- **Loses 4 months of Capacitor-specific investment** — PR #1509 native tab bar (Capacitor plugin), LiveActivity bridge layer (Capacitor plugin pattern), BLE adapter, native sync code.
- **MUI → Tamagui rewrite for critical screens** — hundreds of components.
- **Two render systems** with auth/cookie sharing across the boundary, two routers (React Navigation + WebView URL routing), theme drift risk.
- **6-8 month timeline** comparable to v7.0's, but with more architectural risk and less of the existing stack carried forward.

Worth revisiting only if WebView gesture/scroll performance becomes a meaningful user complaint after v7.0 ships, and only for the most latency-sensitive surface (board canvas) — not the whole app.

---

_Document version: 7.0_
_Last updated: April 2026_
_Replaces: v6.0 (April 2026) — committed to offline-first via Next.js static export + local-first SQLite cache. v6.0's TanStack Start direction is preserved in "Considered Alternatives" above. v5.0's M0–M4 native shell sections remain authoritative for Capacitor work; v5.0 M1.5 (Embedded DB) is folded into v7.0 Phase 3._

### Changelog (v6.0 → v7.0)

**Direction change:**

- v7.0 commits to **offline-first on Next.js dual-build** instead of migrating to TanStack Start. The same `packages/web` codebase produces a standalone build (Railway, `boardsesh.com`) and a static export build (`output: 'export'`, bundled into Capacitor). Web framework migration deferred — see Considered Alternatives.
- New pinned user story: airplane-mode launch → search → queue → BLE send → tick → reconnect → sync. 80% offline functionality with the happy path of sending climbs to the board fully offline.

**Major additions:**

- New section **"Architectural Pivot to Offline-First (Next.js Dual-Build + Local Cache)"** — query router pattern, SQLite cache for refdata + user data, mutation queue, `boardseshQuery` / `boardseshMutate` API.
- New section **"Why Bundling Next.js Now Works"** — flips the v5.0 / v6.0 "Why not bundling" framing. With REST → GraphQL completing and in-app server components converted to client components, `output: 'export'` becomes viable; the remaining caveats are listed and addressed.
- New section **"Considered Alternatives"** — preserves v6.0 (TanStack Start) and Path C (React Native + Tamagui) as evaluated-and-deferred.

**Revised phases:**

- Replaced v6.0 phases (B0, A–G, H) with v7.0 phases (0a, 0b, 1–6 + cross-cutting). Critical path for the user story: Phases 1, 2, 3, 5.
- Phase 0a (Hosting → Railway) and 0b (REST → GraphQL) carry over from v6.0 — both still useful, both independent of the framework decision.
- Phase 1 (Dual-build pipeline) and Phase 2 (Capacitor bundle switch) replace v6.0's Phase A + Phase F.
- Phase 3 (Refdata SQLite) folds in v5.0 M1.5.
- Phases 4 (User-data cache) and 5 (Mutation queue) are new — they implement the local-first read cache and write queue.

**Revisions:**

- **Package Structure** — `packages/web` stays and gains a second build target. No `packages/web-app`. Backend grows GraphQL surface area as Phase 0b progresses; auth migration to backend Hono becomes optional, not required.
- **Capacitor Bridge Injection** — the "v6.0 bundled SPA mode" subsection becomes "v7.0 bundled mode via Next.js static export." Same conclusions, different bundler.
- **Authentication in WebView** — the Phase C migration to Auth.js in backend becomes optional. NextAuth in `packages/web` keeps working; only the cross-origin cookie behavior from `capacitor://localhost` needs validation.
- **Feature Matrix** — adds rows for "Offline User Data" and "Offline Writes" reflecting Phases 4 + 5.
- **Risks** — replaced v6.0 framework-migration risks with v7.0 export-mode and local-first risks (server component conversion, dynamic-route export caveats, cross-origin cookies, write-queue conflicts, cache staleness).

**Carries over from v6.0:**

- Hosting Migration to Railway (Phase 0a unchanged).
- REST → GraphQL completion (Phase 0b unchanged).
- Analytics & Observability (PostHog + Sentry).

**Carries over from v5.0:**

- Embedded SQLite climb database section, build pipeline, On-Demand Resources / Play Asset Delivery delivery model.
- Native shell Milestones 0–4 (PoC + Auth, BLE, Native Polish, App Store, Push).
- Bluetooth Strategy, BluetoothAdapter interface, MTU negotiation, double-chunking fix.
- Development Workflow, device testing matrix, App Store review considerations.

### Changelog (v5.0 → v6.0) — superseded by v7.0

v6.0 introduced the TanStack Start migration. v7.0 supersedes that direction (see Considered Alternatives) but keeps several v6.0 additions: the Railway hosting move, the REST → GraphQL completion plan, the Analytics & Observability section, the Capacitor bundled-mode bridge-injection notes (now describing Next.js export instead of Vite SPA).

### Changelog (v4.0 → v5.0)

**Major addition:**

- Added "Embedded Climb Database (SQLite)" section — local SQLite database with per-board On-Demand Resources delivery, offline search, delta sync strategy
- New Milestone 1.5: Embedded Climb Database (2 weeks)
- Added `@capacitor-community/sqlite` to dependencies
- Updated timeline from 10-13 weeks to 12-15 weeks
- Updated feature matrix with "Offline Climb Search" row
- Updated hybrid offline strategy table showing online/offline feature availability

### Changelog (v3.0 → v4.0)

**Critical fixes:**

- Added "Capacitor Bridge Injection Strategy" section — explains how plugin JS loads in hosted mode
- Added "Authentication in WebView" section — cookie persistence, WebSocket auth chain, CORS
- Fixed BLE double-chunking bug — adapter's `write()` now owns all transport-level chunking
- Expanded `BluetoothAdapter` interface — `isAvailable()`, `serviceUUIDs` param, MTU negotiation, unsubscribe pattern
- Added "Why Not Local/Bundled Mode" section — documents why static export is infeasible

**High severity fixes:**

- Milestone 0 expanded to 2 weeks — includes auth validation, bridge injection testing, CORS verification, Bluefy banner check
- Milestone 1 expanded to 2-3 weeks — includes chunking fix, device matrix testing
- Added "Development Workflow" section — local dev, BLE testing, debugging, device matrix
- Deep links scoped to specific paths (`/party/*`, `/invite/*`) — not entire domain
- App Store risk upgraded from Medium to High with concrete mitigations

**Medium fixes:**

- Added offline fallback screen and `@capacitor/network` plugin to Milestone 2
- Reordered milestones: App Store submission (M3) before Push Notifications (M4)
- Push notifications expanded to 2-3 weeks and deferred to post-launch v1.1
- Fixed `@capacitor-community/keep-awake` version from ^5.0.0 to ^6.0.0
- Added native Sentry SDKs for crash reporting outside WebView
- Added version handshake between web and native shell
- Timeline updated from 5-6 weeks to 10-13 weeks realistic estimate
