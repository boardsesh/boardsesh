## Play View

The Play View is the primary interactive screen for viewing, navigating, and interacting with climbs. It is the most complex single screen in the app, combining board rendering, gesture navigation, tick logging, session management, queue control, and below-fold detail sections into a single cohesive experience.

---

### Play View Drawer

#### Entry Points

Users open the play view through four paths:

1. **Tap a climb row or card in the climb list.** The list dispatches a `boardsesh:open-play-drawer` custom window event (`PLAY_DRAWER_EVENT`). In party sessions, the event payload includes the tapped `Climb` object so the drawer can preview it without mutating the wall climb. In solo mode, callers pre-mutate state via `setCurrentClimb`.
2. **Tap the climb thumbnail in the queue control bar.** The control bar sets `activeDrawer` to `'play'` directly.
3. **Tap a climb in the queue list.** Sets the climb as current (broadcasts in party mode) and opens the play drawer.
4. **Direct URL navigation** to `/b/[board_slug]/[angle]/view/[climb_uuid]` or the legacy `/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/view/[climb_uuid]` route. The drawer opens on mount with `initialOpenWithoutAnimation=true` so it is visible immediately on the SSR paint with no slide-in transition.

#### State Machine

The drawer manages a composite state with these primary variables:

| State Variable           | Type                                    | Description                                                                                                                                                                             |
| ------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeDrawer`           | `'none' \| 'play' \| 'queue' \| 'tick'` | Which top-level view the queue control bar is showing. The play view is open when this equals `'play'`.                                                                                 |
| `isQueueOpen`            | `boolean`                               | Nested queue drawer is visible (stacked over play view).                                                                                                                                |
| `isActionsOpen`          | `boolean`                               | Climb actions drawer is visible (stacked over play view).                                                                                                                               |
| `isPlaylistSelectorOpen` | `boolean`                               | Playlist selection drawer is visible (stacked over play view).                                                                                                                          |
| `isTickBarActive`        | `boolean`                               | The tick bar is expanded, overlaying the board area.                                                                                                                                    |
| `isBoardZoomed`          | `boolean`                               | The board is pinch-zoomed in. Disables horizontal swipe navigation and locks vertical scroll.                                                                                           |
| `drawerDisplayedItem`    | `ClimbQueueItem \| null`                | In party sessions, the climb the drawer is locally previewing. When null, the drawer shows the wall climb (`currentClimbQueueItem`).                                                    |
| `pendingClimbUuid`       | `string \| null`                        | Set when the user presses the lightbulb to take control in party mode. Cleared when the wall-confirm event arrives or the 2-second timeout fires. Drives the lightbulb pulse animation. |
| `lightDrawerOpen`        | `boolean`                               | The light-control drawer (disco, glyphs, palette, BLE disconnect) is open. Mounted lazily on first open via `hasOpenedLightDrawer`.                                                     |
| `showLightbulbCoachmark` | `boolean`                               | First-run coachmark pulse on the lightbulb. Read from IndexedDB key `swipeHint:lightbulbSeen`.                                                                                          |
| `drawerOpen`             | `boolean`                               | Internal CSS-level open state, separated from `isOpen` to allow animation timing.                                                                                                       |
| `sectionsEverEnabled`    | `boolean`                               | Flips to true after the drawer's open transition completes. Gates below-fold section mounting.                                                                                          |

**State transitions:**

- **play -> queue**: Tap queue button in action bar. Sets `isQueueOpen=true`, `isActionsOpen=false`, `isPlaylistSelectorOpen=false`. The `queueMounted` flag is set to true so the QueueDrawer component mounts.
- **play -> tick**: Tap the tick FAB. Sets `isTickBarActive=true`, `isActionsOpen=false`.
- **queue -> play**: Close the nested queue drawer (swipe down, tap backdrop, or tap a climb). Sets `isQueueOpen=false`. On transition end, `queueMounted` is set to false to unmount the drawer.
- **tick -> play**: Tap the tick bar close button, tap the backdrop overlay, or swipe down on the tick bar. Sets `isTickBarActive=false`.
- **play -> actions**: Tap the "more" (ellipsis) button in the action bar. Sets `isActionsOpen=true`.
- **actions -> playlist**: Tap "Add to playlist" in the actions drawer. Sets `isActionsOpen=false`, `isPlaylistSelectorOpen=true`.
- **close**: Tap the close button (top-right X), swipe down on the drawer, or press browser back. The `handleClose` callback is gated: it does nothing if `isActionsOpen`, `isQueueOpen`, or `isPlaylistSelectorOpen` is true (nested drawers must close first). Browser back (`popstate`) bypasses this gate and closes unconditionally.

**Tick bar auto-close:** The tick bar resets (`isTickBarActive=false`) whenever `currentClimb.uuid` changes, preventing it from staying open for the wrong climb.

#### Overall Layout (Top to Bottom)

The drawer uses a `SwipeableDrawer` component with `placement="bottom"`, `height="100%"`, and `fullHeight`. The internal layout, from top to bottom:

1. **Drag handle** (top-center). Rendered by `SwipeableDrawer` via `showDragHandle`. A short horizontal pill that the user can grab to swipe the drawer down to close.

2. **Close button** (top-right, `position: absolute`, `top: 8px`, `right: 8px`, `z-index: 2`). An `IconButton` with `CloseOutlined` icon. Background: `action.selected`, hover: `action.focus`.

3. **Drawer content area** (`div.drawerContent`). A flex column that fills the drawer. Touch events on this div drive the pull-to-close gesture (`usePullToClose` hook with `deadZone: 60`, `closeThreshold: 70`). Contains `PlayDrawerContent` which renders `ClimbDetailShellClient` in `mode="play"`.

   The shell splits into:

   **Above-fold** (fills 100% height, flex column, `flex-shrink: 0`):

   a. **Climb header** (`ClimbDetailHeader`). Horizontal layout: grade (left, min-width 48px) | name + details (center, flex: 1) | spacer (right, min-width 48px for balance). The grade renders in a color derived from difficulty. The name uses `MarqueeText` for long names. Below the name: quality rating + send count + setter username, joined by `" · "` (middle dot). Min-height 56px. Padding: 12px horizontal, 12px vertical.

   b. **Board section wrapper** (`div.boardSectionWrapper`). `position: relative`, flex: 1, contains the board carousel, tick FAB, tick bar overlay, and tick bar. The board renders top-aligned (`justify-content: flex-start`) so the tick bar can float over the bottom without covering the climb.

   c. **Mini session bar** (`MiniSessionBar`). Only renders in party mode. Sits between the board and the action bar.

   d. **Action bar** (`PlayViewActionBar`). Horizontal row of icon buttons, `justify-content: space-around`. Only renders when `isOpen` is true.

   **Below-fold** (deferred render, scrollable): Sections mount after the drawer open transition completes (`sectionsEverEnabled`), using `startTransition` to avoid blocking the above-fold paint. The scroll container has `overflow-y: auto`, `-webkit-overflow-scrolling: touch`, `overscroll-behavior-y: contain`.

4. **Nested drawers** (portal-less, stacked on top):
   - **Climb actions drawer** (`SwipeableDrawer`, height 60%, drag-to-resize)
   - **Playlist selector drawer** (`SwipeableDrawer`, height auto, max-height 70vh)
   - **Queue drawer** (`QueueDrawer`, height 60%)
   - **Light control drawer** (`LightControlDrawer`, lazily mounted)

#### URL Synchronization

The `useDrawerUrlSync` hook keeps the browser address bar in sync:

- When the drawer opens from a list page, `history.pushState` navigates to `/view/{climb_uuid}`.
- On climb changes (prev/next/swipe), `history.replaceState` updates the URL to the new climb.
- On close, `history.replaceState` returns to the list URL.
- Browser back (`popstate`) closes the drawer when the URL leaves `/view/`.
- Direct hits to `/view/{uuid}` are detected via `sourceRef='direct'` and skip the push (the URL is already correct).

#### Wake Lock

The `useWakeLock` hook is activated when the drawer is open (`useWakeLock(isOpen)`), preventing the screen from dimming while the user is viewing a climb.

#### Pre-warming

When a climb is displayed, the drawer pre-warms the board render by calling `renderBoard()` from the worker manager with the current climb's `frames`, `mirrored` state, and `boardDetails`. This ensures the off-screen canvas/WASM render is ready before the user scrolls or interacts.

---

### Board Carousel (SwipeBoardCarousel)

The `SwipeBoardCarousel` component renders the current climb's board with horizontal swipe navigation between climbs in the queue or suggestions feed.

#### Rendering Pipeline

Two rendering backends are supported, chosen at runtime by `useCanvasRendererReady()`:

1. **BoardCanvasRenderer** (preferred). Uses a Web Worker + WASM pipeline. The worker composites background images + hold overlay off the main thread, returning an `ImageBitmap` drawn onto a `<canvas>` element. Falls back to `BoardImageLayers` if the worker render fails.

2. **BoardImageLayers** (fallback). Uses CSS Grid stacking (`gridArea: 1/1`) with `<img>` elements for board background layers and an SVG overlay for holds. Avoids `position: absolute` due to iOS 18.x WebKit bugs with absolutely positioned images in aspect-ratio containers.

Both render with `contain` mode (`object-fit: contain`) when used in the carousel, filling 100% width and 100% height of the container.

#### Board Rendering (BoardRenderer)

For Aurora boards (Kilter, Tension, Decoy, Touchstone, Grasshopper, Soill):

- SVG-based rendering with `viewBox="0 0 {boardWidth} {boardHeight}"` and `preserveAspectRatio="xMidYMid meet"`.
- Background images rendered as `<image>` elements inside the SVG, one per entry in `boardDetails.images_to_holds`. Each image fills the full `boardWidth x boardHeight`.
- Two sizing modes controlled by the `fillHeight` prop:
  - **Fill-height mode** (`fillHeight=true`): SVG has `height: 100%`, `width: 100%`. Used in the play view carousel where the container controls sizing.
  - **Auto-height mode** (`fillHeight=false`): SVG has `height: auto`, `maxHeight` defaults to `55vh` (or `10vh` for thumbnails). Used in standalone board views.

For MoonBoard:

- Grid-based rendering via `MoonBoardRenderer`, using the board's `layoutFolder` and `holdSetImages` array. The grid is 11 columns by 18 rows.

#### Lit-Up Holds (BoardLitupHolds)

Holds are rendered as SVG `<circle>` elements overlaid on the board:

- **Hold data**: Each hold has `id`, `cx`, `cy`, `r` (center coordinates and radius), and `mirroredHoldId`.
- **Colors by state** (per board, defined in `HOLD_STATE_MAP`):
  - Kilter: STARTING = `#00FF00` (green), HAND = `#00FFFF` (cyan), FINISH = `#FF00FF` (magenta), FOOT = `#FFAA00` (orange)
  - Tension: STARTING = `#00FF00` (green, display: `#00DD00`), HAND = `#0000FF` (blue, display: `#4444FF`), FINISH = `#FF0000` (red), FOOT = `#FF00FF` (magenta)
  - MoonBoard: STARTING = `#00FF00` (green), HAND = `#0000FF` (blue), FINISH = `#FF0000` (red)
