# Mobile Play View Roadmap

## Overview

This document tracks the multi-phase effort to bring the React Native play drawer to full parity with the web version. The web play view is the most interaction-dense surface in Boardsesh -- it combines climb browsing, queue navigation, tick logging, board rendering, and party mode into a single drawer. Porting it to mobile requires adapting every gesture, animation, and layout to native primitives while sharing as much logic as possible through the `@boardsesh/play-view` package.

Each phase is scoped to ship independently. Phase 1 delivers a usable drawer that covers the core loop (view climb, navigate queue, log tick). Later phases layer on swipe navigation, nested drawers, advanced gestures, party mode, and polish.

## Canonical Spec Reference

The authoritative design spec for the play view lives at [`docs/ui/06-play-view.md`](ui/06-play-view.md). That document defines the layout, interaction model, component hierarchy, and visual tokens for both platforms. This roadmap tracks implementation progress against that spec -- it does not redefine the design.

## Shared Package

`@boardsesh/play-view` at `packages/shared/play-view/` contains platform-agnostic logic extracted from the web implementation and consumed by both web and mobile:

- Queue navigation helpers (next, previous, jump-to-index)
- Grade display formatting (font grade, V-scale, circuit)
- Tick utility functions (attempt counting, send detection, quality mapping)
- Shared TypeScript types for climb state, drawer state, and action bar actions
- Constants (action bar button definitions, default snap points, animation durations)

## Feature Parity Table

| Feature                                             | Web  | Mobile  | Shared Code                                   | Phase |
| --------------------------------------------------- | ---- | ------- | --------------------------------------------- | ----- |
| Play drawer (bottom sheet shell)                    | Done | Done    | Snap points, state machine                    | 1     |
| Climb header (grade + name + stats)                 | Done | Done    | Grade formatting, stat utils                  | 1     |
| Board renderer                                      | Done | Done    | Hold data transforms                          | 1     |
| Action bar (8 buttons)                              | Done | Done    | Button definitions, action types              | 1     |
| Tick FAB                                            | Done | Done    | Tick state logic                              | 1     |
| Queue navigation (prev/next)                        | Done | Done    | Navigation helpers                            | 1     |
| Board carousel (swipe)                              | Done | Done    | Prefetch logic                                | 2     |
| Inline tick bar                                     | Done | Done    | QuickTickBar logic                            | 2     |
| Wake lock                                           | Done | Done    | --                                            | 2     |
| Queue drawer (nested)                               | Done | Done    | Queue list model (buildQueueListModel)        | 3     |
| Below-fold sections (logbook, similar, community)   | Done | Stub    | Section data types                            | 3     |
| Climb actions sheet                                 | Done | Done    | Action definitions                            | 3     |
| Angle selector                                      | Done | Done    | Angle range utils                             | 3     |
| Zoom/pan                                            | Done | Planned | Transform math                                | 4     |
| Double-tap favorite                                 | Done | Planned | Favorite toggle logic                         | 4     |
| Route/circuit playback (animate, speed, party-sync) | Done | Done    | @boardsesh/playback-react (usePlaybackEngine) | 5     |
| Party mode (mini session bar, always-live wall)     | Done | Partial | Session state types                           | 5     |
| BLE lightbulb integration                           | Done | Partial | Protocol (via @boardsesh/ble-protocol)        | 5     |
| Coachmarks                                          | Done | Planned | Coachmark definitions                         | 6     |
| Beta videos section                                 | Done | Planned | Video data types                              | 6     |
| Analytics section                                   | Done | Planned | Stat aggregation                              | 6     |

## Phase Descriptions

### Phase 1: Drawer Shell (done)

Delivers the core play loop: open a climb, see the board, navigate the queue, log a tick.

- **`@boardsesh/play-view` shared package** -- queue navigation helpers, grade display formatting, tick utilities, shared TypeScript types
- **`PlayDrawer`** -- bottom sheet component built on `@gorhom/bottom-sheet`, with collapsed/expanded snap points matching the web drawer heights
- **`PlayDrawerHeader`** -- grade pill, climb name, ascent count, and star rating, using shared grade formatting
- **`PlayDrawerActionBar`** -- 8 icon buttons matching the web action bar (favorite, share, add to playlist, mirror, rotate, angle, lightbulb, queue)
- **`PlayDrawerTickFab`** -- floating green check button anchored above the bottom sheet, triggers the tick flow
- **Navigation integration** -- climb list taps open the drawer instead of pushing a new screen; back gesture collapses or dismisses the drawer
- **Queue integration** -- previous/next buttons in the action bar cycle through the queue using shared navigation helpers

### Phase 2: Board Carousel + Tick Bar (done)

Adds swipe-to-navigate and inline tick logging without opening a full sheet.

