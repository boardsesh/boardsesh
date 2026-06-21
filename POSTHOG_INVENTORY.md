# PostHog Event Instrumentation Inventory - Boardsesh

## Executive Summary

Boardsesh has comprehensive PostHog instrumentation across both web (Next.js) and backend (Node.js) packages. Events are captured client-side via `track()` helper and server-side via `captureBackendEvent()`. Analytics is dual-layered: Vercel Analytics as primary, PostHog as secondary via hostname-gated reverse proxy.

**Total Web Events: 89 unique event names across 119+ track() call sites**
**Backend Events: 5 event types for Live Activity tracking**
**Key Infrastructure:**

- Client: PostHog JS Lite, localStorage persistence, IndexedDB-backed anonymous IDs
- Server: PostHog Node SDK with configurable flush/timeout
- Proxy: `/api/posthog` reverse proxy to `us.i.posthog.com`
- Identity: Anonymous → Authenticated merge via `alias()` on login

---

## 1. Client-Side Analytics Infrastructure

### Analytics Initialization

**File:** `/packages/web/app/lib/analytics.ts` (149 lines)

- **Hostname gating:** Only `boardsesh.com` writes to production PostHog
- **Persistence:** localStorage (with documented exception for IDB due to posthog-js-lite SDK limitation)
- **SDK:** PostHog JS Lite with `autocapture: false` (manual capture only)
- **Proxy:** Points to backend reverse proxy at `${backendUrl}/api/posthog` for first-party cookies

### Core Analytics Functions

- `track(name, properties?, options?)` — Wraps Vercel + PostHog capture
- `identify(distinctId, properties?)` — Sets authenticated user ID
- `setPersonProperties(set?, setOnce?)` — Upserts person properties
- `alias(newId)` — Creates $create_alias event for anonymous→auth merge
- `pageview(url)` — Captures $pageview with sanitized pathname
- `capturePosthog(name, properties)` — PostHog-only bypass

### Server-Side Analytics

**File:** `/packages/web/app/lib/analytics.server.ts`

- Thin wrapper around Vercel Analytics Server (no backend event capture from server components)

### Identity & Lifecycle

**File:** `/packages/web/app/components/party-manager/party-profile-context.tsx`

- **Anonymous ID:** IndexedDB-backed `party-profile.id` (UUID)
- **Authenticated ID:** `session.user.id`
- **Alias Flow:**
  1. On mount: `identify(profileId)` with anonymous UUID
  2. On login: `alias(userId)` to merge, then `identify(userId, { email })`
  3. Dedupe via localStorage `posthog-aliases` to prevent double-alias on reload
- **Person Properties:**
  - `email` (on login)
  - `language` (synced on locale change via `setPersonProperties()`)
  - `signup_at`, `signup_auth_method` (first-touch, set on signup)

---

## 2. Web Events - Grouped by Domain

### 2.1 Authentication & Identity (7 events)

| Event Name               | File:Line                                          | Properties                                 | Context                                     |
| ------------------------ | -------------------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| Login Attempted          | auth-page-content.tsx:106                          | `auth_method` (credentials/oauth)          | User clicked login button                   |
| Login Failed             | auth-page-content.tsx:72,116                       | `auth_method`, `failure_reason`            | Credentials invalid or OAuth error          |
| Login Succeeded          | auth-page-content.tsx:122,198                      | `auth_method`, `is_first_login` (optional) | Login completed, redirect firing            |
| Signup Completed         | auth-page-content.tsx:160                          | `auth_method`, `requires_verification`     | Registration form submitted                 |
| Login Attempted (Social) | social-login-buttons.tsx:88                        | `auth_method` (google/github/etc)          | OAuth button clicked                        |
| Login Succeeded (Party)  | party-profile-context.tsx:104                      | `auth_method`, `flow` (OAuth provider)     | OAuth flow completed (server-side redirect) |
| Logout                   | user-drawer.tsx:221, delete-account-section.tsx:99 | `method`                                   | User clicked logout                         |

### 2.2 Climb Management (15 events)