- **Stroke width**: 6px normal, 8px for thumbnails.
- **Fill opacity**: 0 for normal rendering (stroke-only circles), 0.3 for thumbnails (semi-transparent fill for visibility at small sizes).
- **Transparency optimization**: In thumbnail mode or when no `onHoldClick` handler is provided, only lit-up holds are rendered (typically 5-15 holds vs. hundreds total). This is a significant performance optimization.
- **Mirroring**: When `mirrored=true` and a hold has a `mirroredHoldId`, the hold is rendered at the mirrored hold's position (`cx`, `cy`, `r`). The mirrored hold is looked up from `holdsData` by ID.

#### Swipe Navigation

Implemented by the `useCardSwipeNavigation` hook (wraps `react-swipeable`):

- **Gesture detection**: Touch-only (`trackMouse: false`). Uses `useSwipeDirection` to distinguish horizontal from vertical swipes early in the gesture, so vertical scrolling is not blocked.
- **Swipe threshold**: 80px horizontal displacement required to trigger navigation.
- **Disabled when**: Board is zoomed (`isZoomed=true`), or the hook's `enabled` prop is false.

**Animation timing constants:**

| Constant                   | Value | Description                                                  |
| -------------------------- | ----- | ------------------------------------------------------------ |
| `EXIT_DURATION`            | 300ms | Slide-off animation (card exits screen)                      |
| `SNAP_BACK_DURATION`       | 200ms | Snap-back when swipe doesn't meet threshold                  |
| `CLIP_EXIT_DURATION`       | 100ms | Delay before triggering navigation in `delayNavigation` mode |
| `ENTER_ANIMATION_DURATION` | 170ms | Enter crossfade/transition for the new climb                 |

