# Capacitor + Next.js Feasibility Study

## Executive Summary

**Verdict: Feasible, but requires a hybrid architecture — not a simple wrap-and-ship.**

The biggest win is **native Bluetooth on iOS** (no more Bluefy browser workaround). The biggest cost is that Boardsesh's server-heavy Next.js architecture is fundamentally incompatible with Capacitor's standard static export approach. A pragmatic path exists, but it's not trivial.

---

## Current Architecture Snapshot

| Aspect | Details |
|--------|---------|
| Server Components | Root layout, board layout, page-level data loading |
| Client Components | 282 files with `'use client'` — the majority of the UI |
| API Routes | 37+ endpoints (`/api/auth/*`, `/api/internal/*`, `/api/v1/*`) |
| Dynamic Routes | 5-6 segment deep: `/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/...` |
| Middleware | Board name validation, CDN cache headers, legacy redirects |
| Database | Neon serverless PostgreSQL via Drizzle ORM (server-only) |
| Real-time | GraphQL-WS subscriptions over WebSocket (party/queue sync) |
| Browser APIs | Web Bluetooth, IndexedDB (5 databases), Geolocation, WakeLock |
| Auth | NextAuth.js with Google/Apple/Facebook OAuth + email/password |
| Image Optimization | `next/image` with Sharp (server-side) |
| WASM | Board renderer (`@boardsesh/board-renderer-wasm`) |
| DB Migrations | 70 migration files, 5.5 MB |
| Existing Capacitor code | `capacitor-adapter.ts` for BLE already built and working |

---

## Approach 1: Static Export (`output: 'export'`)

The standard Capacitor approach. Build Next.js to static HTML/JS/CSS, bundle into native binary.

### What breaks

| Feature | Status | Impact |
|---------|--------|--------|
| API Routes (37+ endpoints) | Completely gone | All server data fetching, Aurora proxy, auth endpoints |
| Server Components with dynamic data | Build-time only | No runtime server rendering |
| Dynamic route segments | Must use `generateStaticParams` | Combinatorial explosion: boards × layouts × sizes × sets × angles = millions of combinations. Not viable. |
| Middleware | Gone | No board validation, no cache headers |
| `next/image` optimization | Gone | Must use unoptimized or external loader |
| NextAuth.js | Partially broken | OAuth callbacks need a server; credentials flow needs API routes |
| Aurora API proxy | Gone | Client would need direct Aurora API access (CORS issues) |

### What survives

- All 282 client components render fine in a WebView
- IndexedDB works in Capacitor WebViews
- WebSocket connections to the backend work
- WASM modules load in WebViews
- Client-side routing between pre-built pages

### Verdict: Not viable as-is

The dynamic route explosion alone kills this. You can't pre-generate pages for every board/layout/size/set/angle combination. The app is too server-dependent.

---

## Approach 2: Remote URL (WebView loads hosted app)

Set `server.url` in Capacitor config to point at the hosted Next.js app. The native shell is essentially a browser with native plugin access.

### What works

- **Everything** — full Next.js SSR, API routes, middleware, dynamic routes
- Native BLE via Capacitor plugin (the big win)
- Native push notifications, haptics, app store presence

### Risks

| Risk | Severity | Notes |
|------|----------|-------|
| App Store rejection | **High** | Apple/Google discourage "web wrapper" apps. Apple's guideline 4.2 (Minimum Functionality) is the main threat. Apps must provide functionality beyond what a website offers. |
| Offline unusable | **High** | No network = blank screen. Climbing gyms often have poor WiFi. |
| Capacitor warns against production use | **Medium** | `server.url` docs say "not intended for production" |
| Performance | **Medium** | Every navigation hits the network. Cold start requires server round-trip. |
| Deep linking complexity | **Low** | Universal links need server-side `apple-app-site-association` file |

### Mitigations

- Native BLE + push notifications = real native functionality beyond a website (helps with 4.2)
- Service worker for offline caching of static assets
- Pre-cache common board data in IndexedDB on first load

### Verdict: Viable for MVP, risky long-term