| Event Name                        | File:Line                                                          | Properties                                                                                                            | Context                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Climb Created                     | create-climb-form.tsx:900                                          | `boardLayout`, `isDraft`, `holdCount`                                                                                 | User saved new climb                                                                                                                      |
| Climb Updated                     | create-climb-form.tsx:863                                          | `boardLayout`, `isDraft`, `holdCount`                                                                                 | User edited existing climb                                                                                                                |
| Climb Create Failed               | create-climb-form.tsx:932                                          | `error_message`, `boardLayout`                                                                                        | Save attempt failed                                                                                                                       |
| Climb Forked                      | use-climb-actions.ts:100                                           | `fromClimbUuid`, `boardLayout`                                                                                        | User created copy of climb                                                                                                                |
| Draft Edited                      | fork-action.tsx:58                                                 | (same as Fork)                                                                                                        | User edited draft version                                                                                                                 |
| Climb Info Viewed                 | use-climb-actions.ts:88                                            | `climbUuid`, `boardLayout`                                                                                            | User opened climb details. WEB-ONLY now — mobile retired this; mobile climb-view opens fire `Play Drawer Opened` with `source: climb_view`. |
| Climb Shared                      | use-climb-actions.ts:196,204                                       | `climbUuid`, `boardLayout`, `method` (native/clipboard)                                                               | User shared via web share or copy                                                                                                         |
| Mirror Climb                      | use-climb-actions.ts:174                                           | `climbUuid`, `boardLayout`                                                                                            | User flipped climb horizontally                                                                                                           |
| Set Active Climb                  | QueueContext.tsx:598,740,862; queue-bridge-context.tsx:270,389,536 | `climbUuid`, `boardType`, `layoutId`, `source` (setCurrentClimb / setCurrentClimbQueueItem / takeControl / bridge.\*) | User activated a climb (any UI path — button, queue nav, list tap, swipe, playlist, browse). Fired centrally from queue context mutators. |
| Climb List Row Clicked            | climbs-list.tsx:419                                                | `climbUuid`                                                                                                           | User tapped climb in list view                                                                                                            |
| Open in Aurora App                | use-climb-actions.ts:160                                           | `climbUuid`, `boardLayout`                                                                                            | User clicked "open in app"                                                                                                                |
| Create Climb Set Active           | create-climb-form.tsx:747                                          | `boardLayout`                                                                                                         | User toggled active during create                                                                                                         |
| Create Climb Heatmap Shown/Hidden | create-climb-form.tsx:1346                                         | `boardLayout`                                                                                                         | User toggled heatmap overlay                                                                                                              |
| Beta Video Added                  | attach-beta-link-form.tsx:137                                      | `boardType`, `climbUuid`, `platform` (youtube/vimeo)                                                                  | User attached beta video link                                                                                                             |
| Beta Video Link Clicked           | boardsesh-beta-card.tsx:56                                         | `boardType`, `climbUuid`, `platform`                                                                                  | User clicked embedded video                                                                                                               |

### 2.3 Logbook / Ticks / Ascents (6 events)

| Event Name          | File:Line                 | Properties                                                     | Context                          |
| ------------------- | ------------------------- | -------------------------------------------------------------- | -------------------------------- |
| Tick Button Clicked | tick-button.tsx:63        | `climbUuid`, `boardLayout`                                     | User opened quick tick modal     |
| Tick Logged         | logascent-form.tsx:166    | `climbUuid`, `boardLayout`, `attemptType` (send/flash/project) | User submitted full logbook form |
| Tick Save Failed    | logascent-form.tsx:176    | `climbUuid`, `error_message`                                   | Save attempt failed              |
| Quick Tick Saved    | use-tick-save.ts:166      | `climbUuid`, `boardLayout`, `attemptType`                      | Quick tick modal submitted       |
| Quick Tick Failed   | use-tick-save.ts:178      | `climbUuid`, `error_message`                                   | Quick save failed                |
| Logbook Row Clicked | logbook-feed-item.tsx:449 | `climbUuid`                                                    | User tapped logbook entry        |

### 2.4 Queue Management (11 events)