**Peek animation:**

During a swipe, the next or previous climb's board slides in from the edge:

- Next climb: `translateX(max(0px, calc(100% + {swipeOffset}px)))` (slides in from right)
- Previous climb: `translateX(min(0px, calc(-100% + {swipeOffset}px)))` (slides in from left)
- The peek container is `position: absolute`, `inset: 0`, with `overflow: clip`.

**Delayed navigation** (`delayNavigation=true`, used in the play view):
When the swipe exceeds threshold, the current card animates off-screen. After `CLIP_EXIT_DURATION` (100ms), the navigation callback fires, the new climb data replaces the old, and an enter direction is set (`from-left` or `from-right`) for a brief crossfade effect that auto-clears after `ENTER_ANIMATION_DURATION` (170ms).

**Scroll prevention:**
A native non-passive `touchmove` listener is attached to the carousel element. When `isHorizontalSwipeRef.current === true`, the listener calls `e.preventDefault()` to block vertical scroll. This is necessary because React 18's passive touch listeners and `touch-action: pan-y` would otherwise allow the compositor to scroll vertically during a horizontal swipe.

**Party session navigation behavior:**

Sessions are always-live, so swipe behaves the same solo or in a party: it calls `setCurrentClimbQueueItem(item)`, which broadcasts the climb change to the shared queue and all participants. Whoever holds a BLE connection relays it to the physical board via the AutoSender.

#### Zoom and Pan (ZoomableBoard)

Implemented by the `useZoomPan` hook (wraps `@use-gesture/react`):