This gets you to the App Store fastest. The BLE plugin alone justifies the native shell for Apple's reviewers. But you're one policy change away from rejection, and the offline story is poor.

---

## Approach 3: Hybrid Architecture (Recommended)

A Capacitor native shell with a **thin local app** for core climbing features, backed by the **hosted Next.js app** for everything else.

### Architecture

```
┌─────────────────────────────────────────────────┐
│                 Native Shell (Capacitor)         │
│                                                  │
│  ┌─────────────────────┐  ┌───────────────────┐ │
│  │   Local Bundle       │  │  Remote WebView   │ │
│  │   (Static Export)    │  │  (Hosted Next.js) │ │
│  │                      │  │                   │ │
│  │  • Board connection  │  │  • Feed           │ │
│  │  • LED control       │  │  • Profiles       │ │
│  │  • Climb viewer      │  │  • Settings       │ │
│  │  • Queue display     │  │  • Auth           │ │
│  │  • Offline browse    │  │  • Search         │ │
│  │                      │  │  • Social         │ │
│  │  SQLite: climb DB    │  │  • Playlists      │ │
│  │  IndexedDB: state    │  │  • Sessions       │ │
│  └─────────────────────┘  └───────────────────┘ │
│                                                  │
│  Native Plugins: BLE, SQLite, Push, Haptics     │
└─────────────────────────────────────────────────┘
```

### How it works

1. **Local bundle**: A stripped-down static React app (could be Next.js static export or plain React) handling board interaction — BLE connection, LED control, climb display, queue. This works offline.

2. **SQLite climb database**: Bundle the climbs/holds/layouts/grades tables into an on-device SQLite database. This is the read-heavy, rarely-changing data (~millions of climbs). Sync periodically from the server.

3. **Remote WebView**: For social features, auth, playlists, feed, profiles — load the hosted Next.js app in a WebView. These features require network anyway (you can't see other people's ticks offline).

4. **Shared auth**: Use a token-based bridge. The native app authenticates via the hosted app, stores the token locally, and passes it to both the local bundle and remote WebView. You already have `/api/auth/native/callback` and `/api/auth/native-oauth-transfer` built for this.

5. **WebSocket backend**: The existing GraphQL-WS backend works from both local and remote contexts. Party mode, queue sync — all work over WebSocket.

### What needs building