- **Horizontal swipe between climbs** -- `react-native-gesture-handler` `PanGestureHandler` combined with `react-native-reanimated` for 60fps transitions between queue items
- **Peek animation** -- next and previous climbs slide in from the edge during a swipe gesture, giving spatial context within the queue
- **Inline tick bar** -- collapsible bar below the board with grade picker, quality picker, tries counter, and comment field; expands on tap, collapses on submit or outside tap
- **Extract `QuickTickBar` logic into `@boardsesh/play-view`** -- grade/quality/tries state management and validation shared between web and mobile
- **Wake lock** -- `expo-keep-awake` activated while the play drawer is open, released on dismiss

### Phase 3: Queue Drawer + Below-Fold Sections (done)

Adds queue management and deferred content sections.

- **Nested queue bottom sheet** -- second bottom sheet stacked over the play drawer, opened via the queue action bar button; dismissed by swipe-down or tap-outside
- **Queue list** -- three regions (history, current, up-next) with drag-to-reorder, swipe-to-remove, edit mode for bulk operations
- **Below-fold deferred sections** -- logbook entries, similar climbs, and community data loaded via `InteractionManager.runAfterInteractions()` to avoid blocking the initial drawer render
- **Climb actions sheet** -- action sheet triggered by long-press or the overflow button, with options: share, add to playlist, copy link, and remix
- **Angle selector sheet** -- bottom sheet with angle slider or segmented control, updating the board renderer and persisting the selection

### Phase 4: Advanced Interactions

Adds zoom, pan, and gesture shortcuts.

- **Zoom/pan** -- `PinchGestureHandler` and `PanGestureHandler` composed with reanimated shared values for smooth scale and translate transforms on the board renderer
- **Double-tap favorite** -- `TapGestureHandler` with `numberOfTaps={2}` triggers a favorite toggle with a heart burst animation (reanimated scale + opacity sequence)
- **Floating zoom reset button** -- appears when zoom level exceeds 1x, taps animate back to default scale and origin

### Phase 5: Party Mode

Adds real-time collaborative climbing sessions.

**Shipped (#2496):**

- **Route/circuit playback** -- variable-speed, frame-stepped animation of multi-frame climbs (`framesCount > 1`) in the play drawer, via the shared `@boardsesh/playback-react` engine (`usePlaybackEngine` + `useClimbFrames`). Boulders are unaffected (`isAnimatable` is false).
- **Playback party-sync** -- `PlaybackStateChanged` is forwarded through the queue provider's `subscribeToQueueEvents` seam (bypassing the reducer) and broadcast via `publishPlaybackState`, so party members see the same frame/speed/play state in real time.
- **BLE frame mirroring** -- during route playback, the current frame is written to a connected board over BLE through a latest-wins, GATT-safe drain (mobile's `sendFramesToBoard` has no internal mutex).

**Still planned:**

- **Mini session bar** -- persistent bar above the play drawer showing connected users and session status (sessions are always-live; the original driver/preview design was retired)
- **Lightbulb behavior** -- any participant's climb change broadcasts to everyone in real time and is relayed to the board by whoever holds a BLE connection. The lightbulb is a send/re-assert affordance: pressing it re-sends the current climb to the board
- **Wall-confirm watcher** -- `WallConfirmedClimb` lights the lightbulb when a phone delivers the climb over BLE; `WallDisconnected` turns it off when the relaying link drops (the current climb is preserved)
- **BLE lightbulb** -- connect to the board via `@boardsesh/ble-protocol`, send the current climb to the LEDs; report a disconnect on BLE drop or session end

### Phase 6: Polish

Final pass for discoverability, feedback, and extended content.

- **Coachmarks** -- first-use hints for the lightbulb button, zoom gesture, and swipe navigation; shown once per user, persisted via `expo-secure-store`
- **Haptic feedback** -- `expo-haptics` triggered on tick submit, favorite toggle, queue navigation, swipe thresholds, and zoom reset
- **Beta videos section** -- below-fold section showing user-submitted beta videos for the current climb
- **Analytics section** -- below-fold section with personal stats (attempts, sends, grade progression) and crew logbook entries for the current climb

## Platform Adaptation Notes

Key substitutions when translating web patterns to React Native:

| Web                              | Mobile                                      | Notes                                                                                           |
| -------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `SwipeableDrawer` (MUI)          | `@gorhom/bottom-sheet`                      | Native bottom sheet with snap points, gesture-driven open/close                                 |
| `react-swipeable`                | `react-native-gesture-handler`              | `PanGestureHandler` for horizontal swipe between climbs                                         |
| CSS transitions / `@keyframes`   | `react-native-reanimated`                   | Shared values and `useAnimatedStyle` for 60fps animations on the UI thread                      |
| `@use-gesture/react` (pinch/pan) | `PinchGestureHandler` + `PanGestureHandler` | Composed gesture handlers with reanimated for zoom/pan transforms                               |
| Web Wake Lock API                | `expo-keep-awake`                           | `activateKeepAwakeAsync()` while the drawer is open                                             |
| URL sync (search params)         | Expo Router navigation state                | Drawer state lives in component state, not the URL; deep links open the drawer via route params |
| `startTransition` (React)        | `InteractionManager.runAfterInteractions()` | Defers below-fold section rendering until the drawer animation completes                        |