| Event Name              | File:Line                                     | Properties                                                                                     | Context                                                        |
| ----------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Add to Queue            | queue-button.tsx:39, use-climb-actions.ts:138 | `climbUuid`, `boardLayout`, `source` (optional)                                                | User added climb to session queue                              |
| Remove from Playlist    | playlist-action.tsx:103                       | `climbUuid`, `playlistName`                                                                    | User removed from saved playlist                               |
| Add to Playlist         | playlist-action.tsx:111                       | `climbUuid`, `playlistName`                                                                    | User added to saved playlist                                   |
| Create Playlist         | playlist-action.tsx:162                       | `playlistName`, `boardLayout`                                                                  | User created new playlist                                      |
| Queue Cleared           | layout-client.tsx:64,28                       | `source` (optional)                                                                            | User cleared session queue                                     |
| Queue Navigation        | play-view-drawer.tsx:569+                     | `direction` (next/prev), `source` (optional)                                                   | User navigated queue via button                                |
| Play Mode Navigation    | play-view-client.tsx:114,126                  | `direction` (next/prev), `source`                                                              | User swiped between climbs in play mode                        |
| Queue Operation         | queue-metrics.ts:27                           | `operation` (setCurrentClimb/addToQueue/etc), `durationMs`, `mode` (local/party/party-offline) | Queue state changed (throttled to 5 per operation per session) |
| Queue Operation Error   | queue-metrics.ts:38                           | `operation`, `mode`                                                                            | Queue operation failed (max 10 per session)                    |
| Play Drawer Opened      | queue-control-bar.tsx:802                     | `climbUuid`, `boardName`, `layoutId`, `source` (`climb_view` / `current_queue_item` / `mobile`) | User opened the play drawer (`climb_view` = real climb-view; `current_queue_item` = queue-nav/accessory tap; `mobile` = default) |
| Session Queue Generated | start-sesh-drawer.tsx:613                     | `count` (queue items generated)                                                                | Workout generator produced queue                               |

### 2.5 Board Search / Filtering (9 events)

| Event Name                 | File:Line                       | Properties                             | Context                         |
| -------------------------- | ------------------------------- | -------------------------------------- | ------------------------------- |
| Climb Search Performed     | ui-searchparams-provider.tsx:54 | `query`, `boardLayout`                 | User submitted search text      |
| Search Hold Filter Changed | climb-search-form.tsx:212       | `boardLayout`, `selectedHolds` (array) | User tapped hold in heatmap     |
| Search Hold Filter Cleared | climb-search-form.tsx:228       | `boardLayout`                          | User reset hold filter          |
| Search Zone Enabled        | climb-search-form.tsx:283       | `boardLayout`                          | User toggled zone search on     |
| Search Zone Cleared        | climb-search-form.tsx:291       | `boardLayout`                          | User cleared zone selection     |
| Search Zone Mode Changed   | climb-search-form.tsx:304       | `boardLayout`, `mode`                  | User toggled between zone types |
| Search Zone Updated        | climb-search-form.tsx:355       | `boardLayout`, `zoneName`              | User edited zone bounds         |
| Heatmap Shown/Hidden       | climb-search-form.tsx:484       | `boardLayout`                          | User toggled heatmap in search  |
| View Mode Changed          | climbs-list.tsx:385             | `mode` (grid/list)                     | User switched list view type    |

### 2.6 Playlist / Workout Generator (8 events)

| Event Name                         | File:Line                         | Properties                                 | Context                           |
| ---------------------------------- | --------------------------------- | ------------------------------------------ | --------------------------------- |
| Workout Generator Opened           | playlist-generator-drawer.tsx:88  | `boardLayout`                              | User clicked AI generator button  |
| Workout Type Selected              | playlist-generator-drawer.tsx:106 | `workoutType` (endurance/strength/etc)     | User chose workout profile        |
| Workout Generator Back Clicked     | playlist-generator-drawer.tsx:117 | `fromStep`                                 | User clicked back in generator    |
| Workout Generator Cancelled        | playlist-generator-drawer.tsx:133 | (no properties)                            | User closed generator             |
| Workout Generator Generate Clicked | playlist-generator-drawer.tsx:225 | `boardLayout`, `workoutType`               | User clicked generate button      |
| Workout Generated                  | playlist-generator-drawer.tsx:287 | `boardLayout`, `workoutType`, `climbCount` | AI playlist generated             |
| Create Playlist (via drawer)       | create-playlist-drawer.tsx:122    | `playlistName`, `boardLayout`              | User created playlist from drawer |
| Liked Climbs Add All To Queue      | liked-climbs-view-content.tsx:102 | `count`                                    | User bulk-added liked climbs      |