| Component | Effort | Notes |
|-----------|--------|-------|
| SQLite climb database export pipeline | Medium | Export Kilter/Tension/MoonBoard climb data from PostgreSQL to SQLite. ~18 tables. Need periodic sync mechanism. |
| Local climb viewer/browser | Medium | Static React app that queries SQLite instead of API routes. Reuse existing client components (they're already client-side). |
| Navigation bridge (local ↔ remote) | Small | Detect which routes should load locally vs remotely. Capacitor's `WebView` API can handle this. |
| Auth token bridge | Small | Already partially built (`native-oauth-transfer`). Store JWT in Keychain/Keystore. |
| Periodic sync service | Medium | Background job to pull new climbs/grades from the server to local SQLite. Delta sync by timestamp. |
| Push notifications | Small | `@capacitor/push-notifications` + server-side push via existing notification system. |
| App Store assets | Small | Screenshots, descriptions, privacy labels. |

### Database bundling details

**What goes in SQLite (read-heavy, changes rarely):**
- `board_climbs` — climb definitions, frames, edges, difficulty
- `board_holds` — hold positions per layout
- `board_layouts`, `board_sizes`, `board_sets` — board configuration
- `board_grades`, `board_difficulty_grades` — grade mappings
- `board_climb_stats` — aggregate stats (synced periodically)
- `board_products`, `board_walls` — hardware definitions

**What stays server-only (write-heavy, social):**
- User accounts, sessions, auth
- Ascents/ticks (write-heavy, user-specific)
- Playlists, favorites, follows
- Comments, votes, proposals
- Notifications, feed
- Party sessions, queue state

**Estimated SQLite size:** Based on the PostgreSQL schema, ~50-200 MB per board type for all climbs + holds + stats. This is large for an app bundle but acceptable for a climbing app where users expect rich offline data. Could ship a base dataset and download board-specific data on first use.

### Climb data sync strategy

```
Initial install:
  1. App ships with no climb data
  2. User selects their board(s) during onboarding
  3. Download board-specific SQLite file from CDN (~50-100 MB per board)
  4. Store in app's documents directory

Ongoing sync:
  1. On app open (if connected), check server for lastSyncTimestamp
  2. Pull delta: new/updated climbs since last sync
  3. Apply to local SQLite
  4. Typical delta: <1 MB (new climbs added daily)
```

---

## The iOS Bluetooth Win

This is the single strongest argument for going native. Currently:

- **Web**: Chrome on Android has Web Bluetooth. Safari on iOS does **not**.
- **Workaround**: iOS users must download Bluefy, a third-party browser. Poor UX, confusing, limits adoption.
- **With Capacitor**: `@capacitor-community/bluetooth-le` uses CoreBluetooth directly. BLE works on every iOS device. No workarounds.

You've already built `packages/web/app/lib/ble/capacitor-adapter.ts` with full MTU negotiation, chunked writes, and disconnect handling. This code is production-ready.

---

## Alternatives Considered

### React Native / Expo

- **Pro**: True native UI, massive ecosystem, proven at scale
- **Con**: Complete rewrite. Zero code sharing with the Next.js web app. Two codebases to maintain. For a small team, this doubles the work permanently.

### Tauri v2

- **Pro**: Lightweight, Rust-powered, mobile support added in v2
- **Con**: Mobile support is still maturing (early 2026). Smaller plugin ecosystem than Capacitor. Rust knowledge required for native extensions. BLE plugin ecosystem is thin.

### PWA (Progressive Web App)

- **Pro**: No app store needed, works today, installable on Android
- **Con**: Still no Web Bluetooth on iOS Safari. Apple's PWA support remains limited (no push on iOS 16, limited background sync). Doesn't solve the core problem.

### Capacitor is the pragmatic choice

It's the only approach that lets you reuse the existing web codebase while gaining native BLE on iOS. The tradeoff is architectural complexity in the hybrid approach.

---

## Effort Estimate

| Phase | Scope | Rough Size |
|-------|-------|------------|
| **Phase 1: Remote-only MVP** | Capacitor shell + BLE plugin + hosted Next.js | 1-2 weeks |
| **Phase 2: SQLite climb data** | Export pipeline + local climb browser + sync | 3-4 weeks |
| **Phase 3: Offline core** | Queue display, climb viewer work offline | 2-3 weeks |
| **Phase 4: Polish** | Push notifications, deep links, app store submission | 1-2 weeks |

Phase 1 alone solves the iOS Bluetooth problem and gets you into the App Store.

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Apple rejects "web wrapper" | Medium | Phase 1 ships native BLE (real native functionality). Phase 2 adds offline SQLite. Both differentiate from a pure website. |
| SQLite sync complexity | Medium | Start simple: full download per board, then add delta sync. Climbs are append-mostly. |
| WebView performance on older devices | Low | The app already runs in mobile browsers. Capacitor's WKWebView is faster than Safari. |
| Capacitor plugin maintenance | Low | `bluetooth-le` and `sqlite` are the most active community plugins. |
| Two UI contexts (local + remote) | Medium | Share design tokens and MUI theme. Use the same component library. |
| App Store review time | Low | Standard 1-3 day review for new apps. |

---

## Recommendation

**Start with Phase 1 (remote-only + native BLE).** This is the minimum viable native app:

1. Create a Capacitor project wrapping the hosted boardsesh.com
2. Wire up `@capacitor-community/bluetooth-le` (adapter already written)
3. Add native OAuth flow (endpoints already exist)
4. Ship to TestFlight / Google Play internal testing

This validates the approach with minimal investment. If Apple approves it and users want offline features, proceed to Phase 2 (SQLite bundling).

**Do not attempt static export of the full Next.js app.** The architecture is too server-dependent. The hybrid approach (local core + remote social) is the right balance.
