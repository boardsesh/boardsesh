# Boardsesh Mobile App Plan — v11.0

## What this document is

A working plan for the native mobile app. v11.0 refines v10.0's direction with an iOS-native design focus:

1. **Build a React Native (Expo) app for mobile.** The Capacitor WebView approach from v9.x had two structural problems: WebView scroll/animation performance can't match native, and every new iOS/Android capability requires a Capacitor plugin that may not exist. With mobile becoming the primary surface, the app needs to be genuinely native.
2. **Keep Next.js for web.** The 14-week Vite + TanStack Start migration from v9.x was motivated by enabling the Capacitor bundle switch. Without Capacitor, that motivation disappears. Next.js stays deployed on Vercel. No framework migration, no hosting migration, no auth migration on the web side.
3. **Share business logic, not UI.** BLE protocol encoding, queue state machine, GraphQL schema, board configuration, and type definitions live in shared packages. Web and mobile each get the UI layer that's best for their platform.
4. **iOS-native experience.** 75% of users are on iOS. The app uses iOS system colors, SF Symbols, spring animations, haptic feedback, blur effects, and SwiftUI native modules for critical views. The goal is the quality bar set by apps like Things 3, Halide, and Bear — apps that feel like they were written in SwiftUI. No Material Design on iOS.

Everything from v9.x's offline-first design — the query router shape, refdata per board, App Store Plan B — carries forward, implemented natively in React Native instead of through a WebView. See [offline-sync-plan.md](offline-sync-plan.md) for the offline sync architecture (expo-sqlite + custom mutation queue, validated by evaluating WatermelonDB, PowerSync, and RxDB alternatives).

## Non-negotiable: web and Capacitor apps must keep working

The React Native app is additive. The existing web app (Next.js on Vercel) and the existing Capacitor app (`mobile/`) must continue working throughout RN development and after launch. Concrete rules:

1. **No breaking changes to `packages/web/`.** Every PR that touches shared packages or backend must pass the existing web test suite and `vp check`. The web app is the primary product until the RN app reaches feature parity — regressions are not acceptable.
2. **No breaking changes to `packages/backend/`.** The backend serves both web and (eventually) RN clients. New endpoints or schema changes for RN must be additive. Existing GraphQL queries, mutations, and subscriptions must remain unchanged.
3. **No breaking changes to `mobile/` (Capacitor).** The Capacitor app is live in the App Store. It loads `https://www.boardsesh.com` in hosted mode and uses BLE, Live Activity, and deep linking. It must keep working on every deploy. The Capacitor directory is not deleted until the RN app is live in the App Store and users have migrated.
4. **Shared package extraction is additive.** When moving logic from `packages/web/` to `packages/shared/`, the web files must re-export everything from the shared package so downstream imports are unchanged. No import path changes for existing web code.
5. **Backend bearer token auth stays backward-compatible.** The existing Capacitor native OAuth flow (`/auth/native-start`, `/auth/native/exchange`) must keep working. RN reuses the same endpoints — no separate auth path that could break the existing one.
6. **Database schema changes are migration-safe.** Any new tables or columns for RN features use standard additive migrations via `bunx drizzle-kit generate`. No destructive schema changes that would break the web or Capacitor apps.

The Capacitor app (`mobile/`) will be retired only after: (a) the RN app is accepted in both App Store and Play Store, (b) existing Capacitor users have had at least 30 days to update, and (c) analytics confirm <5% of sessions come from the old Capacitor build.

## Pinned user story