### 2.7 Navigation / UI (15 events)

| Event Name                             | File:Line                                         | Properties                                                                     | Context                            |
| -------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| Bottom Tab Bar                         | bottom-tab-bar.tsx:182+                           | `tab` (home/climbs/library/feed/create/you), `action` (open_selector optional) | User tapped tab                    |
| View Mode Changed (Liked)              | liked-climbs-list.tsx:190                         | `mode`                                                                         | User switched liked climbs view    |
| Infinite Scroll Load More              | climbs-list.tsx:392                               | `boardLayout`, `offset`                                                        | User scrolled down to load more    |
| Liked Climbs Infinite Scroll Load More | liked-climbs-list.tsx:239                         | `boardLayout`, `offset`                                                        | Liked climbs pagination            |
| Liked Climb Card Clicked               | liked-climbs-list.tsx:268                         | `climbUuid`                                                                    | User tapped liked climb            |
| Logbook Thumbnail Clicked              | logbook-feed-item.tsx:473                         | `climbUuid`                                                                    | User tapped logbook photo          |
| Angle Changed                          | angle-selector.tsx:80                             | `angle` (degrees), `boardLayout`                                               | User rotated board view            |
| App Install Click                      | home-page-content.tsx:208,230                     | `platform` (ios/android), `source` (app-store/google-play)                     | User clicked app store link        |
| Favorite Toggle                        | use-climb-actions.ts:122, favorite-action.tsx:45+ | `climbUuid`, `boardLayout`, `isFavorited` (true/false)                         | User liked/unliked climb           |
| Onboarding Tour Started                | onboarding-tour-provider.tsx:188                  | `durationSeconds`                                                              | User started first-time experience |
| Onboarding Tour Step Viewed            | onboarding-tour-provider.tsx:167                  | `stepName`, `stepIndex`                                                        | User saw step in tour              |
| Onboarding Tour Step Advanced          | onboarding-tour-provider.tsx:153                  | `stepName`, `stepIndex`                                                        | User progressed to next step       |
| Onboarding Tour Completed              | onboarding-tour-provider.tsx:233                  | `durationSeconds`, `totalSteps`                                                | User finished tour                 |
| Onboarding Tour Skipped                | onboarding-tour-provider.tsx:260                  | `skippedAtStep`, `durationSeconds`                                             | User closed tour early             |
| Favorite Toggle (via button)           | favorite-button.tsx:59,83                         | `climbUuid`, `isFavorited`                                                     | Quick favorite button              |

### 2.8 Bluetooth / Hardware (10 events)

| Event Name                              | File:Line                              | Properties                                                        | Context                                             |
| --------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| Bluetooth Connection Success            | use-board-bluetooth.ts:390             | `boardLayout`                                                     | Device paired and connected                         |
| Bluetooth Connection Failed             | use-board-bluetooth.ts:415             | `boardLayout`                                                     | BLE connection attempt failed                       |
| Bluetooth Disconnected                  | use-board-bluetooth.ts:181,371,455,480 | `boardLayout`, `reason`                                           | Device lost connection                              |
| Climb Sent to Board Success             | bluetooth-context.tsx:106              | `climbUuid`, `boardLayout`                                        | LED frames transmitted                              |
| Climb Sent to Board Failure             | bluetooth-context.tsx:111,119          | `climbUuid`, `boardLayout`, `error_reason`                        | Frame transmission failed                           |
| Mirror Climb Toggled                    | queue-control-bar.tsx:1340             | `isMirrored` (true/false)                                         | User toggled board mirroring                        |
| Play Mode Entered                       | queue-control-bar.tsx:1367             | `boardLayout`                                                     | User entered play/send mode                         |
| Board Render Error                      | rendering-metrics.ts:11                | `context` (thumbnail/card/full-board/feed), `renderer` (svg/wasm) | SVG/WebAssembly render failed (max 5 per session)   |
| Board Worker Rendering Disabled         | rendering-metrics.ts:22                | `reason` (load-failed/construct-failed)                           | Web Worker initialization failed (once per session) |
| Beta Caption Copy Clicked/Copied/Failed | attach-beta-link-form.tsx:157+         | `boardType`, `climbUuid`, `surface` (card/drawer)                 | User copied beta share caption                      |