- **Pinch to zoom**: Two-finger pinch gesture. Scale range: 1.0 (min) to 4.0 (max). Zoom threshold: scale > 1.02 is considered "zoomed."
- **Pan when zoomed**: Single-finger drag to move around the board when zoomed in. Translation is clamped to prevent panning past the board edges.
- **Pinch origin tracking**: Zoom targets the pinch origin point, not the center. The hook tracks the pinch origin relative to the container center and adjusts translation accordingly.
- **Reset zoom**: Triggered by the floating reset button or when the climb changes (via `resetKey` prop, set to `currentClimb.frames`). Animates back to scale 1 with a 250ms ease-out transition.
- **Touch action**: `pan-y` when not zoomed (allows native vertical scroll), `none` when zoomed (all touch is captured for pan/pinch). The `data-swipe-blocked` attribute is set when zoomed, signaling parent components to disable their swipe handling.
- **Ctrl+wheel**: Desktop trackpad pinch or ctrl+scroll triggers zoom toward cursor position.

**Floating reset button:**

- Positioned `bottom: 62px`, centered horizontally (`left: 50%`, `transform: translateX(-50%)`).
- Pill-shaped (border-radius 18px), dark overlay background with backdrop blur.
- Contains a `CropFreeOutlined` icon and "Reset" text.
- Opacity transitions from 0 (hidden) to 1 (visible) when zoomed.
- `tabIndex: 0` when visible, `-1` when hidden.

**Zoom hint pill:**

- Centered overlay on the board, shows "Pinch to zoom" with a `ZoomInOutlined` icon.
- Auto-dismisses after 4000ms via CSS `@keyframes zoomHintFade` animation.
- Only shown once per user (IndexedDB key `playview:zoomHintSeen`).
- Only shown when the board is not zoomed and the drawer is open.
- Tapping the overlay dismisses it immediately and persists the seen flag.

#### Double-Tap Favorite

Implemented by `useDoubleTapFavorite` hook + `useDoubleTap` hook:

- **Double-tap detection**: 300ms threshold between taps (`DOUBLE_TAP_THRESHOLD`). Uses native `touchend` listeners (non-passive) to prevent iOS Safari's double-tap-to-zoom. Multi-touch gestures (pinch) are excluded: if any `touchstart` has > 1 touch, the subsequent `touchend` is ignored.
- **Instagram behavior**: Double-tap only adds a favorite, never removes. If already favorited, the heart animation still plays but `toggleFavorite` is not called.
- **Heart animation overlay**: A white `Favorite` (heart) icon, 80px, centered on the board with `position: absolute`, `inset: 0`, `pointer-events: none`, `z-index: 10`. Plays a `heartBurst` keyframe animation (1200ms ease-out): scales from 0 to 1.3, bounces to 0.95, settles at 1.0, then fades to opacity 0. Has a drop-shadow filter.
- **Authentication gate**: If the user is not authenticated, the double-tap opens the auth modal instead of favoriting.
- **Desktop**: The `onDoubleClick` handler fires on desktop; once any touch event is detected, `onDoubleClick` is permanently disabled to prevent double-firing from synthesized click events.

---

### Action Bar (PlayViewActionBar)

A horizontal row of icon buttons displayed below the board and mini session bar. CSS: `display: flex`, `justify-content: space-around`, `padding: 8px 16px 12px`, `border-top: 1px solid var(--neutral-100)`.

Buttons from left to right:

1. **Previous button** (`SkipPreviousOutlined`). Navigates to the previous climb. Disabled when `canSwipePrevious` is false (no previous climb in queue/suggestions). Calls `navigate('previous', 'playViewDrawer')`.

2. **Mirror button** (`SyncOutlined`). Only rendered when `boardDetails.supportsMirroring` is true. Toggles the `mirrored` flag on the current climb. When active (`isMirrored=true`): purple background (`themeTokens.colors.purple`), white icon, purple border. When inactive: default styling. Calls `mirrorClimb()`.

3. **Favorite button** (`Favorite` filled / `FavoriteBorderOutlined` outlined). Toggles favorite status. When favorited: filled heart icon with `themeTokens.colors.error` (red). When not favorited: outlined heart. Calls `toggleFavorite()`.