A user opens Boardsesh in airplane mode at the gym. They launch the app, browse and search climbs for their board, build a queue, connect via BLE, send climbs to the board (LEDs light up), and tick the ones they sent. Real-time-only features (party mode, comments, others' profiles) show a "needs network" state. When the user reconnects, queued ticks and edits sync to the server. This end-to-end story is the terminal milestone.

## Why React Native (not Capacitor, not Flutter)

### vs Capacitor (v9.x approach)

- **Native UI components** instead of WebView rendering. No scroll jank, no animation limits, no "almost native" feel.
- **Direct platform access.** New iOS/Android features (interactive widgets, app intents, SharePlay, background processing) are available immediately through native modules, not gated on plugin availability.
- **App Store guideline 4.2 risk largely disappears.** A React Native app is genuinely native — there's no WebView wrapper to trigger review flags.
- **Faster path to App Store.** The v9.x plan required completing a 14-week framework migration before the Capacitor bundle switch even started. React Native ships independently of the web.

### vs Flutter

- **Same language and ecosystem.** The team already knows React and TypeScript. No Dart learning curve.
- **Shared business logic.** BLE protocol encoding, queue state machine, GraphQL schema — all existing TypeScript that transfers directly to shared packages. Flutter would require rewriting everything in Dart.
- **Flutter web is not viable** for SEO-heavy pages. We'd still maintain Next.js separately with zero shared code. React Native shares types, logic, and API definitions.

### What we lose

- **Three design languages.** Web uses MUI (Material Design). iOS mobile uses an iOS-native design language (system colors, SF Symbols, spring animations, haptics). Android mobile uses Material 3 adaptation. While the React Native code is ~90% shared between iOS and Android, the visual treatment diverges at the component level. This is intentional — platform authenticity requires platform-specific design.
- **Existing Capacitor work is abandoned.** BLE adapters (~200 lines), Live Activity widget (~500 lines Swift), HealthKit bridge (~100 lines) need reimplementation. This is accepted — the code is small relative to the full app.

## Current state (verified against `main`)

| Area                | Status                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Web app             | Next.js 16.1.6 on Vercel. 47 routes, 68 dynamic route files. Stays as-is.                                                              |
| Backend             | GraphQL-WS + Hono on Railway. 14 resolver domains. Stays as-is.                                                                        |
| Database            | Postgres + PostGIS on Railway. Drizzle ORM. Stays as-is.                                                                               |
| Shared schema       | `packages/shared-schema/` with GraphQL types. Already extracted.                                                                       |
| Board constants     | `packages/board-constants/` with product metadata, LED placements, hold states, grade colors. Already extracted.                       |
| BLE protocol (web)  | Aurora v2/v3 encoding, MoonBoard UART framing in `packages/web/app/components/board-bluetooth-control/`. Pure TypeScript, extractable. |
| Queue reducer (web) | 30+ action handlers, delta-based updates in `packages/web/app/components/queue-control/reducer.ts`. Pure TypeScript, extractable.      |
| Board data (web)    | Board metadata, compatibility checks in `packages/web/app/lib/board-data.ts`, `board-compatibility.ts`. Pure TypeScript, extractable.  |
| Capacitor shell     | `mobile/` directory with iOS + Android projects, BLE adapter, Live Activity widget. Will be replaced.                                  |
| App store metadata  | Full iOS + Android listing text in `mobile/metadata/`. Reusable.                                                                       |
| APNs backend        | Token-based push infrastructure in `packages/backend/src/services/apns/`. Reusable by RN.                                              |

## Architecture

```
packages/
  web/              # Next.js (stays as-is — web, SEO, desktop)
  mobile/           # React Native (Expo) — NEW, replaces Capacitor
  backend/          # GraphQL-WS + Hono backend (unchanged)
  db/               # Drizzle schema + migrations (unchanged)
  shared-schema/    # GraphQL types (unchanged, enhanced)
  board-constants/  # Board metadata, LED placements (unchanged)
  shared/           # NEW: extracted business logic
    ble-protocol/   #   Aurora/MoonBoard encoding, chunking, checksums
    queue/          #   Queue reducer, playlist suggestions
    board-config/   #   Board metadata, compatibility, hold layouts
```

### Data flow

```
┌────────────────── boardsesh.com (Vercel) ──────────────────┐
│  packages/web (Next.js, unchanged)                         │
│   • SSR for SEO surfaces, client components for in-app     │
│   • Imports from packages/shared/ for business logic       │
└────────────────────────────────────────────────────────────┘
         │                                    │
         │ HTTPS GraphQL                      │ WebSocket
         │                                    │
┌────────┴────────── Railway ────────────────┴──────────────┐
│  packages/backend (Hono + graphql-ws, unchanged)          │
│   • GraphQL queries, mutations, subscriptions             │
│   • APNs push (reused by RN via device token registration)│
│   • Auth: NextAuth for web cookies, bearer tokens for RN  │
│                                                            │
│  Postgres + PostGIS + Redis                                │
└───────────────────────────────────────────────────────────┘
         ▲                                    ▲
         │ HTTPS GraphQL                      │ WebSocket
         │ (includes sync pull queries)       │
┌────────┴────────── Mobile ────────────────┴──────────────┐
│  packages/mobile (React Native / Expo)                    │
│   • iOS-native design system (system colors, SF Symbols,  │
│     spring animations, haptics, blur effects)              │
│   • Platform-adaptive: SwiftUI feel on iOS, Material 3    │
│     on Android                                             │
│   • BLE via react-native-ble-plx + shared protocol logic  │
│   • Board rendering via Expo native module (SwiftUI Canvas │
│     on iOS, Compose Canvas on Android)                     │
│   • Offline: expo-sqlite + mutation queue, MMKV for prefs   │
│   • Auth: bearer tokens via expo-auth-session             │
│   • Live Activity via Expo native module (ActivityKit)     │
│                                                            │
│  Local data:                                               │
│   • expo-sqlite (user data + board refdata, full SQL)       │
│   • Pre-warmed SQLite ships with app (all boards)          │
│   • Custom mutation queue for offline writes               │
│   • MMKV for key-value preferences                        │
└───────────────────────────────────────────────────────────┘
```

## Shared business logic — what transfers

These are pure TypeScript modules with no DOM, React DOM, or platform-specific dependencies. They move to `packages/shared/` and are imported by both web and mobile.

### BLE protocol encoding (100% shareable)

**Source files:** `packages/web/app/components/board-bluetooth-control/bluetooth-aurora.ts`, `bluetooth-moonboard.ts`, `bluetooth-shared.ts` (constants + `splitMessages` only)

- Aurora v2/v3 LED position encoding, color quantization, power budget scaling
- MoonBoard hold-to-serial-position mapping, UART frame construction
- Packet wrapping with checksums, message chunking
- Device name parsing (API level, serial number, board type detection)

The `BluetoothAdapter` interface (connect, disconnect, write) stays platform-specific. Web implements it with Web Bluetooth; React Native implements it with `react-native-ble-plx`.

### Queue state machine (100% shareable)

**Source files:** `packages/web/app/components/queue-control/reducer.ts`, `types.ts`, `playlist-suggestions.ts`

- `queueReducer` function — 30+ action handlers, pure reducer
- Delta-based queue updates with idempotent insertion
- Optimistic update tracking via correlation IDs
- Playlist suggestion source management, suggestion pruning

The `useQueueReducer` React hook wrapper stays in each platform's code. The reducer function itself is framework-agnostic.

### Board configuration (100% shareable)

**Source files:** `packages/web/app/lib/board-data.ts`, `board-compatibility.ts`, `moonboard-config.ts`

- Board metadata (names, layout IDs, size IDs, image dimensions)
- Climb-to-board compatibility checks
- MoonBoard grid configuration (11 columns x 18 rows)

### Already extracted

- `packages/shared-schema/` — GraphQL schema, TypeScript types (Climb, ClimbQueueItem, SessionUser, etc.)
- `packages/board-constants/` — Product sizes, LED placements, hold state maps, grade colors
- `packages/shared/queue/` — Pure-TS queue state machine: reducer, sync coordinator, event-to-action mapper, playlist suggestion helpers
- `packages/shared/queue-runtime/` — Transport-wiring helpers around the queue state machine: `mapSubscriptionEnvelopeToAction` (wire-envelope normaliser used by both web and mobile subscription handlers), `createSetCurrentClimbCoalescer` (serialize-and-supersede so rapid swipes don't stack SET_CURRENT_CLIMB mutations), `createJoinSessionTracker` (`(sessionId, epoch)`-keyed JOIN_SESSION promise cache with reconnect invalidation)
- `packages/shared/party-profile/` — `{ id: UUID }` party profile type + `ensureProfile(storage)` helper. Web injects an IndexedDB storage adapter; mobile injects an `expo-secure-store` adapter
- `packages/shared/climb-actions/` — `FavoritesStore` singleton (`useSyncExternalStore`-compatible) backing per-uuid favorite subscriptions on both platforms
- `packages/shared/play-view/` — Play-drawer logic (queue navigation, tick utilities, grade display)
- `packages/shared/board-config/` — Board metadata, hold maps, angle tables, `buildBoardPath`
- `packages/shared/ble-protocol/` — Bluetooth LED control protocol (Aurora + MoonBoard)

### Storage on mobile

Mobile uses two persistence layers, picked deliberately per data class:

- **`expo-secure-store`** — credentials and anything encrypted at rest. Auth tokens, session ids, party profile UUID. Hardware-backed Keychain/Keystore, 2 KB per-value limit.
- **`@react-native-async-storage/async-storage`** — non-secret UI preferences. Metro target list, future feature gates, last-selected values. No encryption, larger per-value limit, the React Native community standard. Use `packages/mobile/src/lib/preference-store.ts` for a typed JSON wrapper.

AsyncStorage is a **native module** (autolinked via Expo). Adding or upgrading it requires a fresh preview build via `vp run mobile:preview-build` — existing testers on `preview-1..4` will see `Native module RNCAsyncStorage is null` after an OTA-only update until they reinstall.

## iOS-first with SwiftUI native modules

75% of Boardsesh users are on iOS. The app uses Expo's native modules API to write performance-critical and platform-defining iOS views in SwiftUI, with Kotlin/Jetpack Compose equivalents for Android. Most screens (climb lists, queue, search, profiles) are standard React Native — shared across both platforms.

### When to use SwiftUI vs React Native

| Use SwiftUI (iOS) / Compose (Android)                              | Use React Native (shared)         |
| ------------------------------------------------------------------ | --------------------------------- |
| Board renderer — GPU-accelerated hold circles via SwiftUI `Canvas` | Climb browsing, filtering         |
| Live Activity widget — ActivityKit requires SwiftUI                | Queue management                  |
| BLE device picker — platform-native list with RSSI + board preview | Social features (party, comments) |
| HealthKit workout logging                                          | Profile, statistics               |
| Settings screen — native grouped list matching iOS Settings app    | Feed, notifications               |
| Board angle selector — SwiftUI circular dial with haptic detents   | Auth screens                      |
| Share sheet — native `UIActivityViewController` integration        | Playlists, logbook                |

The Expo Modules API bridges SwiftUI views into React Native. The same `<BoardRenderer holds={holds} />` JSX component renders a SwiftUI `Canvas` on iOS and a Compose `Canvas` on Android. All platform-specific code lives in the module's `ios/` and `android/` directories — the React Native layer is unaware of which platform is rendering.

This gives iOS users the best possible performance on the most critical views while Android still gets a native equivalent without maintaining a separate app.

## iOS design system

The app does not use a pre-built component library like react-native-paper (Material Design). Instead, it uses a custom iOS-first design system built on React Native primitives and iOS-native libraries. Material Design on iOS creates an uncanny valley — recognizably "not right" to every iPhone user. The goal is the quality bar set by apps like Things 3, Halide, and Bear.

### Design tokens: iOS system alignment

The design system uses iOS semantic colors, not hardcoded values. On iOS, these resolve to Apple's dynamic system colors that automatically adapt to light mode, dark mode, accessibility settings (increased contrast, reduce transparency), and Display Zoom.

| Token                        | iOS mapping                         | Usage                                        |
| ---------------------------- | ----------------------------------- | -------------------------------------------- |
| `colors.background`          | `UIColor.systemBackground`          | Primary background                           |
| `colors.secondaryBackground` | `UIColor.secondarySystemBackground` | Grouped table sections, cards                |
| `colors.tertiaryBackground`  | `UIColor.tertiarySystemBackground`  | Nested content within cards                  |
| `colors.groupedBackground`   | `UIColor.systemGroupedBackground`   | Settings-style grouped lists                 |
| `colors.label`               | `UIColor.label`                     | Primary text                                 |
| `colors.secondaryLabel`      | `UIColor.secondaryLabel`            | Subtitle text, metadata                      |
| `colors.tertiaryLabel`       | `UIColor.tertiaryLabel`             | Placeholder text                             |
| `colors.separator`           | `UIColor.separator`                 | List dividers (with leading inset)           |
| `colors.tint`                | Brand `#8C4A52`                     | App accent color (passed to iOS tint system) |
| `colors.fill`                | `UIColor.systemFill`                | Toggle track, slider fill                    |
| `colors.success`             | Brand `#6B9080`                     | Success states, confirmations                |
| `colors.warning`             | Brand `#C4943C`                     | Warning states                               |
| `colors.error`               | Brand `#B8524C`                     | Error states, destructive actions            |

On Android, these map to Material 3 dynamic color equivalents.

### Typography

System font (`San Francisco` on iOS, `Roboto` on Android) via React Native's default font family. No custom fonts.

| Style         | iOS equivalent | Size | Weight   | Use                               |
| ------------- | -------------- | ---- | -------- | --------------------------------- |
| `largeTitle`  | `.largeTitle`  | 34pt | Bold     | Screen headers (large title mode) |
| `title1`      | `.title`       | 28pt | Bold     | Section headers                   |
| `title2`      | `.title2`      | 22pt | Bold     | Card titles                       |
| `title3`      | `.title3`      | 20pt | Semibold | Subsection headers                |
| `headline`    | `.headline`    | 17pt | Semibold | Climb names, labels               |
| `body`        | `.body`        | 17pt | Regular  | Default text                      |
| `callout`     | `.callout`     | 16pt | Regular  | Secondary content                 |
| `subheadline` | `.subheadline` | 15pt | Regular  | Metadata, timestamps              |
| `footnote`    | `.footnote`    | 13pt | Regular  | Tertiary info, helper text        |
| `caption1`    | `.caption`     | 12pt | Regular  | Badges, small labels              |
| `caption2`    | `.caption2`    | 11pt | Regular  | Minimal annotations               |

**Dynamic Type support is required.** All text uses `allowFontScaling` (default true) and must be tested at all seven accessibility sizes.

### Iconography: SF Symbols

All icons use SF Symbols on iOS (via `expo-symbols`), with Material Symbols fallback on Android. SF Symbols match the system font weight, support variable rendering, and animate natively.

| Action     | SF Symbol                           | Notes                                      |
| ---------- | ----------------------------------- | ------------------------------------------ |
| Search     | `magnifyingglass`                   |                                            |
| Bluetooth  | `antenna.radiowaves.left.and.right` |                                            |
| Queue/list | `list.bullet`                       |                                            |
| Previous   | `chevron.left`                      |                                            |
| Next       | `chevron.right`                     |                                            |
| Favorite   | `heart` / `heart.fill`              | Outlined when inactive, filled when active |
| Settings   | `gearshape`                         |                                            |
| Profile    | `person.crop.circle`                |                                            |
| Tick/Send  | `checkmark.circle.fill`             |                                            |
| Comment    | `bubble.left`                       |                                            |
| Share      | `square.and.arrow.up`               |                                            |
| More       | `ellipsis.circle`                   |                                            |
| Close      | `xmark`                             |                                            |
| Add        | `plus.circle`                       |                                            |
| Playlist   | `folder.badge.plus`                 |                                            |

### Haptic feedback

Every interactive element gets appropriate haptic feedback via `expo-haptics`.

| Interaction                  | Haptic type            | When                                |
| ---------------------------- | ---------------------- | ----------------------------------- |
| Tab switch                   | `selection`            | On tab press                        |
| List item tap                | `light` impact         | On press, before navigation         |
| Button press                 | `light` impact         | On press down                       |
| Toggle switch                | `medium` impact        | On state change                     |
| Swipe action threshold       | `medium` impact        | When swipe crosses action threshold |
| Pull-to-refresh trigger      | `medium` impact        | When pull passes refresh threshold  |
| Long press activate          | `heavy` impact         | When context menu appears           |
| Success (tick saved)         | `success` notification | After tick confirmation             |
| Error (connection lost)      | `error` notification   | On BLE disconnect                   |
| Queue item added             | `success` notification | After add to queue                  |
| Delete confirmation          | `warning` notification | Before destructive action           |
| Climb navigation (prev/next) | `selection`            | On each climb change                |

### Spring animation presets

All animations use spring physics via `react-native-reanimated`'s `withSpring()`, not CSS-style timing functions.

| Preset        | Damping | Stiffness | Mass | Use                                 |
| ------------- | ------- | --------- | ---- | ----------------------------------- |
| `snappy`      | 0.85    | 400       | 0.7  | Button press/release, tab switch    |
| `interactive` | 0.86    | 300       | 1.0  | Drag release, sheet snap            |
| `gentle`      | 0.7     | 200       | 1.0  | Screen transitions, expand/collapse |
| `bouncy`      | 0.6     | 300       | 0.7  | Success celebrations, add-to-queue  |

## iOS interaction patterns

These are the specific interaction behaviors that make the app feel native to iOS users.

### Swipe actions on list items

Climb list items, queue items, and playlist items support swipe actions:

- **Leading swipe**: Add to queue (teal) — matches iOS Mail's gesture language
- **Trailing swipe**: Short swipe = More actions menu. Full swipe = Favorite (rose, heart icon)
- Implementation: `react-native-gesture-handler` `Swipeable` component
- Haptic: `selection` when crossing threshold, `medium` impact on full swipe

### Context menus (long press)

Climb cards, queue items, and playlist items show a native iOS context menu on long press:

- Uses `react-native-context-menu-view` which wraps `UIContextMenuInteraction`
- Shows a blurred preview of the climb card with a menu below
- Menu items with SF Symbol icons: "Add to Queue", "Add to Playlist", "Favorite", "Share", "View Setter"
- Destructive items (Remove, Delete) shown in red with `destructive: true`

### Pull to refresh

All scrollable lists (climb list, queue, feed, profile) support pull-to-refresh via `RefreshControl` with system appearance.

### Scroll behavior

- Lists use `contentInsetAdjustmentBehavior: 'automatic'` for proper safe area handling
- Content scrolls behind the tab bar and navigation bar (translucent bars with blur)
- Rubber-band scrolling is default in React Native on iOS
- Keyboard avoidance uses `KeyboardAvoidingView` with `behavior="padding"` on iOS

### Native share sheet

The share button (SF Symbol `square.and.arrow.up`) triggers `Share.share()` or a native module wrapping `UIActivityViewController` for sharing with custom preview metadata.

## Navigation architecture

The navigation system matches what iOS users expect from a SwiftUI `NavigationStack` + `TabView` app.

### Tab structure

| Tab     | Icon (SF Symbol)          | Root screen         | Notes                       |
| ------- | ------------------------- | ------------------- | --------------------------- |
| Home    | `house.fill`              | Board selection     | User's boards, discover     |
| Search  | `magnifyingglass`         | Climb search/filter | Full search with filters    |
| Queue   | `list.bullet`             | Queue/play view     | Current session, BLE status |
| Profile | `person.crop.circle.fill` | User profile        | Stats, logbook, playlists   |
| More    | `ellipsis`                | Settings & extras   | Settings, about, help       |

**Tab bar implementation:**

- `@react-navigation/bottom-tabs` with a custom `tabBar` component
- Tab bar background: `UIBlurEffect` vibrancy via `@react-native-community/blur` — content scrolls behind a translucent tab bar
- Badge on Queue tab showing item count
- Tab icons use filled variant when active, outlined when inactive

### Navigation patterns per screen type

| Pattern                   | Implementation                                   | Examples                                    |
| ------------------------- | ------------------------------------------------ | ------------------------------------------- |
| Push (drill-down)         | `native-stack` push                              | Board list -> Climb list -> Climb detail    |
| Modal sheet (half-height) | `react-native-bottom-sheet`                      | Queue management, climb actions, tick entry |
| Modal sheet (full-height) | `native-stack` `presentation: 'modal'`           | Climb create, settings sub-pages            |
| Full-screen cover         | `native-stack` `presentation: 'fullScreenModal'` | Play view (board with overlay controls)     |
| Action sheet              | Native `ActionSheetIOS`                          | Destructive actions, share                  |

### Large title headers

Home, Search, Profile, and More tabs use large title navigation headers that collapse to inline when scrolling:

```
headerLargeTitle: true,
headerLargeStyle: { backgroundColor: systemBackground },
headerBlurEffect: 'regular',
headerTransparent: true,
```

**Swipe-to-go-back** is automatic with `native-stack` and must not be disabled on any screen.

### Search bar

The Search tab uses `headerSearchBarOptions` from `react-native-screens`, which renders a native `UISearchController` — it embeds in the navigation header, animates into focus correctly, and handles the cancel button natively.

## What gets rebuilt for React Native

### Board renderer

**Current (web):** SVG + Canvas/WASM with Web Worker pool (2-5 workers), LRU bitmap cache (150 items), lazy loading. Files: `board-renderer.tsx`, `board-canvas-renderer.tsx`, `board-image-layers.tsx`, `worker-manager.ts`, `board-render.worker.ts`.

**React Native:** Expo native module with SwiftUI `Canvas` on iOS and Jetpack Compose `Canvas` on Android. The rendering math (hold position coordinates, color mapping via `HOLD_STATE_MAP`, mirroring transforms) is shareable from `packages/board-constants/` and `packages/shared/`. The rendering engine is platform-native. Fallback: `@shopify/react-native-skia` if the native module approach proves too complex.

**Risk:** This is the highest-complexity rebuild (~40% of total UI effort). Start in Phase 2 and validate 120fps on ProMotion early.

### BLE transport adapter

**Current (web):** `capacitor-adapter.ts` (~200 lines), `native-ios-adapter.ts` (~300 lines), `web-adapter.ts` (~150 lines).

**React Native:** New `BluetoothAdapter` implementation using `react-native-ble-plx`. The adapter is thin — it implements the `requestAndConnect`, `disconnect`, `write` interface. All protocol logic (packet construction, chunking, checksums) comes from `packages/shared/ble-protocol/`.

### Navigation

**Current (web):** Next.js App Router with deeply nested dynamic routes (`/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/...`).

**React Native:** Expo Router (file-based routing) with `@react-navigation/native-stack` for native iOS navigation. The route structure is flatter than web — native apps don't expose URL-style deep nesting to users. Deep links (`boardsesh://climb/<uuid>`, `boardsesh://party/join/<id>`) map to specific screens.

### Auth

**Current (web):** NextAuth with cookie sessions.

**React Native:** `expo-auth-session` for OAuth flows. Bearer token exchange via a new backend endpoint. Tokens stored in `expo-secure-store` (iOS Keychain, Android Keystore). Fetch interceptor attaches `Authorization: Bearer <jwt>`.

The backend already supports bearer token auth for the existing Capacitor native OAuth flow (`/auth/native-start`, `/auth/native/callback`). This infrastructure is reusable.

### Offline storage

**Current (web):** IndexedDB via `idb` package for preferences, drafts, session history, etc.

**React Native:**

- `expo-sqlite` for offline data storage (user ticks, playlists, favorites, board reference data) with full SQL and JOINs. Custom mutation queue for offline writes, sync pull queries for incremental updates. See [offline-sync-plan.md](offline-sync-plan.md) for the full architecture.
- `react-native-mmkv` for key-value preferences (fastest KV store on mobile, synchronous reads)
- App ships with a pre-warmed SQLite database containing all board reference data (~150-200MB). Users select which boards get incremental updates via per-board sync pull.

### Platform features

| Feature            | Current (Capacitor)                  | React Native (Expo)                                                          |
| ------------------ | ------------------------------------ | ---------------------------------------------------------------------------- |
| Board renderer     | Canvas/WASM + SVG                    | Expo native module: SwiftUI `Canvas` (iOS) / Compose `Canvas` (Android)      |
| Live Activity      | Custom Swift widget (~500 lines)     | Expo native module: SwiftUI ActivityKit (iOS only, no Android equivalent)    |
| HealthKit          | Custom bridge (~100 lines)           | Expo native module: SwiftUI HealthKit (iOS) / Health Connect (Android)       |
| BLE device picker  | Capacitor BLE plugin                 | Expo native module: SwiftUI list (iOS) / Compose list (Android)              |
| Settings screen    | Web settings page                    | Expo native module: SwiftUI `Form` (iOS) / React Native (Android)            |
| Angle selector     | Web angle selector component         | Expo native module: SwiftUI dial with haptics (iOS) / React Native (Android) |
| Push notifications | APNs backend (reused)                | `expo-notifications` + existing APNs backend                                 |
| In-app review      | `@capacitor-community/in-app-review` | `expo-store-review`                                                          |
| Wake lock          | `@capacitor-community/keep-awake`    | `expo-keep-awake`                                                            |
| Geolocation        | `@capacitor/geolocation`             | `expo-location`                                                              |
| Shake detection    | `@capacitor/motion`                  | `expo-sensors`                                                               |

## What gets deleted

- `mobile/` — Entire Capacitor directory (iOS/Android projects, config, Swift widgets)
- `packages/web/app/lib/ble/capacitor-adapter.ts` — Capacitor BLE adapter
- `packages/web/app/lib/ble/native-ios-adapter.ts` — Native iOS BLE adapter
- `packages/web/app/lib/ble/capacitor-browser.ts` — Platform detection for Capacitor
- `packages/web/app/lib/capacitor.ts` — `isCapacitor()`, `isNativeApp()` detection
- All Capacitor-specific code paths gated on `isNativeApp()`

The web app's `web-adapter.ts` (Web Bluetooth) stays for browser-based BLE on Chrome desktop.

## What stays unchanged

- `packages/web/` — Next.js on Vercel, all routes, all features. No migration.
- `packages/backend/` — GraphQL-WS backend on Railway. No changes except adding RN-specific auth endpoints if needed.
- `packages/db/` — Drizzle schema + migrations. No changes.
- `packages/shared-schema/` — Types. Enhanced with any new types RN needs.
- `packages/board-constants/` — Board metadata. No changes.

## Phase plan

```
0 Shared extraction ──→ 1 Foundation ──→ 2 Core experience ──→ 3 BLE ──→ 4 Social ──→ 5 Platform ──→ 6 Polish
```

### Phase 0: Shared package extraction (2 weeks)

Extract pure business logic from `packages/web/` to `packages/shared/`:

- `packages/shared/ble-protocol/` — Aurora v2/v3 + MoonBoard protocol encoding, message chunking, device name parsing
- `packages/shared/queue/` — Queue reducer, playlist suggestions, queue types
- `packages/shared/board-config/` — Board data, compatibility checks, MoonBoard config

Update `packages/web/` imports to reference the shared packages. Run `vp check` and `vp run typecheck` to verify nothing breaks. Web app behavior is unchanged.

### Phase 1: Foundation (4 weeks)

- Expo project setup in `packages/mobile/` with Expo Router
- **iOS design system**: semantic color tokens (system colors), typography scale (Apple HIG text styles), spacing scale, spring animation presets, haptic feedback patterns
- **Base component library**: `Text` (with all type style variants + Dynamic Type), `ListRow` (with leading/trailing slots, disclosure indicator, swipe actions), `Card` (with system corner radius + shadow), `SectionHeader`, `Button` (system and filled styles), `Badge`, `Separator` (with leading inset like iOS), `BlurTabBar`, `Sheet` (Gorhom bottom sheet wrapper)
- **SF Symbols icon system** with Material Symbols fallback for Android via `expo-symbols`
- **`useHaptic()` hook** integrated into all interactive base components
- Auth flow: `expo-auth-session` + backend bearer token endpoint (reuse existing `/auth/native-start` flow)
- GraphQL client: TanStack Query + `graphql-request` (same pattern as web)
- **Offline data setup**: configure `expo-sqlite` with pre-warmed database for offline climb browsing. Mutation queue and sync pull client are built in Phase 5. See [offline-sync-plan.md](offline-sync-plan.md).
- Navigation skeleton: bottom tab bar with blur, native-stack navigators per tab, large title headers, search bar on Search tab

### Phase 2: Core climb experience (5 weeks)

- i18n setup: `i18next` + `react-i18next` with shared catalogs from `packages/web/i18n/locales/` (en-US, es, fr). All user-facing strings must go through `t()` — Phase 1 placeholder screens use hardcoded English that must be replaced.
- **Sync backend prerequisites**: `updated_at` columns on 8 tables + auto-update triggers, `sync_deletions` table + per-table trigger functions, idempotent `saveTick`/`createPlaylist` (accept client UUID), new `addFavorite`/`removeFavorite` mutations, sync pull resolvers (10 GraphQL queries with composite cursor). See [offline-sync-plan.md](offline-sync-plan.md).
- Climb browsing with FlashList, swipe actions, context menus
- Board renderer with SwiftUI `Canvas` on iOS — validate 120fps on ProMotion early in week 1
- Climb detail view with board visualization, action sheet
- Queue management with drag-to-reorder (`react-native-gesture-handler`)
- Climb search with native `UISearchController` via `headerSearchBarOptions`
- **Board angle selector** native module (SwiftUI circular dial with haptic detents)
- Pull-to-refresh on all lists
- Climb create form

### Phase 3: BLE + board control (3 weeks)

- `react-native-ble-plx` integration
- `BluetoothAdapter` implementation using shared protocol from `packages/shared/ble-protocol/`
- Device scanning UI via Expo native module (SwiftUI list with RSSI indicators on iOS)
- Connection management, LED control
- Test against physical Kilter, Tension, and MoonBoard hardware
- Background BLE persistence (iOS `CBCentralManager` restoration, Android foreground service)

### Phase 4: Real-time + social (3 weeks)

- WebSocket GraphQL subscriptions (party mode, queue sync)
- Notifications via `expo-notifications` + existing APNs backend
- Feed, profiles, comments
- Party session join/create flow

### Phase 5: Platform features (3 weeks)

- Live Activity widget (iOS lock screen queue navigation) — existing `ClimbSessionLiveActivity.swift` serves as direct reference for the Expo native module
- HealthKit integration (iOS) / Health Connect (Android)
- Offline sync: pre-warmed database build pipeline (GitHub Action), sync pull client, mutation queue, per-board sync toggle UI. See [offline-sync-plan.md](offline-sync-plan.md).
- Push notification token management (reuse existing backend schema)
- **Settings screen** native module (SwiftUI `Form` on iOS)

### Phase 6: Polish + App Store (3 weeks)

- **iOS polish pass**: verify all animations use spring physics, haptics fire correctly on every interaction, Dynamic Type works at all 7 accessibility sizes, VoiceOver accessibility pass
- **120fps validation**: profile on ProMotion devices, identify and fix dropped frames in board renderer and list scrolling
- **Reduce Transparency** and **Increase Contrast** accessibility modes work correctly
- Performance optimization (startup time, list scrolling, board rendering)
- App store submission (metadata already exists in `mobile/metadata/`)
- TestFlight / Play Store beta testing
- Error tracking with Sentry (React Native SDK)
- **App Clips investigation** (stretch goal): lightweight clip that lets users scan a QR code at a gym and browse climbs without installing the full app

### Timeline

| Phase               | Duration | Cumulative |
| ------------------- | -------- | ---------- |
| 0 Shared extraction | 2 weeks  | 2 weeks    |
| 1 Foundation        | 4 weeks  | 6 weeks    |
| 2 Core experience   | 5 weeks  | 11 weeks   |
| 3 BLE               | 3 weeks  | 14 weeks   |
| 4 Social            | 3 weeks  | 17 weeks   |
| 5 Platform features | 3 weeks  | 20 weeks   |
| 6 Polish            | 3 weeks  | 23 weeks   |

**Total: ~23 weeks (~5.5 months) to App Store submission.**

Compare with v10.0: +3 weeks for design system work and iOS polish. Compare with v9.x: ~37 weeks (~9 months) before the Capacitor bundle switch even happened.

## Android strategy

With an iOS-first approach and 75% iOS users, Android must still work well but should not compromise the iOS experience.

### Platform-adaptive design, not lowest-common-denominator

The design system is platform-adaptive at the component level:

| Component    | iOS behavior                                 | Android behavior                                                     |
| ------------ | -------------------------------------------- | -------------------------------------------------------------------- |
| Tab bar      | SF Symbols, blur background, iOS tab style   | Material 3 navigation bar, Material Symbols                          |
| Navigation   | Large title headers, native push, swipe-back | Material 3 top app bar, back arrow                                   |
| Sheets       | Gorhom bottom sheet with iOS snap points     | Same bottom sheet (works well on both)                               |
| Context menu | Native `UIContextMenuInteraction`            | Long-press menu via custom implementation                            |
| Icons        | SF Symbols                                   | Material Symbols (via conditional import)                            |
| Haptics      | Taptic Engine (precise)                      | Android haptic fallback (less precise)                               |
| Blur         | `UIVisualEffectView`                         | Semi-transparent background (blur unreliable across Android devices) |
| Search       | Native `UISearchController`                  | React Native `TextInput` styled for Material                         |
| Colors       | iOS semantic colors                          | Material 3 dynamic color                                             |
| Typography   | San Francisco (system)                       | Roboto (system)                                                      |

Implementation: `Platform.select()` wrapper for each divergent component. The climb list, queue, and board renderer are shared. Navigation chrome, icons, and interaction feedback adapt per platform.

### Quality tier

The explicit goal: a user picking up the iOS app says "this feels like it was made for my phone." A user picking up the Android app says "this is a well-made app." Both are good outcomes. The difference is that iOS gets native context menus, blur effects, SF Symbols, haptic precision, and SwiftUI native modules; Android gets competent cross-platform equivalents.

## Key libraries

| Capability      | Library / Approach                               | Notes                                                                                                  |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Navigation      | `expo-router` + `@react-navigation/native-stack` | Native `UINavigationController` on iOS, large titles, swipe-back                                       |
| Tab bar         | `@react-navigation/bottom-tabs` + custom tab bar | iOS-style blur tab bar, SF Symbol icons                                                                |
| Modal sheets    | `react-native-bottom-sheet` (Gorhom)             | Snap points, gesture-driven, matches iOS sheet behavior                                                |
| BLE             | `react-native-ble-plx`                           | Mature, direct CoreBluetooth/Android BLE                                                               |
| Board rendering | Expo native module (SwiftUI / Compose)           | SwiftUI `Canvas` on iOS, Compose `Canvas` on Android. Fallback: Skia                                   |
| Lists           | `@shopify/flash-list`                            | Drop-in FlatList replacement, 60fps+ scrolling                                                         |
| Storage (KV)    | `react-native-mmkv`                              | Fastest KV store on mobile, JSI-based                                                                  |
| Storage (SQL)   | `expo-sqlite`                                    | Offline climb database + user data, full SQL with JOINs. See [offline sync plan](offline-sync-plan.md) |
| Auth            | `expo-auth-session`                              | Standard OAuth flows                                                                                   |
| Secure storage  | `expo-secure-store`                              | iOS Keychain, Android Keystore                                                                         |
| Live Activity   | Expo native module (SwiftUI ActivityKit)         | iOS lock screen widgets, no Android equivalent                                                         |
| HealthKit       | Expo native module (SwiftUI HealthKit)           | iOS; Android uses Health Connect via same module                                                       |
| Push            | `expo-notifications`                             | APNs + FCM                                                                                             |
| Icons           | `expo-symbols` (SF Symbols)                      | Native Apple iconography on iOS, Material fallback on Android                                          |
| Haptics         | `expo-haptics`                                   | Taptic Engine feedback on all interactive elements                                                     |
| Animations      | `react-native-reanimated` v3                     | Spring-based animations matching iOS system dynamics                                                   |
| Gestures        | `react-native-gesture-handler`                   | Native gesture recognizers, swipe actions, drag-to-reorder                                             |
| Context menus   | `react-native-context-menu-view`                 | Native `UIContextMenuInteraction` with blur preview                                                    |
| Blur effects    | `@react-native-community/blur`                   | Tab bar vibrancy, navigation bar blur, overlay blur                                                    |
| GraphQL         | `@tanstack/react-query` + `graphql-request`      | Same pattern as web                                                                                    |
| Error tracking  | `@sentry/react-native`                           | Crash reporting + performance                                                                          |
| Native modules  | `expo-modules-core`                              | SwiftUI (iOS) + Kotlin/Compose (Android) bridge                                                        |

## Auth design

### Mobile (React Native)

1. User taps "Sign in" → `expo-auth-session` opens system browser for OAuth
2. OAuth provider redirects to `boardsesh.com/auth/callback` (in system browser)
3. Backend issues a short-lived HMAC transfer token, redirects to `boardsesh://auth/callback?token=...`
4. Expo app intercepts the deep link, POSTs the transfer token to `/auth/native/exchange`
5. Backend validates, issues JWT (30d) + refresh token
6. Tokens stored in `expo-secure-store` (Keychain/Keystore)
7. Fetch interceptor attaches `Authorization: Bearer <jwt>` to every request
8. WebSocket `connectionParams` includes the token

**Refresh:** When JWT is within 24h of expiry, the interceptor uses the refresh token to mint a new pair. Failed refresh triggers re-auth.

### Web (unchanged)

NextAuth cookie sessions. No changes to the web auth flow.

### Backend

The existing bearer token infrastructure (used by the current Capacitor native OAuth flow) is reused. The backend already handles:

- Transfer token generation at `/auth/native-start`
- Token exchange at `/auth/native/exchange`
- Bearer token validation in GraphQL resolvers
- WebSocket auth via connection params

New work: ensure the token exchange endpoint returns a proper JWT + refresh token pair (may already be implemented; verify).

## Offline design

See [offline-sync-plan.md](offline-sync-plan.md) for the full offline sync architecture, Sync Rules, write path, and implementation details.

### expo-sqlite + custom mutation queue (Phase 5)

The original offline plan, validated by evaluating three alternatives (WatermelonDB, PowerSync, RxDB — all rejected for different reasons). See [offline-sync-plan.md](offline-sync-plan.md) for the full evaluation and architecture.

- **Pre-warmed database** — app ships with a CI-built SQLite database containing all board reference data (~150-200MB). All boards are browsable offline from first launch. Just a SQLite file — no internal metadata format to worry about.
- **Full SQL with JOINs** — climb search runs as standard SQL against proper columns with covering indexes. < 100ms p95 on 200K climbs. The core reason the alternatives were rejected: RxDB has no JOINs, PowerSync needs synthetic IDs, WatermelonDB needs soft-delete.
- **Mutation queue** — ~300 lines. Offline writes go to a `pending_mutations` table. Queue drainer calls existing GraphQL mutations when online. Idempotent via client-supplied UUIDs.
- **Sync pull** — new GraphQL queries (~8) return records changed since a checkpoint. Per-board selective sync for reference data.
- **Delete handling** — `sync_deletions` table with triggers on user data DELETEs. Existing queries untouched.
- **$0 infrastructure** — no additional services. Syncs via the existing GraphQL API.

### User data sync (Phase 5)

- Ticks, playlists, favorites, follows cached locally in SQLite.
- Offline writes via mutation queue → existing GraphQL mutations when online.
- Sync pull queries fetch changes since last checkpoint.
- Aurora dual-write handled transparently — the existing Aurora sync daemon picks up new ticks.

### Board reference data (pre-warmed + Phase 5 incremental sync)

- Pre-warmed database ships all board reference data as an app asset.
- Per-board sync toggle: enabled boards get incremental updates (new climbs, updated stats).
- "Needs network" state for real-time features (party, comments, feed).

## App Store distribution

### Review notes

> Boardsesh controls climbing-board hardware via Bluetooth Low Energy. The app is built with React Native with native SwiftUI modules for performance-critical views. Key native features:
>
> 1. CoreBluetooth integration for BLE board control (Kilter, Tension, MoonBoard)
> 2. Offline climb database (~150 MB per board, pre-warmed SQLite with per-board incremental sync)
> 3. Live Activity widget showing current climb on the lock screen (SwiftUI ActivityKit)
> 4. HealthKit workout logging for climbing sessions
> 5. Native iOS design: SF Symbols, system colors, spring animations, haptic feedback, Dynamic Type
>
> Demo flow (no physical board needed):
>
> 1. Open the app, select "Kilter"
> 2. Browse and search climbs — results render from the local database
> 3. Tap any climb — detail page shows hold positions and grade
> 4. Long press a climb — native context menu with blur preview appears
> 5. Tap the BLE icon — device picker appears (won't find a board in test environment)

### Plan B if iOS rejected on guideline 4.2

This is much less likely with a genuinely native app using SwiftUI modules, but if it happens:

1. Ship Android first via Play Store
2. Add native onboarding screens highlighting BLE + offline + Live Activity
3. Resubmit with explicit per-feature citations

## Risks

| Risk                                                       | Likelihood | Impact | Mitigation                                                                                                                                                                                                     |
| ---------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Board renderer complexity (Canvas/WASM to SwiftUI/Compose) | Medium     | High   | Start early in Phase 2. Fallback: `@shopify/react-native-skia`, then `react-native-svg`.                                                                                                                       |
| Three design languages to maintain                         | Certain    | Medium | Share everything below UI. Intentional divergence — each platform gets its best experience. ~90% of React Native code is shared between iOS and Android.                                                       |
| react-native-ble-plx maintenance slowdown                  | Medium     | High   | No major release since 2023. Protocol logic is shared; only the transport adapter differs. Backup: `react-native-ble-manager`. Last resort: custom Expo native module with CoreBluetooth/Android BLE directly. |
| Metro bundler + monorepo friction                          | Medium     | Medium | Shared packages use raw TypeScript (`"main": "src/index.ts"`). Metro needs `watchFolders` + `nodeModulesPaths` config. Set up and verify in Phase 1 week 1.                                                    |
| No CI/CD for native builds                                 | Certain    | Medium | EAS Build setup, TestFlight distribution, GitHub Actions integration. Budget 1 week in Phase 1.                                                                                                                |
| Expo ecosystem churn                                       | Low        | Medium | Pin SDK versions. Expo's continuous native generation (CNG) handles native project updates.                                                                                                                    |
| Pre-warmed DB > 200 MB in app bundle                       | Medium     | Medium | Use Play Asset Delivery on Android. App Store allows 200MB cellular. Fallback: per-layout split or lazy-fetch frames on first view.                                                                            |
| Bearer token refresh edge cases                            | Medium     | High   | Dedicated test suite. Failed refresh triggers re-auth, not silent failure.                                                                                                                                     |
| Live Activity reimplementation complexity                  | Medium     | Medium | Defer to Phase 5. Existing Swift widget logic serves as reference. SwiftUI Expo module.                                                                                                                        |
| Phase 5 scope overload                                     | High       | Medium | Phase 5 packs offline sync + Live Activity + HealthKit into 3 weeks. Ship v1 without Live Activity and HealthKit to de-risk. Add them in a fast-follow.                                                        |
| Apple 4.2 rejection                                        | Low        | High   | Native RN app with SwiftUI modules has minimal risk. Plan B above if needed.                                                                                                                                   |
| Custom design system takes longer than a library           | Medium     | Medium | Start with 8-10 base components the app actually needs. Don't build a component library — build what each screen requires. Iterate after Phase 1.                                                              |
| SF Symbols availability in React Native                    | Medium     | Low    | `expo-symbols` is the official Expo module. Fallback: `react-native-sfsymbols`. Worst case: SF Symbol PNGs exported from SF Symbols.app.                                                                       |
| 120fps target on ProMotion hard to achieve                 | Medium     | Medium | SwiftUI `Canvas` handles this natively. FlashList + Reanimated run on the UI thread. If JS thread drops frames, move animations to native driver. Validate in Phase 2 week 1.                                  |
| Context menu library maintenance                           | Low        | Low    | `react-native-context-menu-view` wraps a stable UIKit API. If abandoned, simple enough to wrap in a custom Expo native module.                                                                                 |
| Platform-adaptive components double component count        | Medium     | Medium | Accept this cost. The alternative (one compromised design) is worse. Use `Platform.select()` at the component level, not the screen level. Most screens are ~90% shared code.                                  |
| Spring animation tuning is subjective                      | Medium     | Low    | Define 4 presets (snappy, interactive, gentle, bouncy) in Phase 1 and lock them. Consistency matters more than per-case perfection.                                                                            |
| SwiftUI Settings module adds native maintenance burden     | Low        | Medium | Settings screen is structurally simple (Form + sections). SwiftUI code is ~200 lines. If burdensome, fall back to React Native with grouped list styling.                                                      |
| Android blur effects look bad on some devices              | High       | Low    | On Android, use semi-transparent backgrounds instead of blur. This is standard for cross-platform apps.                                                                                                        |

## Performance targets

| Metric                      | Target                                             |
| --------------------------- | -------------------------------------------------- |
| Cold start to interactive   | < 1.2s on iPhone 13                                |
| Climb search (local SQLite) | < 100ms p95                                        |
| Board renderer FPS          | 120fps on ProMotion, 60fps on standard displays    |
| BLE connection              | < 5s                                               |
| BLE LED send                | < 1s after connect                                 |
| App binary size             | < 30 MB without refdata                            |
| List scrolling              | 120fps on ProMotion, 60fps on standard (FlashList) |
| Navigation transition       | < 16ms frame budget (native stack handles this)    |
| Haptic latency              | < 10ms from gesture to feedback                    |
| Memory (idle)               | < 80 MB                                            |
| Memory (board rendered)     | < 150 MB                                           |

## Platform requirements

|         | Minimum                                    |
| ------- | ------------------------------------------ |
| iOS     | 15.0 (Expo SDK 53 minimum)                 |
| Android | API 24 / Android 7.0 (Expo SDK 53 minimum) |

## Success criteria

| Layer             | Done when                                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared extraction | BLE protocol, queue reducer, board config in `packages/shared/`. Web imports updated. `vp check` passes.                                                                                                          |
| Foundation        | Expo project builds, auth works, navigation skeleton complete (blur tab bar, large titles, search bar), design system tokens defined, haptics hook working, SF Symbols rendering.                                 |
| Core experience   | Climb browsing, search, board visualization, queue management work end-to-end on iOS + Android. Context menus and swipe actions functional on iOS.                                                                |
| BLE               | Connect to physical Kilter/Tension/MoonBoard, send climbs, LEDs light up correctly.                                                                                                                               |
| Social            | Party mode, notifications, feed work via WebSocket subscriptions.                                                                                                                                                 |
| Platform          | Live Activity, HealthKit, offline sync (expo-sqlite + mutation queue), pre-warmed DB pipeline, per-board sync UI, push notifications all functional.                                                              |
| iOS quality       | Dynamic Type works at all 7 sizes. Haptics fire on all interactive elements. Context menus on long press. 120fps on ProMotion in board renderer and lists. Swipe-back on all screens. VoiceOver reads all labels. |
| Android parity    | All features work on Android. Material 3 visual treatment. Context menus via long-press fallback.                                                                                                                 |
| App Store         | Accepted on iOS App Store and Google Play Store. TestFlight beta with 10+ testers.                                                                                                                                |

## Considered alternatives

**Stay on Capacitor (v9.x).** Avoids the React Native learning curve and reuses existing native code. Rejected because WebView performance and native feature access are structural limitations. The 14-week Vite migration was primarily motivated by enabling the Capacitor bundle switch — removing that motivation removes the justification for the migration.

**Flutter.** Best raw performance and excellent BLE support. Rejected because Dart is a completely different language with zero code sharing from the existing TypeScript codebase. Team would need to learn new ecosystem, state management, and testing tools.

**Keep Capacitor, skip Vite migration.** Ship the existing hosted WebView to the App Store. Rejected because hosted mode has the worst App Store rejection risk (guideline 4.2) and the worst offline story.

**React Native + migrate web to Vite anyway.** The Vite migration has independent value (dev speed, no Vercel lock-in). Deferred — the web works fine on Next.js/Vercel today, and the mobile app is higher priority. Can revisit the web framework later if pain accumulates.

**React Native with Material Design UI library (react-native-paper).** Faster initial development because the component library is pre-built. Rejected because 75% of users are on iOS and Material Design creates an uncanny valley on iPhone. Users of apps like Things 3, Bear, and Halide expect iOS-native interaction patterns (swipe actions, context menus, blur, haptics, SF Symbols). A Material Design app on iOS signals "cross-platform compromise" and would not meet the quality bar for App Store editorial consideration.

**React Native with NativeWind / Tailwind CSS.** NativeWind maps Tailwind CSS utilities to React Native styles. Good developer experience but doesn't solve the fundamental problem: iOS-native interaction patterns (context menus, blur effects, native navigation) require native APIs, not CSS-like styling. NativeWind could be used for layout within the custom design system, but it's not a substitute for the component layer.

---

## Changelog

**v11.0 — current.** iOS-native design system, expanded SwiftUI native modules:

- Drop react-native-paper (Material Design). Replace with custom iOS-first design system using system colors, SF Symbols, spring animations, haptics, blur effects.
- Expand SwiftUI native module scope: add settings screen (SwiftUI `Form`), board angle selector (circular dial with haptics), share sheet (`UIActivityViewController`).
- Add iOS design system section: semantic color tokens, Apple HIG typography scale, haptic feedback table, spring animation presets.
- Add iOS interaction patterns section: swipe actions, context menus, pull to refresh, scroll-behind-translucent-bars.
- Add navigation architecture section: 5-tab structure with blur tab bar, large title headers, native search bar, modal sheets.
- Add Android strategy section: platform-adaptive design, quality tier split.
- Update performance targets: 120fps on ProMotion, haptic latency < 10ms, memory budgets.
- Phase 1 extended from 3 to 4 weeks (design system + component library).
- Phase 6 extended from 2 to 3 weeks (iOS polish, accessibility, ProMotion profiling).
- Timeline: 20 weeks → 23 weeks (~5.5 months).

**v10.0.** Direction change from Capacitor to React Native (Expo):

- Drop the Vite + TanStack Start migration (Phase 1 from v9.x)
- Drop the Vercel-to-Railway hosting migration for web (Phase 0a from v9.x)
- Drop the NextAuth-to-arctic+lucia auth migration for web (Phase 0c from v9.x)
- Replace `mobile/` Capacitor project with `packages/mobile/` Expo project
- Extract shared business logic to `packages/shared/` (BLE protocol, queue reducer, board config)
- Timeline reduced from ~37 weeks (v9.x) to ~20 weeks
- Keep Next.js on Vercel for web, unchanged

**v9.2.** PostHog migration sub-plan, Vercel platform inventory gaps.

**v9.1.** Beta subdomain migration strategy, hosted-mode Capacitor compatibility.

**v9.0 — superseded by v10.0.** Committed to Vite + TanStack Start, Railway self-hosting, arctic + lucia auth. 14-week framework migration. 37-week critical path.

**v8.0 and earlier — see git history of this file.**