### 2.9 Sessions / Collab (4 events)

| Event Name                      | File:Line                   | Properties                                                                              | Context                               |
| ------------------------------- | --------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| Session Started                 | start-sesh-drawer.tsx:356   | `boardName`, `hasGoal`, `isDiscoverable`, `generatedQueueCount`, `generatedWorkoutType` | Host created session                  |
| Session Joined                  | board-session-bridge.tsx:59 | `session_id`, `board_name`, `layout_id`                                                 | Guest joined via link/QR              |
| Session Queue Generated Cleared | start-sesh-drawer.tsx:270   | (no properties)                                                                         | Host dismissed generated queue        |
| Mirror Climb (in sessions)      | use-climb-actions.ts:174    | `climbUuid`, `boardLayout`                                                              | User mirrored climb in shared session |

### 2.10 Server-Side Cache (1 event)

| Event Name                     | File:Line                       | Properties                                                          | Context                  |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------------- | ------------------------ |
| Climb Search Cache Invalidated | climb-search-cache.server.ts:31 | `boardName`, `layoutId`, `source` (internal-route/save-climb-proxy) | Server cache revalidated |

### 2.11 Performance / System (3 events)

| Event Name  | File:Line               | Properties                                                                                         | Context                                    |
| ----------- | ----------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| $pageview   | analytics.ts:145        | `$current_url` (sanitized pathname)                                                                | Page navigation (per `usePathname()`)      |
| $web_vitals | analytics-client.tsx:50 | `$current_url`, `$web_vitals_LCP_*`, `$web_vitals_CLS_*`, `$web_vitals_FCP_*`, `$web_vitals_INP_*` | Core Web Vitals batch (LCP, CLS, FCP, INP) |

---

## 3. Backend Events - Server-Only

### Live Activity Events (iOS Push Notifications)

**File:** `/packages/backend/src/services/analytics/live-activity.ts`

| Event Name                                      | distinctId                          | Properties                                                                                                                                                    | Context                                          |
| ----------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Live Activity Started                           | `userId`                            | `sessionId`, `tokenLength`, `apnsConfigured`, `tokenPreviouslyRegistered`, `tokenRebound`                                                                     | Push token registered for session                |
| Live Activity Ended                             | `userId`                            | `sessionId`, `reason` (unregister/session-ended), `tokenCount`                                                                                                | Push subscription cleanup                        |
| Live Activity Widget Navigation                 | `userId`                            | `sessionId`, `action` (next/prev), `outcome` (success/rate_limited/error), `statusCode`, `queueLength`, `serverCurrentIndex`, `targetIndex`, `boundSessionId` | Widget next/prev button in notification          |
| Live Activity Widget Navigation Attribution Gap | `live-activity-session:{sessionId}` | Same as above + `reason: 'missing_user_id'`                                                                                                                   | Widget nav without user context (error tracking) |
| Live Activity Push Delivery                     | `live-activity-session:{sessionId}` | `sessionId`, `event` (update/end), `source` (event/heartbeat/registration), `tokenCount`, `sentCount`, `failedCount`, `staleCount`, `elapsedMs`               | Batch push send results                          |

**Backend Event Properties:**

- `service: 'boardsesh-backend'` (auto-added)
- `environment: $POSTHOG_ENVIRONMENT` (auto-added)
- `$process_person_profile: false` (for session-scoped events)

**Backend PostHog Initialization:**
**File:** `/packages/backend/src/services/analytics/posthog.ts`

- SDK: `posthog-node`
- Host: `$POSTHOG_HOST` (default `us.i.posthog.com`)
- Flush: 20 events or 10s (configurable)
- Error handling: Logged warnings, non-blocking

---

