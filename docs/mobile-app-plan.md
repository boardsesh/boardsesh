# Boardsesh Mobile App Distribution Plan (Capacitor)

## Executive Summary

This document describes how Boardsesh ships as native iOS and Android apps using **Capacitor**, and the parallel migration of the web stack off Next.js + Vercel + Neon. v5.0 launched the Capacitor shell pointing at the hosted Next.js app at `https://boardsesh.com`. v6.0 keeps the Capacitor shell strategy intact and adds a coordinated platform migration: the in-WebView web app moves to **TanStack Start** (Vite + TanStack Router + TanStack Query) with two build outputs from one codebase — an SSR build that serves `boardsesh.com` for SEO and OG, and a pure SPA build that ships bundled inside the Capacitor app for sub-second cold start and full offline capability. Hosting consolidates onto **Railway** for Postgres, backend, and the SSR web app. The remaining Next.js REST API surface migrates to **GraphQL** in `packages/backend`, with explicit HTTP carve-outs for auth, OG image generation, and webhooks. Analytics moves to PostHog; Sentry continues to handle errors.

**Why now:** the iOS native shell already drives BLE, LiveActivity, and (in flight, PR #1509) a native tab bar with per-tab WKWebViews — the precursor for swapping the WebView contents from a hosted URL to a bundled SPA. Cold start, hosting cost, offline capability, and a single rendering path drive the change. Each migration phase is independently shippable; there is no big-bang cutover.

**Key advantages preserved:** zero UI rewrite vs. React Native — the same component tree runs in browsers (SSR + hydrated) and in Capacitor (SPA bundle). Native plugins continue to bridge BLE, push, haptics.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Why Capacitor Over React Native](#why-capacitor-over-react-native)
3. [Architectural Pivot to TanStack Start (Vite SSR + SPA)](#architectural-pivot-to-tanstack-start-vite-ssr--spa)
4. [Why Not Bundling Next.js](#why-not-bundling-nextjs)
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

## Architectural Pivot to TanStack Start (Vite SSR + SPA)

**v6.0 change.** The web stack moves off Next.js. The replacement is one Vite-based application built with **TanStack Start** (Vite + TanStack Router + TanStack Query, file-based routing, mature SSR + server functions). One codebase, one router, one component tree — two build outputs:

- **SSR build** → deployed to Railway, serves `boardsesh.com`. Streams HTML for SEO surfaces (homepage, profile, climb detail, playlist, legal/help). Generates OG images via server functions. Hydrates into a normal SPA after first paint for in-app routes.
- **SPA build** (`vite build --mode spa`) → static bundle shipped inside the Capacitor app. No server dependency at runtime, sub-second cold start, full offline once SQLite refdata is loaded.

There is no separate marketing site, no second router config to keep in sync. Every screen is portable; routes opt into SSR / prerender / CSR per their needs.

### Why TanStack Start

- **Mature SSR on Vite (2026).** Server-rendered HTML for crawlers, just like Next.js does today.
- **File-based routing** identical in spirit to Next.js's app router — low cognitive cost during migration.
- **TanStack Query is already in the codebase** (per the rendering audit). Native integration with Start's loader/cache primitives.
- **Server functions** cover the small set of HTTP endpoints that don't belong in the GraphQL backend (OG images, sitemap/robots).
- **Per-route opt-in** to SSR / prerender / CSR. SEO routes stream HTML; board canvas, queue, and settings stay client-only with no SSR overhead.
- **First-class SPA build mode** for Capacitor — not a hack on top of an SSR-only framework.

Alternatives considered and rejected: Astro + a separate Vite SPA (two route trees, drift risk), Vike (more flexible but bring-your-own router puts more on us), Remix / React Router v7 framework mode (viable, but Start integrates TanStack Query natively and the team is already using it).

### Mobile shell trajectory

1. **Today:** single WKWebView at `https://boardsesh.com`, with native BLE / LiveActivity / tab-bar overlays.
2. **After PR #1509 lands:** native `NativeTabBarView` drives a single WKWebView via JS events.
3. **Phase F (this plan):** native tab bar drives **N independent WKWebViews**, each pre-loading the bundled SPA build at a tab-specific entry route. All tabs share one `WKWebViewConfiguration.websiteDataStore` so the Auth.js session cookie flows across tabs. Tab switching becomes instant — no route navigation, just `setActiveTab` on the native side.

### Single rendering path, two builds

```
                    ┌──────────────────────────────────┐
                    │       packages/web-app           │
                    │   (TanStack Start: file routes,  │
                    │   shared component tree,         │
                    │   TanStack Query data layer)     │
                    └──────────┬───────────────────────┘
                               │
                  ┌────────────┴─────────────┐
                  │                          │
          vite build (SSR)          vite build --mode spa
                  │                          │
                  ▼                          ▼
       ┌────────────────────┐     ┌──────────────────────┐
       │  Railway (Node)    │     │  Static SPA bundle   │
       │  boardsesh.com     │     │  shipped inside the  │
       │  SSR + server fns  │     │  Capacitor app       │
       │  (SEO, OG images)  │     │  (per-tab WebView)   │
       └────────────────────┘     └──────────────────────┘
```

---

## Why Not Bundling Next.js

The v5.0 doc analysed bundling Next.js itself (via `output: 'export'`) into Capacitor and rejected it because the Boardsesh app is deeply server-dependent: 33+ API routes, server components with direct DB access, NextAuth, Aurora API proxies, middleware. That analysis still holds — bundling Next.js as-is would require rewriting auth and the data layer.

**v6.0 reframes the conclusion.** Those server dependencies are the reason we are moving the dependent code out of `packages/web` into `packages/backend`:

- Auth → Auth.js core mounted in Hono in `packages/backend`.
- API surface → GraphQL in `packages/backend`, with a small Hono carve-out for OG images, webhooks, and Aurora-cookie-handling proxies.
- Server-rendered metadata → TanStack Start route `meta` exports.
- OG images → `satori` + `@resvg/resvg-js` in either a Start server function or backend Hono — same URL shape preserved.
- Middleware → TanStack Router route loaders for validation; `Cache-Control` from route handlers (Vercel-specific CDN config goes away).

Once those pieces live in the backend, the in-app surface (`packages/web-app`) has no server dependency at runtime. **TanStack Start's SPA build is a first-class output, not a hack** — bundling it inside Capacitor is straightforward. The risks v5.0 raised about a bundled-mode app (auth break, lost SEO, OG image regressions) are addressed by the SSR build path serving the same component tree to crawlers.

---

## Hosting Migration: Vercel + Neon → Railway

The web app and database move off Vercel and Neon onto **Railway** for the v6.0 cycle.

### Target topology

| Component | Today | After migration |
|-----------|-------|------------------|
| Postgres | Neon (serverless WebSocket pool) | Railway Postgres (long-lived) |
| Backend (`packages/backend` — graphql-ws + Hono + Redis pub/sub) | Self-hosted / mixed | Railway |
| Web app SSR (`packages/web-app`) | n/a (today: Next.js on Vercel) | Railway, co-located with backend + DB |
| Capacitor SPA bundle | n/a (today: hosted URL) | Static assets shipped inside the app |
| CDN / edge cache | Vercel | Cloudflare in front of Railway origin (cache headers from route handlers) |

Single vendor, single region, lowest DB latency. SSR routes need backend GraphQL data anyway, so edge SSR wouldn't gain much.

### Cutover sequence

The migration runs as **Phase B0** at the front of the v6.0 work (see [Implementation Milestones](#implementation-milestones)). Order matters:

1. **Database first.** Stand up Railway Postgres + PostGIS. Apply Drizzle migrations. Bulk-copy from Neon (logical replication or `pg_dump | pg_restore` during a brief maintenance window). Verify PostGIS-dependent queries (heatmap, climb stats spatial filters) return identical results.
2. **Switch the DB client.** `packages/db/src/client/` switches the production path from `drizzle-orm/neon-serverless` to `drizzle-orm/postgres-js`. Local dev already uses `postgres-js`, so the schema is proven against that driver. **No schema changes.**
3. **Backend onto Railway.** Redeploy `packages/backend` (graphql-ws + Redis) onto Railway. Update env vars. Verify subscriptions reconnect cleanly.
4. **Existing Next.js stays on Vercel** during this phase, but its `DATABASE_URL` and `BACKEND_URL` point at Railway. No user-visible change.
5. **Web app SSR onto Railway** comes later, in Phase F. By that point the Next.js `packages/web` is being phased out.
6. **DNS cutover** (Phase G): `boardsesh.com` flips from Vercel → Cloudflare → Railway origin. Vercel project shut down.

### Risks specific to this move

- **Connection pool sizing.** Neon's serverless pool auto-scales; Railway is a fixed-size Postgres instance. Validate pool max under load (especially during sync jobs and party-session bursts).
- **PostGIS feature parity.** Confirm the Railway PostgreSQL image includes PostGIS. Run `\dx` and the heatmap/spatial test suite against it before flipping production traffic.
- **Cron / scheduled jobs.** Aurora sync currently runs on a schedule somewhere — confirm the runner location (likely already in `packages/aurora-sync`) and re-point its `DATABASE_URL`. Vercel Cron (if used) needs replacing with Railway-native scheduling or a GitHub Action.
- **Edge cache behavior.** Vercel's automatic asset caching disappears. Set explicit `Cache-Control` on web-app routes and front the origin with Cloudflare.

---

## REST → GraphQL Completion

Per `CLAUDE.md`: *"We are slowly moving away from running rest-apis and backend operations in the next.js service, instead `packages/backend` should implement all backends, ideally using graphql."* v6.0 finishes that migration.

### Inventory and destinations

The current Next.js app exposes ~42 API routes under `packages/web/app/api/`. Default destination for v6.0:

| Group | Count (approx) | Destination |
|-------|---------------:|-------------|
| `/api/internal/*` (data ops, search, sync, ws-auth) | 18 | **GraphQL queries/mutations** in `packages/backend`. Tiny exceptions (e.g. `ws-auth` returning a token) stay as Hono routes. |
| `/api/v1/[board]/*` (public data, grades, slugs, heatmap, climb stats) | 14 | **GraphQL** with the same shape exposed via the GraphQL schema. Preserve URL shape only if external consumers depend on it. |
| `/api/v1/[board]/proxy/*` (login, saveAscent, saveClimb, getLogbook, user-sync) | 4 | **GraphQL mutations** that wrap Aurora calls server-side. Aurora credentials move from Next.js env to backend env. |
| `/api/auth/[...nextauth]`, `register`, `verify-email`, `resend-verification`, `providers-config`, `native/callback` | 6 | **Hono in backend** — OAuth callbacks and email-verification clicks are inherently URL-based. Auth.js core mounted under `/api/auth/*`. |
| `/api/og/*` (4 dynamic image routes) | 4 | **Hono in backend** or Start server function. `satori` + `@resvg/resvg-js`. **Same URL shape preserved** so existing share cards on Discord/Twitter don't invalidate. |
| Webhooks (any external POST receivers) | TBD | **Hono in backend.** |

### Migration discipline

- **GraphQL is the default destination.** A new HTTP route is justified only when GraphQL genuinely can't express the operation: redirect responses (OAuth), binary responses (OG images), incoming webhooks, or browser endpoints that need to be hit before JS loads.
- **Shim during overlap.** Until `packages/web` is decommissioned in Phase G, Next.js keeps thin proxy shims at the old URLs that forward to the backend. This avoids breaking anything that hard-coded an internal route.
- **Sitemap and robots.txt** — re-implement as TanStack Start routes serving the same XML/text. Public-page enumeration logic ports verbatim from `packages/web/app/sitemap.ts`.

---

## Analytics & Observability

v6.0 consolidates analytics on **PostHog** and keeps **Sentry** for errors.

### PostHog

Replaces any current `vercel/analytics` or `gtag` usage.

- **Client side** (`posthog-js`) initialized in the web-app shell — runs in both SSR-hydrated browsers and inside the Capacitor WebView (works in WKWebView and Android WebView). Autocapture for page views, button clicks, form submits.
- **Server side** (`posthog-node`) initialized in `packages/backend` for events that originate server-side (logins, sync runs, error rates, GraphQL operation timings).
- **Identification:** user identify on auth success (both client and server), with anonymous → identified merge. Match the existing user identifier (`user.id` from Auth.js).
- **SSR build-time guard:** stub PostHog during prerender so build-time route generation doesn't fire events.
- **Native shell:** the iOS / Android Capacitor processes can post a thin `app_open` event with platform / shell version via the PostHog Capacitor plugin (or directly via the JS SDK once the WebView is up — whichever is simpler).

### Sentry

Already in JS today; v6.0 keeps and extends it.

- **TanStack Start Sentry integration** — covers SSR errors, server-function errors, and client-side React errors. Same DSN as today.
- **GraphQL backend** — Sentry instrumentation for unhandled errors in resolvers and ws lifecycle.
- **Native iOS / Android Sentry SDKs** — already scheduled in M2 for crashes outside the WebView (BLE plugin crashes, native code crashes, WebView process kills). Same DSN with `platform: ios | android` tag.
- **Source maps** uploaded on every deploy (web-app SSR + SPA bundle + native dSYMs / ProGuard).

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

> **v6.0 note:** `packages/web` (Next.js) is kept until Phase G decommissions it. **`packages/web-app`** (TanStack Start) is added in Phase A and ships both the SSR web build and the Capacitor SPA bundle. `packages/backend` grows a Hono HTTP layer for auth + OG + webhooks alongside the existing graphql-ws server.

```
boardsesh/
├── packages/
│   ├── web/                    # Existing Next.js (decommissioned in Phase G)
│   ├── web-app/                # NEW (Phase A): TanStack Start
│   │                           #   - SSR build → Railway, serves boardsesh.com
│   │                           #   - SPA build → bundled into Capacitor (Phase F)
│   ├── backend/                # Existing graphql-ws + new Hono HTTP layer
│   ├── shared-schema/          # Existing (surface area grows as REST → GraphQL)
│   ├── db/                     # Existing (Phase B0: neon-serverless → postgres-js)
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

### v6.0: Bundled SPA mode (Phase F onward)

The bridge injection rules above apply to **hosted mode** (the WebView loads `https://boardsesh.com`). After Phase F, the Capacitor app ships the SPA bundle as static assets and loads it from `capacitor://localhost`. In that mode:

- **The plugin JS bridge is still injected by the native shell** — the `window.Capacitor` global and `window.Capacitor.Plugins` are available before any JS runs, regardless of hosted vs bundled.
- **The SPA bundle CAN import Capacitor packages directly** from `node_modules` (e.g. `import { BleClient } from '@capacitor-community/bluetooth-le'`) because the bundle ships with the app and there's no bandwidth cost. The `isCapacitor()` guard pattern still applies — the same SPA build also runs in browsers (during dev), where Capacitor packages need to no-op.
- **Per-tab WKWebView**: each tab's WebView gets the same bridge injection. PR #1509's `NativeTabBarView` is responsible for preloading each tab's WebView with its entry route.
- **Migration:** during Phase F, swap the BLE adapter from "access via `window.Capacitor.Plugins.BluetoothLe`" to "import directly from `@capacitor-community/bluetooth-le`." The interface in `packages/web/app/lib/ble/types.ts` (now `packages/web-app/...`) is unchanged.

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

### v6.0: Auth migration to Auth.js in `packages/backend` (Phase C)

NextAuth in `packages/web` migrates to **Auth.js core** mounted in Hono in `packages/backend`. The framework-agnostic Auth.js library is the substrate that NextAuth wraps; mounting it directly in Hono gives the same providers, sessions, and JWT cookie shape without a Next.js dependency.

- **Cookie shape preserved.** `__Secure-next-auth.session-token` (or its Auth.js core equivalent) keeps the same name, JWT contents, and `Set-Cookie` attributes (`HttpOnly`, `Secure`, `SameSite=Lax`). Existing sessions survive the migration.
- **Native OAuth flow unchanged at the user level.** `/auth/native-start` and the `native-oauth` credentials provider move to the backend wholesale. The `com.boardsesh.app://` deep link is unchanged. The Capacitor Browser plugin still opens the external browser; the only difference is which host issues the transfer token.
- **Email sending travels with auth.** Verify-email and password-reset mails currently go through the Next.js auth flow. Confirm the provider during Phase C (Resend / SES / etc.) and re-wire from the backend.
- **Per-tab cookie sharing.** When Phase F splits the app into N WKWebViews, all tabs share one `WKWebViewConfiguration.websiteDataStore`. Validated experimentally before F. `__Secure-` prefix requires HTTPS — works in production (Railway), and local dev gets the same treatment via `cleartext: true` + a relaxed cookie name in dev.
- **WebSocket auth chain** is unchanged: web-app calls a small backend endpoint that reads the cookie via Auth.js's `getServerSession()` equivalent and returns a token to pass to graphql-ws.

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

### v6.0 Web Migration Phases (parallel to / after M0–M4)

The phases below run alongside the Capacitor work above. **M0–M4 still apply to the native shell.** What changes is what runs *inside* the WebView. Each phase below is independently shippable.

| Phase | Duration | Goal |
|-------|----------|------|
| **B0: Infra cutover** | 2-3w | Postgres lifted from Neon to Railway. `packages/db` client switched from `neon-serverless` → `postgres-js`. Backend redeployed to Railway. Vercel `packages/web` keeps running, pointing at Railway DB. No user-visible change; validates the new infra. |
| **A: web-app scaffold** | 4-6w | `packages/web-app` (TanStack Start) exists. SSR build deploys to Railway behind a staging hostname. SPA build produces a static bundle. One end-to-end route (`/you`) at feature parity with the Next.js version. |
| **B: API → GraphQL + backend HTTP** | 4-6w | Remaining Next.js API routes move out of `packages/web`. Default destination: GraphQL in `packages/backend`. Hono carve-outs: Auth.js, Aurora proxy where credentials need cookie handling, OG image generation, WebSocket auth token. Next.js keeps thin shims at old URLs. |
| **C: Auth migration** | 2-3w | NextAuth → Auth.js core mounted in Hono in `packages/backend`. Same JWT cookie shape preserved. Native OAuth deep-link target updated. Email sending (verify, reset) re-wired from backend. |
| **D: Route migration** | 8-10w | Migrate Next.js app routes to web-app in tab order from PR #1509: Boards → Climbs → Queue → You → Feed/Notifications. Each route opts into SSR, prerender, or CSR. Middleware board validation moves to TanStack Router route loaders. |
| **E: SEO + public surfaces** | 2-3w | Homepage, profile, climb detail, playlist pages migrated to web-app SSR routes. Sitemap and `robots.txt` re-implemented as web-app routes. OG image URLs preserved. PostHog wired in (client + server). |
| **F: Capacitor bundle switch** | 2w | Mobile shell ships the bundled SPA build instead of loading `https://boardsesh.com`. Per-tab WKWebView extending PR #1509. Cold start < 1s, airplane-mode flow works end-to-end. |
| **G: Decommission Next.js** | 1-2w | Delete `packages/web`. DNS: `boardsesh.com` → web-app SSR on Railway. Vercel project shut down. |
| **H: Analytics + observability** *(rolling)* | — | PostHog client + server SDKs in place. Sentry SSR + native SDK integration. Runs alongside B–G, not gated. |

**Total v6.0 web-migration scope: ~6 months of focused work**, but each phase is independently shippable with no big-bang cutover. M0–M4 (the native shell) run in parallel and don't block any of these phases.

#### Phase exit criteria

- **B0:** Existing Next.js + backend run against Railway DB without errors. Playwright e2e suite green against staging. PostGIS queries (heatmap, climb stats) verified. Connection-pool sizing confirmed under load (sync runs + party-session bursts).
- **A:** SSR build deploys to Railway staging. SPA build produces a static bundle. `/you` route renders identical in SSR and CSR. Playwright e2e for `/you` passes against both.
- **B:** GraphQL surface covers former REST endpoints. Backend Hono carve-outs reachable via `curl`. Existing tests pass against new GraphQL queries. No regressions in `vp test`.
- **C:** Log in → log out → log in cycle works on web-app (SSR + CSR), Next.js (during overlap), and Capacitor. Cookie persists across app restart. Native OAuth deep link round-trips. Verify-email + password-reset emails arrive.
- **D:** Each tab's web-app route reaches Playwright e2e parity with its Next.js predecessor before traffic flips.
- **E:** SSR HTML for homepage / profile / climb pages contains meaningful content (no spinner-only first render). `lighthouse` SEO score ≥ Next.js baseline. `sitemap.xml` valid. Canonical and OG metadata present. OG image URLs unchanged so existing share cards keep rendering.
- **F:** Capacitor build with bundled assets. Airplane-mode end-to-end (search → queue → BLE send → tick). Deep link → correct tab. LiveActivity still receives queue updates. Cold start < 1s on a mid-tier device.
- **G:** Vercel `packages/web` project deleted. Cost dashboard shows reduction. DNS cutover verified. Old internal URLs return 301 to new locations where applicable.
- **H (rolling):** PostHog dashboards receive client + server events. Sentry continues to receive errors with no DSN drops; native SDKs report crashes outside the WebView.

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

### v6.0 Migration Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------:|-------:|------------|
| Route parity gaps between Next.js and TanStack Start | **High** | Medium | Phase D migrates routes one tab at a time with Playwright e2e parity checks before each traffic flip. Old route stays live until the new one is verified. |
| SEO regression during Phase D / E cutover | Medium | High | Phase E enforces SSR-first-render content (no spinner-only HTML), validates Lighthouse SEO score ≥ Next.js baseline, and preserves OG image URL shape. Sitemap diffed before/after. |
| Auth cookie sharing across per-tab WKWebViews | **High** | High | Validate experimentally **before** Phase F. Single shared `WKWebViewConfiguration.websiteDataStore`. Fall back to JWT-in-`@capacitor/preferences` if data store sharing has edge cases. |
| Neon → Railway connection-pool sizing | Medium | High | Phase B0 includes load testing during sync runs and party-session bursts. Pool max tunable in Drizzle's `postgres-js` config. |
| GraphQL surface-area growth strains backend | Medium | Medium | Migrate REST → GraphQL endpoint-by-endpoint with tests, not in a big-bang push. Reuse existing GraphQL patterns in `packages/backend/src/`. |
| OG image URL shape drift breaks Discord/Twitter caches | Low | Medium | Phase B preserves URL shape for `/api/og/*`. New endpoints proxy through the same paths. Diff OG renders between Next.js and replacement before cutting traffic. |
| Aurora API credentials leak during proxy migration | Low | High | Move credentials to backend env in Phase B; remove from Next.js env on the same PR. Run a secret scan against the codebase before Phase G. |
| TanStack Start SSR runtime issues on Railway | Medium | Medium | Phase A deploys SSR build to a staging hostname on Railway early; soak-test before Phase D traffic ramp. |
| PostHog autocapture pollutes telemetry | Low | Low | Configure capture allowlist; review event volume after Phase E ships. |

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

### v6.0 web migration success (Phases B0–G + H)

Independent of the native MVP, the v6.0 web migration is successful when:

- `packages/web-app` (TanStack Start) is the only web frontend; `packages/web` is deleted (Phase G).
- All API surface lives in `packages/backend`: GraphQL by default, with explicit Hono carve-outs for auth / OG / webhooks.
- Postgres + backend + web-app SSR all run on Railway. Vercel project shut down.
- Capacitor app ships the bundled SPA and cold-starts under 1 second on a mid-tier device (Phase F).
- SEO surfaces (homepage, profile, climb detail) match or beat the Next.js Lighthouse baseline.
- PostHog receives client + server events; Sentry receives JS + native crashes.

**v6.0 timeline: ~6 months** (B0–G run sequentially with overlap; H is rolling).

### Milestone Summary

| Milestone | Duration | Key Deliverable |
|-----------|----------|------------------|
| **Native shell (v5.0 carryover)** | | |
| 0: PoC + Auth         | 2 weeks   | WebView loads, auth works, bridge injection validated |
| 1: BLE Integration    | 2-3 weeks | Native BLE with abstraction layer, no double-chunking |
| 1.5: Embedded DB      | 2 weeks   | SQLite climb database, offline search, delta sync     |
| 2: Native Polish      | 1.5 weeks | Safe areas, deep links, haptics, offline UI           |
| 3: App Store          | 2 weeks   | Store submission, beta testing, review cycles         |
| 4: Push (post-launch) | 2-3 weeks | FCM + APNs, device token backend, notification types  |
| **v6.0 web migration (new)** | | |
| B0: Infra cutover     | 2-3 weeks | Postgres on Railway, `postgres-js` client, backend redeployed |
| A: web-app scaffold   | 4-6 weeks | TanStack Start app, SSR + SPA builds, `/you` parity |
| B: API → GraphQL      | 4-6 weeks | REST surface migrated, Hono carve-outs in place |
| C: Auth migration     | 2-3 weeks | Auth.js in backend, native OAuth deep-link unchanged |
| D: Route migration    | 8-10 weeks | Boards → Climbs → Queue → You → Feed migrated |
| E: SEO + public       | 2-3 weeks | SSR for homepage / profile / climb / playlist; PostHog wired |
| F: Capacitor bundle   | 2 weeks   | Per-tab WKWebViews, bundled SPA, < 1s cold start |
| G: Decommission       | 1-2 weeks | `packages/web` deleted, DNS flipped, Vercel shut down |
| H: Analytics + obs    | rolling   | PostHog + Sentry, runs alongside B–G |

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

| Feature                   | Web (Chrome)         | Web (Safari iOS) | Capacitor iOS (hosted, today)  | Capacitor iOS (bundled, Phase F) | Capacitor Android |
| ------------------------- | -------------------- | ---------------- | ------------------------------ | -------------------------------- | ----------------- |
| BLE                       | Web Bluetooth        | Not supported    | Native plugin                  | Native plugin                    | Native plugin     |
| Offline Climb Search      | Not available        | Not available    | SQLite (bundled)               | SQLite (bundled)                 | SQLite (bundled)  |
| Push Notifications        | Web Push             | Limited          | APNs                           | APNs                             | FCM               |
| Haptics                   | Not available        | Not available    | Native                         | Native                           | Native            |
| Deep Links                | N/A                  | N/A              | Universal links                | Universal links                  | App links         |
| Wake Lock                 | Screen Wake Lock API | Not supported    | KeepAwake plugin               | KeepAwake plugin                 | KeepAwake plugin  |
| App Store Presence        | N/A                  | N/A              | App Store                      | App Store                        | Play Store        |
| **Cold start to interactive** | < 2s (cached)    | < 2s (cached)    | 2-4s (network)                 | **< 1s (bundled SPA)**           | **< 1s (bundled SPA)** |
| **Per-tab WebView**       | N/A                  | N/A              | Single WebView (PR #1509 base) | **N independent WKWebViews**     | Single WebView (Android limitation) |
| **Offline app shell**     | Service worker (TBD) | Service worker (TBD) | Requires network             | **Always available**             | **Always available** |

---

_Document version: 6.0_
_Last updated: April 2026_
_Replaces: v5.0 (March 2026) — added the TanStack Start migration, Railway hosting move, REST → GraphQL completion plan, and PostHog analytics direction. v5.0's M0–M4 native shell sections remain authoritative for Capacitor work._

### Changelog (v5.0 → v6.0)

**Major additions:**

- New section **"Architectural Pivot to TanStack Start (Vite SSR + SPA)"** — single Vite codebase with two build outputs (SSR for web SEO, SPA bundle for Capacitor), replacing both the Next.js stack and the previously considered Astro + SPA split.
- New section **"Hosting Migration: Vercel + Neon → Railway"** — DB and backend cutover sequence, PostGIS verification, connection-pool sizing, cron / scheduled job migration. Single vendor, single region.
- New section **"REST → GraphQL Completion"** — inventory of remaining ~42 Next.js API routes and their default destinations (GraphQL by default, Hono in backend for auth / OG / webhooks).
- New section **"Analytics & Observability"** — PostHog (client + server) replaces Vercel Analytics; Sentry expanded with native iOS / Android SDKs from M2.
- New web-migration phases **B0, A, B, C, D, E, F, G, H** appended to Implementation Milestones. Each independently shippable.
- New v6.0 migration risk table covering route parity, SEO regression, per-tab WebView auth sharing, Neon → Railway pool sizing, GraphQL surface growth, OG URL drift.

**Revisions:**

- "Why Not Fully Local Mode" reframed as **"Why Not Bundling Next.js"** — v5.0's analysis still holds, but the conclusion changes: we move the server-dependent code to `packages/backend` and ship a TanStack Start SPA that has no server dependency at runtime.
- Executive Summary rewritten to cover both the native shell and the web migration.
- TOC updated.
- **Package Structure** updated: adds `packages/web-app`, marks `packages/web` for decommission.
- **Capacitor Bridge Injection Strategy** extended with a **bundled SPA mode** subsection covering Phase F: SPA bundle can import Capacitor packages directly from `node_modules`; per-tab WebViews each get bridge injection.
- **Authentication in WebView** extended with a **Phase C / Auth.js in backend** subsection: cookie shape preserved, native OAuth flow unchanged at the user level, email sending re-wired, per-tab `WKWebsiteDataStore` sharing strategy.
- **Capacitor vs Web Feature Matrix** expanded with `Capacitor iOS (bundled, Phase F)` column, plus rows for cold-start time, per-tab WebView, and offline app-shell availability.
- **Success Criteria** split into "native shell MVP" (unchanged from v5.0) and "v6.0 web migration success" sections, each with their own milestone summary.

**Carries over from v5.0 (no change):**

- Embedded SQLite climb database section, build pipeline, On-Demand Resources / Play Asset Delivery delivery model.
- Native shell Milestones 0–4 (PoC + Auth, BLE Integration, Embedded DB, Native Polish, App Store, Push Notifications).
- Bluetooth Strategy, BluetoothAdapter interface, MTU negotiation, double-chunking fix.
- Development Workflow, device testing matrix, App Store review considerations.

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