4. **Lightbulb button** (`Lightbulb` filled / `LightbulbOutlined`). The primary wall-control gesture. Visual states:
   - **Active** (`lightbulbActive=true`): Filled `Lightbulb` icon in `themeTokens.colors.warning` (amber), with a CSS glow animation (`connectedGlow`, 1.5s ease-in-out infinite alternate, filter drop-shadow oscillating between 2px and 6px).
   - **Inactive**: Outlined `LightbulbOutlined` icon, default color.
   - **Pending** (`lightbulbPending=true`): Box-shadow pulse animation (`lightbulbPulse`, 1100ms ease-in-out infinite). Amber box-shadow expands to 6px and fades.
   - **Coachmark** (`lightbulbCoachmark=true`): Same pulse animation but single iteration (900ms). A MUI `Tooltip` with `placement="top"` and `arrow` shows coachmark text. The tooltip auto-dismisses on animation end via `onAnimationEnd`.

   Tap behavior (always-live — no driver role):
   - **Disconnected**: Initiates the connect (`bluetoothConnect()` — silent reconnect to the last board's serial on native shells, otherwise the device picker), then arms the 2-second wall-confirm watcher (`armWallConfirmWatcher`) and sets `pendingClimbUuid`; `WallConfirmedClimb` lights the bulb. The watcher is armed **pulse-only** (`pulseOnly: true`): on timeout it only clears the pulse and never fires a connect fallback, because the tap already started a connect — a second connect while the picker is still open would start a duplicate scan ("Already scanning" on iOS). A `WallDisconnected` event (relaying BLE link dropped) turns the bulb back off while the current climb is preserved.
   - **Connected**: Disconnects (turns the board off); the drop releases the session wall + board-presence holder so every member's lightbulb clears.

   Long-press (via `useLongPress` hook): Opens the `LightControlDrawer` (disco light shows, glyph animations, LED color palette customization, manual BLE disconnect). The `consumeLongPress()` method in the click handler swallows the synthesized click that follows a long-press, preventing both actions from firing.

5. **Angle selector** (`AngleSelector`). A pill-shaped button showing the current angle (e.g., "40°"). Tapping opens a right-side drawer with a grid of all available angles for the board. Each angle card shows the degree, and when a climb is active, shows that climb's stats at each angle (grade, quality, send count). Selecting an angle navigates to the new angle URL and broadcasts in party mode.

6. **More actions button** (`MoreHorizOutlined`). Opens the climb actions drawer (nested `SwipeableDrawer` at 60% height). The actions drawer contains: share, open in Aurora app, add to playlist, add to queue, copy link, report.

7. **Queue button** (`FormatListBulletedOutlined`) wrapped in `MuiBadge`. Badge shows `remainingQueueCount` (number of climbs from current position to end of queue, max 99). Badge background: `themeTokens.colors.primary`, white text. Opens the nested queue drawer.

8. **Next button** (`SkipNextOutlined`). Navigates to the next climb. Disabled when `canSwipeNext` is false. Calls `navigate('next', 'playViewDrawer')`.

---

### Tick FAB and Tick Bar (PlayViewTickBar)

#### Tick FAB (Floating Action Button)

Positioned absolutely at `bottom: 12px`, `right: 16px`, `z-index: 10` within the board section wrapper.

- **Appearance**: 40px circle, gradient background (`linear-gradient(135deg, var(--color-success) 0%, var(--color-success-dark) 100%)`). White checkmark icon (`CheckOutlined`, 20px). Box shadow: `0 4px 12px rgba(0, 0, 0, 0.3)`.
- **Success state** (`hasSuccessfulAscent`): Same green gradient (the class exists for potential future differentiation).
- **Ascent count badge**: When `ascentCount > 0`, a badge appears at `top: -3px`, `right: -3px`. Min-width 16px, height 16px, border-radius 8px, primary-colored background, white text, 10px font, weight 600.
- **Hiding animation**: When the tick bar is active, the FAB scales to 0.5 and fades to opacity 0 (`transform: scale(0.5); opacity: 0; pointer-events: none`). Transition: 200ms ease.
- **Hover/active**: Scale 1.05 on hover (with enhanced shadow), scale 0.95 on press.
- **Action**: Tapping the FAB sets `isTickBarActive=true` and closes the actions drawer if open.

#### Tick Bar Backdrop

A full-area overlay (`position: absolute`, `inset: 0`, `z-index: 9`) that darkens the board when the tick bar is active. Background: `var(--overlay-light)`. Transitions opacity from 0 to 1 over 200ms. `pointer-events: none` when inactive, `auto` when active. Tapping the backdrop closes the tick bar.

#### Tick Bar (Expanded)

Positioned absolutely at the bottom of the board section wrapper (`bottom: 0`, `left: 0`, `right: 0`, `z-index: 10`). Slides up from below via `transform: translateY(100%)` -> `translateY(0)` with 200ms ease-out transition.

**Container styling:**

- Inner container has rounded top corners (`border-radius: 12px 12px 0 0`), shadow (`0 -4px 12px rgba(0, 0, 0, 0.15)`), `touch-action: pan-x`.
- Background: In dark mode, `var(--semantic-surfaceElevated)`. In light mode, `var(--semantic-surface)`.
- Grade tint overlay: A semi-transparent grade-colored overlay applied as `background-image: linear-gradient({gradeTintColor}, {gradeTintColor})`. The tint color is computed from `currentClimb.difficulty` via `getGradeTintColor()`.

**Toolbar row** (top of tick bar, flex `justify-content: space-between`):

- **Expand/collapse toggle** (left): Down arrow when expanded, up arrow when collapsed. 16px icon, 0.7 opacity. Label text ("expand" / "collapse"), 12px font, weight 600. The expanded state is persisted to IndexedDB key `tickBarExpanded`.
- **Close button** (right): Small `IconButton` with `CloseOutlined` (16px). Background: `action.selected`.

**QuickTickBar component:**

The tick bar delegates to `QuickTickBar`, which manages tick target state, grade/quality/tries pickers, and save logic.

**Compact mode** (default, `expanded=false`):

- **Picker panel**: Slides up when a control is tapped, showing one picker at a time (stars, grade, or tries). 200ms height transition.
- **Controls row**: Two sections:
  - Left: Comment input field (flex: 1) + grade button. The comment is a `TextField` with `ChatBubbleOutlineOutlined` start adornment, placeholder text, multiline (1 row collapsed, 4 rows when focused), max 2000 chars.
  - Right: Star picker button + tries counter button.
- **Grade button** (`TickGradeButton`): Shows the selected grade or the consensus grade. Tapping expands the inline grade picker (horizontal scrollable list of grade chips).

**Expanded mode** (`expanded=true`):

- All pickers visible simultaneously in labeled rows:
  - Grade row: Label + horizontal scrollable grade picker (`InlineGradePicker`).
  - Tries row: Label + tries counter (`InlineTriesPicker`).
  - Stars row: Label + star rating picker (`InlineStarPicker`).
  - Comment row: Chat icon + multiline `TextField` (2-4 rows).

**Ascent type logic:**

- **Flash**: First attempt on a climb with no prior logbook history (`!hasPriorHistory && attemptCount === 1`).
- **Send**: Any other successful ascent (has prior history, or attempt count > 1).
- The `isFlash` state is reported to the parent via `onIsFlashChange` so the tick buttons can update their appearance.

**Action buttons** (bottom of tick bar, flex row, `justify-content: flex-end`, `gap: 8px`):

- **Attempt button** (left): `IconButton` with `PersonFallingIcon` (custom SVG icon). Background: `themeTokens.colors.errorMuted`, icon color: `themeTokens.colors.error`. Label: "Attempt". Calls `quickTickBarRef.current.saveAttempt()`.
- **Tick button** (right): `IconButton` with `TickIcon` (checkmark or flash icon). Background transitions between `themeTokens.colors.amber` (flash, with dark text `neutral[900]`) and `themeTokens.colors.success` (send, with white text). 150ms ease transition on background-color and color. Label: "Flash" or "Tick" depending on `isFlash`. Calls `quickTickBarRef.current.save()`.

**Draft restoration:** On mount, the tick bar checks for a saved draft in IndexedDB (via `loadTickDraft(climbUuid, angle)`). If found, it restores quality, difficulty, attempt count, and comment. Drafts are saved when a save attempt fails, so users don't lose their progress.

**Reset on climb change:** When `currentClimb` changes, the tick bar resets comment, focus state, flash detection, and expansion state.

---

### Mini Session Bar

Only renders when `isPersistentSessionActive` is true and `currentClimbQueueItem` is not null. Sits between the board renderer and the action bar.

**Styling:** `display: flex`, `align-items: center`, `gap: 8px`, `px: 16px`, `py: 6px`, `border-top: 1px solid var(--neutral-200)`. Background: `color-mix(in srgb, {warning} 5%, transparent)` -- a warm whisper tint, 5% of the theme warning color. Min-height: 36px.

The bar shows the current climb on the wall (sessions are always-live, so every participant sees the same climb):

#### Wall state

- **Left**: When our session's climb is confirmed on the wall (`WallConfirmedClimb`), a filled `Lightbulb` icon (16px, amber/warning color) + "ON WALL" text (11px, weight 600, letter-spacing 0.5, amber/warning color). After a `WallDisconnected` event the lightbulb is unlit; the current climb is preserved and pressing the lightbulb re-asserts it.
- **Right**: Audience `AvatarGroup` (described below).

#### Audience AvatarGroup

- Positioned at `ml: auto` (right-aligned).
- Shows up to 3 avatars (`max={3}`) of other session participants, excluding the local user.
- Avatar size: 22px, font-size 10px, transparent 2px border.
- Each avatar uses `TickBadgeAvatar`, which overlays a small tick badge if the user has ticked the currently displayed climb.
- `aria-label` reports audience count.

**Tick badge context:** The tick badges reflect "who has done THIS climb" -- the climb the drawer is currently displaying (`drawerDisplayedItem ?? currentClimbQueueItem`), not necessarily the wall climb.

---

### Below-Fold Sections

Sections are deferred: they mount only after the drawer's open transition completes. The parent `ClimbDetailShellClient` in `mode="play"` uses `startTransition(() => setShowSections(true))` to deprioritize section mounting relative to the above-fold board + header rendering.

When the active climb changes (e.g., tapping a card in Similar Climbs), the scroll container is reset to the top via `scrollTo({ top: 0, behavior: 'smooth' })`.

Sections are rendered as `CollapsibleSection` components -- accordion-style panels that can be expanded/collapsed independently. Each section has a key, label, title, summary, and lazy-loaded content.

The sections, in order:

#### 1. Beta Videos

- **Key**: `beta`
- **Label/Title**: Camera icon + "Beta" text.
- **Default behavior**: `keepExpanded: true` (stays open alongside other sections). `defaultActive: true` (initially expanded, unless a proposal UUID is in the URL).
- **Content**: `BoardseshBetaList` showing deduped video embeds. If no videos: empty state. An "Add" button (`BoardseshBetaAddButton`) toggles to `BoardseshBetaAddPanel` for submitting TikTok/Instagram video links.
- **Summary**: "{N} video(s)" or "No videos yet".
- **Data**: Fetched via GraphQL `GET_BETA_LINKS` query, deduplicated by URL. Stale time: 5 minutes.

#### 2. Your Logbook

- **Key**: `logbook`
- **Label/Title**: "Your Logbook"
- **Content**: `LogbookSection` showing the user's ascent history for this climb. Displays attempts, sends, grades, quality ratings, and comments.
- **Summary**: "{N} attempt(s), {M} send(s)" or "No ascents".

#### 3. Crew Logbook

- **Key**: `crew-logbook`
- **Label/Title**: "Crew Logbook"
- **Content**: `CrewLogbookView` showing sends and attempts by users the current user follows.
- **Summary**: "See your crew's sends".

#### 4. Community

- **Key**: `community`
- **Label/Title**: "Community"
- **Content**: `ClimbSocialSection` with votes (upvote/downvote the climb), comments (threaded, with author avatar/name/timestamp, reply support, voting), and grade proposals (community grade suggestions). If a `proposalUuid` is in the URL search params, this section starts expanded and the proposal is highlighted.
- **Summary**: "Votes, Comments, Proposals".

#### 5. Analytics

- **Key**: `analytics`
- **Label/Title**: "Analytics"
- **Content**: `ClimbAnalytics` showing ascent trends, quality trends, and other statistical data for the climb.
- **Summary**: "Ascents, Quality, Trends".

#### 6. Similar Climbs

- **Key**: `similar-climbs`
- **Label/Title**: Localized "Similar Climbs" text.
- **Default behavior**: `keepExpanded: true` (stays open alongside other sections).
- **Content**: `SimilarClimbsList` -- a horizontal scrollable carousel of similar climbs.

**Similar Climbs details:**

- Fetched via GraphQL `SIMILAR_CLIMBS_QUERY` with Jaccard similarity threshold of 0.5, limit 10.
- Stale time: 5 minutes.
- Climbs are partitioned: compatible climbs (matching the viewer's `size_id`) come first, incompatible climbs are shown after with a dimmed appearance (`opacity` reduced via CSS `.dimmed` class).
- Each card shows:
  - Board thumbnail (canvas or image layers rendering, thumbnail mode)
  - Name (truncated, with title attribute for hover)
  - Formatted grade with color
  - Byline: setter username, quality rating, send count, joined by " · "
  - Ellipsis (`MoreVertOutlined`) button for actions (opens a single shared actions drawer)
- **Tap behavior**: When the queue is available and the climb is compatible, tapping calls `setCurrentClimb(climbStub)`, which activates the climb in the play drawer. When the queue is unavailable, falls back to a `LocaleLink` navigating to the climb's view page.
- **Empty state**: Localized message or "No similar climbs found on this layout".

---

### Nested Queue Drawer

#### Opening

Tapping the queue button in the action bar sets `isQueueOpen=true` and mounts the `QueueDrawer` component. The queue drawer can also be opened/closed programmatically by onboarding tour events (`TOUR_OPEN_PLAY_QUEUE_EVENT`, `TOUR_CLOSE_PLAY_QUEUE_EVENT`).

#### Layout

A `SwipeableDrawer` with `placement="bottom"`, `height="60%"`, `disablePortal` (stacks within the play view drawer), `swipeEnabled=false`, `showDragHandle=false`. Custom drag-to-resize is implemented via `useDrawerDragResize` hook.

**Custom drag header** (`div.queueDragHeader`, `touch-action: none`, `user-select: none`):

- Drag handle bar (horizontal pill, matching the standard drawer drag handle style).
- Title bar: "Queue" title (h6, semibold) on the left. Right side shows:
  - **Normal mode**: History toggle button (`HistoryOutlined`, bordered when active) + Edit button (`EditOutlined`).
  - **Edit mode**: "Clear" button (`DeleteOutlined` + text, clears entire queue) + Close edit button (`CloseOutlined`).

**Queue body** (`div.queueBodyLayout`, flex column):

- Scroll container (`div.queueScrollContainer`): `overflow-y: auto`, `-webkit-overflow-scrolling: touch`, `overscroll-behavior-y: contain`, `touch-action: pan-y`. Has pull-to-close gesture via `usePullToClose` hook.
- `QueueList` component renders the queue in three regions:
  - **History** (collapsible via history toggle, shown by default): Past climbs that have been played. Capped at 5 items with a "Show full history" toggle.
  - **Current** (highlighted): The currently active climb.
  - **Up next**: Future climbs in the queue + suggestions.
- **Bulk remove bar** (bottom, `flex-shrink: 0`): Appears when in edit mode with items selected. Full-width "Remove {N} items" button with `variant="contained"`, `color="error"`.

**On transition end (open):** After the open transition completes, the queue list scrolls to the current climb (`queueListRef.current.scrollToCurrentClimb()`) with a 100ms delay.

**On close:** Resets edit mode, selected items, and history visibility to default. Propagates to parent via `onTransitionEnd(false)`, which sets `queueMounted=false` after the close transition to unmount the component.

#### Interactions

- **Tap climb**: Sets the tapped climb as current, broadcasts to wall in party mode, closes the queue drawer via `PLAY_DRAWER_EVENT`.
- **Swipe on item** (handled by `QueueList` component): Left swipe reveals delete/edit/playlist actions, right swipe reveals favorite toggle.
- **Drag-and-drop reorder**: Items can be reordered by dragging (handled by `QueueList`).
- **Close**: Swipe down on the scroll container (pull-to-close), drag the header down past threshold, or tap outside (handled by drawer backdrop).

---

### Mobile Adaptation Notes

When implementing the Play View in React Native, the following adaptations are required:

#### Bottom Sheet

Replace the web `SwipeableDrawer` with a React Native bottom sheet library (e.g., `@gorhom/bottom-sheet` or `react-native-bottom-sheet`). The play view should open as a full-height bottom sheet.

- The `initialOpenWithoutAnimation` prop maps to the bottom sheet's `animateOnMount: false`.
- Nested drawers (queue, actions, playlist, light control) should use stacked bottom sheets or modal presentations.
- The pull-to-close gesture is handled natively by the bottom sheet library.

#### Board Carousel

- Use `react-native-gesture-handler` for swipe detection (replacing `react-swipeable`).
- Use `react-native-reanimated` for swipe animations (replacing CSS transitions).
- The peek animation (next/previous climb sliding in from edge) maps to an animated `translateX` on sibling views.
- The scroll-prevention logic (non-passive `touchmove` listener) is not needed; gesture handler's `simultaneousHandlers` and `waitFor` manage conflict between horizontal swipe and vertical scroll.

#### Zoom and Pan

- Replace `@use-gesture/react` with `react-native-gesture-handler`'s `PinchGestureHandler` and `PanGestureHandler`.
- Use `react-native-reanimated` shared values for scale and translation (replacing DOM `style.transform` manipulation).
- The floating reset button renders as an `Animated.View` with opacity transition.
- `touch-action` CSS is not applicable; gesture handler conflict resolution handles this natively.

#### Board Rendering

- The SVG board renderer should use `react-native-svg` (`<Svg>`, `<Image>`, `<Circle>` components).
- The canvas renderer path should use a `<Canvas>` from `@shopify/react-native-skia` or fall back to SVG.
- `preserveAspectRatio="xMidYMid meet"` maps directly to `react-native-svg`'s `preserveAspectRatio` prop.
- Background images use `<SvgImage>` with `href` pointing to CDN URLs.

#### Action Bar

- Reposition for thumb ergonomics. Consider a floating action bar at the bottom of the screen, or use the safe area inset to ensure buttons are reachable.
- The lightbulb long-press gesture uses `Pressable`'s `onLongPress` prop (500ms default, adjustable via `delayLongPress`).
- The angle selector drawer should use a right-side modal or bottom sheet.

#### Tick Bar

- Use `KeyboardAvoidingView` or the keyboard-aware bottom sheet variant to handle the comment field's keyboard appearance.
- The grade picker horizontal scroll maps to a `FlatList` with `horizontal={true}`.
- The "expand/collapse" toggle behavior translates directly.
- Haptic feedback (`expo-haptics`) on tick and attempt button presses.

#### Similar Climbs

- Replace the CSS horizontal scroller with a `FlatList` component with `horizontal={true}`, `showsHorizontalScrollIndicator={false}`.
- Each card is a `Pressable` with the board thumbnail rendered via the native SVG/canvas renderer in thumbnail mode.

#### Comments and Below-Fold Sections

- The collapsible sections map to an accordion component or `Animated.View` height transitions.
- Comment threading uses a `FlatList` (or `SectionList` for grouped threads) with reply indentation.
- The `startTransition` deferral pattern maps to `InteractionManager.runAfterInteractions()` for deferred section mounting.

#### URL Synchronization

- URL sync does not apply in React Native. Navigation state is managed by Expo Router's stack/modal navigation.
- Deep links to `/view/{uuid}` should push the play view screen onto the navigation stack.
- The "browser back closes drawer" behavior maps to the hardware back button handler on Android and the swipe-back gesture on iOS.

#### Wake Lock

- Replace the web Wake Lock API with `expo-keep-awake` (`activateKeepAwakeAsync()` / `deactivateKeepAwake()`).

#### Bluetooth / Lightbulb

- Web Bluetooth API is replaced by `react-native-ble-plx` or the shared `@boardsesh/ble-protocol` package.
- The lightbulb button behavior (connect, take control, release control) maps directly; only the BLE transport layer changes.

#### Double-Tap Favorite

- Use `react-native-gesture-handler`'s `TapGestureHandler` with `numberOfTaps={2}` for double-tap detection.
- The heart animation uses `react-native-reanimated`'s `withSpring` or `withTiming` for the scale/opacity burst effect.
- The `Animated.View` overlay with the heart icon should use `pointerEvents="none"`.