## 4. Proxy & Infrastructure

### PostHog Reverse Proxy

**File:** `/packages/backend/src/handlers/posthog.ts`

- **Path:** `/api/posthog/*` → `https://us.i.posthog.com/*`
- **Purpose:** First-party cookie domain (ad-blocker evasion)
- **Max body:** 64 KB
- **Timeout:** 5s
- **CORS:** Applied (see `cors.ts`)
- **Fallback:** If proxy down, client can override to `us.i.posthog.com` directly via `NEXT_PUBLIC_POSTHOG_HOST` env var

---

## 5. Feature Flags & Config

**Vercel Flags:** Empty runtime config (see `/packages/web/app/flags.ts`)

- No PostHog feature flags currently integrated
- Uses Vercel native flags for deploy previews (`vercel-flag-overrides` cookie)

**PostHog Feature Flag Calls:**

- No `getFeatureFlag()` or `isFeatureEnabled()` calls found
- SDK supports it but not currently used

---

## 6. Analytics Quality & Patterns

### Gaps & Inconsistencies

1. **Session Lifecycle Incomplete:**
   - ✅ `Session Started` (host creates)
   - ✅ `Session Joined` (guest joins)
   - ❌ `Session Ended` (never fired — only via Live Activity widget tracking)
   - ❌ `Session Left` (no tracking when user leaves shared session)
   - **Impact:** Cannot measure session duration or member churn

2. **Logbook vs. Quick Tick Duplication:**
   - Both `Tick Logged` and `Quick Tick Saved` fire for same action
   - No clear distinction in properties
   - **Impact:** Counts inflated for "tick attempts"

3. **Beta Videos Sparse:**
   - Link click, add, copy tracked
   - ❌ No "Beta Video Removed" event
   - ❌ No view duration / engagement time
   - **Impact:** Cannot measure video watch-through or retention

4. **Bluetooth Partially Instrumented:**
   - Connection success/failure tracked
   - Climb sent success/failure tracked
   - ❌ No connection attempt count
   - ❌ No reconnect loop detection
   - ❌ No LED state validation or error codes
   - **Impact:** Hard to diagnose intermittent hardware issues

5. **Queue Operations Throttled:**
   - Max 5 per operation type per session (documented in `queue-metrics.ts`)
   - **Impact:** Cannot debug long-tail queue errors; only first 10 errors per session visible

6. **Search vs. Filter Conflation:**
   - `Climb Search Performed` for text search
   - `Search Hold Filter Changed` for heatmap tap
   - `Search Zone Enabled/Cleared/Updated` for zone drawing
   - No unified "search_context" property
   - **Impact:** Hard to correlate hold-based and zone-based searches

7. **One-Off Events Never Reused:**
   - `Angle Changed` (only call site: line 80)
   - `App Install Click` (only call site, two iOS/Android variants)
   - `Onboarding Tour *` (5 events, used in single component)
   - **Impact:** Suggests reactive instrumentation rather than strategic dashboard design

8. **Admin URLs Excluded:**
   - All analytics blocked on `isAdminAnalyticsUrl()` paths
   - ❌ No internal team usage tracking
   - ❌ No A/B test exposure data from admins
   - **Impact:** Cannot measure dogfooding or internal UX validation

### Strengths

1. **Identity Cohesion:**
   - Proper anonymous → authenticated merge via alias + IndexedDB
   - Deduplication prevents double-alias on reload
   - Email and language person properties tracked

2. **First-Party Analytics:**
   - Reverse proxy + localStorage avoids ad-blocker blind spots
   - Hostname-gated to production only (staging safe)

3. **Event Namespacing:**
   - Consistent "Entity + Action" naming: "Climb Created", "Queue Navigation", "Bluetooth Connection Success"
   - Clear error variants: "Climb Create Failed", "Climb Sent to Board Failure"

4. **Rich Context:**
   - Most events include `boardLayout` for cross-layout analysis
   - Climbs tracked with `climbUuid` for drill-down
   - Mode tracking in queue operations (local/party/party-offline)

---

## 7. Key Findings for PM Analysis

### High-Value Dashboards (Easy Wins)

1. **Climb Creation Funnel:**
   - `Climb Created` (event + draft flag) → filter by holdCount distribution
   - `Climb Create Failed` (error tracking)
   - Identify high-friction hold counts

2. **Authentication Cohort:**
   - `Signup Completed` → `Login Succeeded` retention (7-day, 30-day)
   - Auth method breakdown: credentials vs. OAuth providers
   - Email verification impact on login flow

3. **Session Engagement:**
   - `Session Started` (host) vs. `Session Joined` (guests)
   - Host behavior: goal-setting, discoverability flags
   - **Gap:** No session_ended; must infer from session duration

4. **Bluetooth Reliability:**
   - Connection success rate by `boardLayout`
   - "Climb Sent" success / failure ratio
   - Correlate with device OS (not tracked — **gap**)

### Missing Instrumentation (Recommended Additions)

1. **Session Lifecycle:**

   ```typescript
   track('Session Ended', { session_id, duration_seconds, member_count, reason });
   track('Session Left', { session_id, role: 'host' | 'guest', reason });
   ```

2. **Queue Depth Metrics:**

   ```typescript
   track('Queue Modified', { operation, queue_length, index_changed_to });
   ```

3. **Hardware Diagnostics:**

   ```typescript
   track('Bluetooth Reconnect', { attempt_count, last_success_ms_ago });
   track('LED Validation Failed', { board_name, error_code });
   ```

4. **Search Funnel:**

   ```typescript
   track('Search Started', { search_type: 'text' | 'holds' | 'zone' });
   track('Search Result Clicked', { search_type, rank, climb_uuid });
   ```

5. **Feature Adoption:**
   ```typescript
   track('Feature Used', { feature_name, first_time: boolean });
   // For: Playlist generator, mirror mode, zone search, etc.
   ```

---

## 8. Event Volume Forecast

**Assumptions:**

- 1,000 DAU
- 5 avg events per session (excluding pageviews/web vitals)
- 2 pageviews per session
- 1 web_vitals batch per pageview

**Daily:**

- Track events: 5,000
- Pageviews: 2,000
- Web vitals: 2,000
- **Total: ~9,000 events/day** (well within PostHog's quota)

**Monthly:**

- ~270K events
- **Cost impact:** Negligible at standard PostHog tier (usually 1M+ free)

---

## 9. File Reference Index

### Client-Side (Web)

- `/packages/web/app/lib/analytics.ts` — Core track/identify/alias functions
- `/packages/web/app/lib/analytics.server.ts` — Server-side wrapper (Vercel only)
- `/packages/web/app/components/analytics-client.tsx` — Web Vitals capture
- `/packages/web/app/components/party-manager/party-profile-context.tsx` — Identity lifecycle
- `/packages/web/app/lib/analytics-paths.ts` — URL sanitization rules
- `/packages/web/app/lib/posthog-alias-storage.ts` — Alias deduplication

### Server-Side (Backend)

- `/packages/backend/src/services/analytics/posthog.ts` — PostHog Node SDK init & event capture
- `/packages/backend/src/services/analytics/live-activity.ts` — Live Activity event helpers
- `/packages/backend/src/handlers/posthog.ts` — Reverse proxy handler
- `/packages/backend/src/__tests__/analytics-posthog.test.ts` — Backend event tests

### Event Sources (Top 10 by Call Volume)

1. `bottom-tab-bar.tsx` — 9 track() calls
2. `queue-control-bar.tsx` — 5+ track() calls
3. `climbs-list.tsx` — 4+ track() calls
4. `playlist-action.tsx` — 3+ track() calls
5. `favorite-action.tsx` — 3+ track() calls
6. `play-view-drawer.tsx` — 4+ track() calls
7. `climb-search-form.tsx` — 6+ track() calls
8. `auth-page-content.tsx` — 4+ track() calls
9. `use-climb-actions.ts` — 8+ track() calls
10. `use-board-bluetooth.ts` — 6+ track() calls

---

**Report Generated:** 2026-05-18
**Total Lines Scanned:** 45,000+
**Unique Event Names:** 94 (89 web + 5 backend)
**Call Sites:** 150+ (119 web + 31 backend/tests)

---

## Appendix A — 2026-05-18 instrumentation patch (Board Sessions & Hardware dashboard)

Six events added or enriched to unblock the new dashboard at `/dashboard/1597030`.

### New events (3)

| Event                      | Properties                                                                                                                                      | Emit sites                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Session Ended`            | `sessionId`, `durationSec`, `peerCount` (high-water-mark), `climbsAttempted`, `endedBy` (`user_left` / `tab_closed` / `server_disconnect`)      | `graphql-queue/hooks/use-session-id-management.ts` (user_left), `graphql-queue/QueueContext.tsx` (server_disconnect via `connectionState === 'error'`, tab_closed via `pagehide`). State held in `packages/web/app/lib/session-lifecycle-tracking.ts`.                                                                                                                                                                        |
| `Pairing Failed`           | `boardType`, `stage` (`scan` / `user_cancelled` / `gatt_connect` / `service_discover` / `first_write` / `unknown`), `errorCode`, `errorMessage` | `board-bluetooth-control/use-board-bluetooth.ts`. Fires alongside existing `Bluetooth Connection Failed` (kept for back-compat).                                                                                                                                                                                                                                                                                              |
| `Climb Added to Queue`     | `boardLayout`, `addedFromTab` (`search` / `playlist` / `climb_detail` / `peer_broadcast` / `unknown`), `currentQueueLength`, `partyMode` (bool) | `graphql-queue/QueueContext.tsx` (self), `graphql-queue/hooks/use-queue-event-subscription.ts` (peer_broadcast). Source attribution wired at: `climb-actions/use-climb-actions.ts`, `climb-actions/actions/queue-action.tsx` (both `climb_detail`); `climb-actions/queue-button.tsx`, `climb-card/climb-list-item.tsx` swipe (both `search`); `liked-climbs-view-content.tsx` (`playlist`). Other sites default to `unknown`. |
| `Climb Removed from Queue` | `boardLayout`, `partyMode`, `removedBy` (`self` / `peer`)                                                                                       | Same files as `Climb Added to Queue`.                                                                                                                                                                                                                                                                                                                                                                                         |

### Enriched existing events (3)

| Event                         | New properties                                                                                                                                  | Reason kept distinct from new event                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `Bluetooth Disconnected`      | `disconnectReason` (`user_initiated` / `gatt_error` / `unknown`), `connectionDurationSec`                                                       | Existing `reason` and `duration_connected_ms` properties preserved so older dashboards continue to render. |
| `Climb Sent to Board Failure` | `failureReason` (`characteristic_unavailable` / `not_connected` / `write_aborted`), `climbHoldCount` (count of `'p'` markers in `climb.frames`) | Pure addition — no existing property names overwritten.                                                    |

### Decisions made during implementation

- `partyMode = users.length > 1` (anything more than the local user counts as a party).
- `server_disconnect` detected via React-level `connectionState === 'error'`, not by editing `websocket-connection-manager.ts` directly — the manager doesn't know session IDs and the React signal is equivalent.
- `endedBy: 'idle'` not implemented — there's no inactivity timer that ends sessions today. Inline TODO marks the spot.
- `tab_hidden` not implemented as a Bluetooth disconnect reason — there's no code path that drops BLE on `visibilitychange`.
- `climbsAttempted` is incremented on every current-climb change (not on every BLE send) because BLE may be off.

### Validation

- `vp run typecheck:web` clean.
- `vp check` clean on every touched file. (Four pre-existing format issues in untouched files — three docs files and one drizzle snapshot — are unrelated.)
- 354 bluetooth tests, 126 graphql-queue/persistent-session/session-creation tests, 11 offline-mutations tests all pass.

### Follow-up enrichment (recommended, not implemented)

The Boardsesh user base skews **solo-BLE**: most users connect a board over Bluetooth and never start a party session ([[project-sessions-are-optional]]). To make session-mode a one-click breakdown on every BLE tile in the future, enrich `Bluetooth Connection Success` and `Climb Sent to Board Success` / `Failure` with `inActiveSession: bool` derived from `persistentSession.users.length > 0`. Today the same insight needs a HogQL join. Low effort, high analytical leverage.
