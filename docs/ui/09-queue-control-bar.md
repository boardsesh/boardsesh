## E. Global Persistent Queue Control Bar and Session Mini Bar

The Queue Control Bar is the most complex persistent UI element in the application. It sits between the main content area and the bottom tab bar on all board pages, provides swipe-based queue navigation, quick tick logging, session management, and serves as the primary surface users interact with throughout a climbing session. This section documents every layer, interaction, state transition, and visual behavior in the web implementation, then maps each to the React Native equivalent.

---

### E.1 Queue Control Bar -- Overview

**Visibility rules:**

- Renders on all board-scoped pages (list, view, play, create) when the `GraphQLQueueProvider` is mounted.
- The bar is always present in the DOM once a board context exists. When there is no current climb and no active session, the bar still renders but shows the "Start Sesh" prompt in the session header and a blank swipe container.
- On `/view/{uuid}` routes, the bar seeds the play drawer as open on initial render (no slide-in animation) via `initialOpenWithoutAnimation`.

**Structural layers (top to bottom within the MUI Card):**

1. **Session Header Row** -- collapsible via CSS grid transition; collapses when tick mode is active
2. **Tick Row** -- collapsible via CSS grid transition; expands when tick mode is active
3. **Swipe Container** -- the main bar with climb thumbnail, title, and action buttons

**Reconnect state:** When the WebSocket connection is in `reconnecting`, `stale`, or `error` state (and the browser is online), the entire bar renders a special reconnect view instead of the normal three-layer structure. This shows a spinner, reconnect message, and cancel button.

**Card styling:**

- Mobile (`< 768px`): Full-width with 12px horizontal margin, 4px border-radius, no top border, subtle shadow (`0 2px 8px rgba(0,0,0,0.12)`)
- Desktop (`>= 768px`): Max-width 480px, centered, 16px border-radius, 1px solid border, deeper shadow
- Dark mode: Border color shifts to `rgba(255,255,255,0.1)`, shadow opacity increases

**Root element:** `id="onboarding-queue-bar"`, class `queue-bar-shadow`, `data-testid="queue-control-bar"`.

---

### E.2 Session Header Row

The session header row is a strip that sits at the top of the card. It uses CSS grid row collapse (`grid-template-rows: 0fr` to `1fr`) with a 200ms ease-out transition so it smoothly collapses when tick mode activates and smoothly re-expands when tick mode deactivates.

#### E.2.1 Layout when session is active

```
[Session Name (flex:1)]  [Avatar Group / Close Button]  [Queue Badge Icon]
```

- **Session name:** Truncated with ellipsis, 12px font, weight 600. Displays `persistentSession.name` or `activeSession.sessionName` or a generated name via `generateSessionName(startedAt, [boardName])`.
- **Avatar group:** Shows up to 3 participants via MUI `AvatarGroup` (28x28 avatars, 11px font, 2px transparent border). Each avatar is a `TickBadgeAvatar` component.
- **Queue badge icon:** `FormatListBulletedOutlined` icon (18px) wrapped in a `Badge` showing `queue.length`, max 99, primary color. The badge uses `themeTokens.badge.small` styling.

**Tap targets:**

- Tap anywhere on the session header row (outside avatar group and queue icon) -> dispatches `SESH_SETTINGS_DRAWER_EVENT` which opens the session settings drawer in the global header
- Tap avatar group area -> toggles `participantsExpanded` state (expands/collapses participant bar below)
- Tap queue badge icon -> opens queue drawer (`setActiveDrawer('queue')`)

**Background color:** Uses `sessionTintColor` (derived from current climb grade via `getGradeTintColor(difficulty, 'session', isDark)`), falls back to transparent (dark) or `var(--semantic-surface)` (light).

**Visual treatment:**

- 4px vertical padding, 12px horizontal padding
- Bottom border: `1px solid rgba(0,0,0,0.06)` (light), `rgba(0,0,0,0.3)` (dark)
- Box shadow: `0 2px 4px rgba(0,0,0,0.08)` (light), `0 2px 4px rgba(0,0,0,0.25)` (dark)
- Hover (pointer devices): `filter: brightness(0.95)` (light), `brightness(1.1)` (dark)
- Active press: `filter: brightness(0.9)` (light), `brightness(1.15)` (dark)

#### E.2.2 Layout when no session is active

```
[Play circle icon]  [Start Sesh text (flex:1)]  [Queue Badge Icon]
```

- `PlayCircleOutlineOutlined` icon (16px, 70% opacity) followed by "Start Sesh" text
- Entire row is tappable -> opens `StartSeshDrawer`
- Uses `gradeTintColor` background instead of `sessionTintColor`
- Row is right-justified (`justifyContent: 'flex-end'`)

#### E.2.3 Offline banner overlay

When `isDisconnected` is true and the user has not dismissed the banner, an absolute-positioned overlay covers the session header row:

```
[CloudOffOutlined icon (14px)]  [Offline message text]  [CloseOutlined icon (14px, 60% opacity)]
```

- Background: `rgba(245,245,245,0.85)` with 20px blur (light), `rgba(40,40,40,0.85)` with blur (dark)
- Font: `0.8rem`, neutral-600 color
- Tap anywhere on the banner dismisses it (sets `dismissedDisconnect = true`)
- `dismissedDisconnect` resets to false when connection is restored

**Offline message text varies:**

- No session: `t('queueBar.offline.idle')`
- Session with >1 user: `t('queueBar.offline.party')`
- Solo session: `t('queueBar.offline.solo')`

#### E.2.4 Expandable participant bar

Appears below the session header when `participantsExpanded` is true. Uses CSS grid row collapse with 200ms transitions on `grid-template-rows`, `opacity`, and `border-bottom-color`.

**When there is only 1 participant (solo session):**

- Shows invite copy text + share icon button
- QR code (`QRCodeSVG`, 140px, level "M", margin 4) for the session join URL (`/join/{sessionId}`)
- Share button triggers `shareWithFallback` with the session URL

**When there are multiple participants:**

- Horizontal scrolling row of participant chips
- Each chip: `TickBadgeAvatar` (32px) + username text below (10px, max-width 56px, centered, truncated)
- Row padding: 8px vertical, 12px horizontal when expanded
- Scrollbar hidden (`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`)
- 12px gap between participant chips

#### E.2.5 TickBadgeAvatar component

Each avatar can show a tick badge overlay:

1. **Tick badge (bottom-right):** Green circle (16x16, `themeTokens.colors.success`) with white `CheckOutlined` icon (10px). Visible when the participant has ticked the current climb. Determined by merging backend `tickedBy` array on the queue item with locally tracked `localTickedClimbs` set.

#### E.2.6 Participant deduplication

Session users are deduplicated by `userId` (stable DB UUID), falling back to connection `id` for unauthenticated users. After dedup, participants keep their existing order (stable sort). (In the always-live model there is no driver to float to position 0.)

---

### E.3 Swipe Container (Main Bar)

The swipe container is the primary interaction surface. It renders the current climb's thumbnail, title/grade, and action buttons.

#### E.3.1 Layout

```
[Board Preview (44px)]  [gap]  [Text Swipe Clip (flex:1)]  [gap]  [Button Cluster]
```

**Board preview container:** Fixed 44px width, flex-shrink 0. Contains `ClimbThumbnail` which renders a miniature board with highlighted holds. On enter animation (after swipe navigation), applies a 120ms `thumbnailFadeIn` keyframe animation (scale 0.85 -> 1, opacity 0 -> 1).

**Text swipe clip:** `overflow: hidden`, `flex: 1`, `min-width: 0`, `position: relative`. Contains the current climb text (which slides with the swipe gesture) and the peek text (absolutely positioned, slides in from the edge during swipe).

**Button cluster:** `flex: none`, stacked horizontally with 4px spacing. Content varies by breakpoint and tick mode state.

#### E.3.2 Background color

The swipe container background dynamically changes based on the current climb's difficulty grade:

- `getGradeTintColor(displayedClimb?.difficulty, 'default', isDark)` computes a grade-specific tint color
- Fallback: transparent (dark mode) or `var(--semantic-surface)` (light mode)
- Padding: `themeTokens.spacing[2]` vertical, `themeTokens.spacing[3]` horizontal

When tick mode is active, the `displayedClimb` is frozen to the climb that was current when tick mode was entered (`tickClimb`), preventing the grade tint from changing if another user advances the queue.

#### E.3.3 Swipe navigation

Horizontal swipe on the main bar navigates between queue items. Implemented via `useCardSwipeNavigation` hook which wraps `react-swipeable`.

**Parameters:**

- `threshold`: 80px (distance to trigger navigation)
- `delayNavigation`: true (navigation fires after exit animation completes, not immediately)
- `canSwipeNext`: `!viewOnlyMode && !!nextClimb && !tickBarActive`
- `canSwipePrevious`: `!viewOnlyMode && !!previousClimb && !tickBarActive`
- Touch action: `pan-y` (vertical scroll is native; horizontal swipe is JavaScript-controlled)

**Animation timing constants:**

- `EXIT_DURATION`: 300ms -- card slides off-screen
- `SNAP_BACK_DURATION`: 200ms -- card snaps back if threshold not met
- `CLIP_EXIT_DURATION`: 100ms -- text leaves the narrow clip area faster than the full exit
- `ENTER_ANIMATION_DURATION`: 170ms -- enter crossfade after navigation completes

**Swipe states:**

- `swipeOffset` (number): Current horizontal pixel offset of the text
- `isAnimating` (boolean): True during exit/enter animation
- `animationDirection` ('left' | 'right' | null): Direction of exit animation
- `enterDirection` ('from-left' | 'from-right' | null): Direction of enter crossfade

**Text transition logic:**

- During enter animation: `transition: 'none'` (snap instantly)
- During exit animation: `transform {EXIT_DURATION}ms ease-out`
- When swipe offset returns to 0: `transform {SNAP_BACK_DURATION}ms ease-out`
- During active swipe: `transition: 'none'` (follow finger directly)

**Peek behavior:**
The peek text shows the next or previous climb sliding in from the opposite edge during swipe:

- Next climb peeks from the right: `translateX(max(0px, calc(100% + {swipeOffset}px)))`
- Previous climb peeks from the left: `translateX(min(0px, calc(-100% + {swipeOffset}px)))`
- The `max(0px, ...)` / `min(0px, ...)` clamping prevents the peek text from overshooting past position 0
- Peek text is `pointer-events: none`, `cursor: default`

**Swipe hint animation:**
On first load for touch devices (`pointer: coarse`), a one-time swipe hint plays to teach users about horizontal navigation:

- Checks `getPreference<boolean>('swipeHint:queueBarSeen')` from IndexedDB
- If not seen: after 800ms delay, the element with `id="onboarding-queue-toggle"` peeks left twice
  - Each peek: slide to `translateX(-40px)` over 350ms ease-out, hold 500ms, slide back over 250ms ease-out
  - Two peeks with 300ms gap between them
- After completing, sets `setPreference('swipeHint:queueBarSeen', true)` to prevent future replays
- Skipped if tick mode is active or no current climb exists
- All animations are cancellable via `AbortController`-style cleanup

#### E.3.4 Thumbnail interaction

Tap thumbnail -> dispatches `PLAY_DRAWER_EVENT` (no climb payload) to open the play-view drawer in wall-view mode. The drawer reads `currentClimbQueueItem` directly. Disabled when `viewOnlyMode` is true or no current climb exists.

#### E.3.5 Title interaction

Tap the title/grade area (the `onboarding-queue-toggle` element):

- Same behavior as thumbnail tap: opens play-view drawer via `dispatchOpenPlayDrawer()`
- **Disabled during tick mode:** When `tickBarActive` is true, the title has no `role`, `tabIndex`, or click handler -- it becomes non-interactive
- Tracks `'Play Drawer Opened'` analytics event with `source: 'bar_tap'`

#### E.3.6 Button cluster

Buttons are laid out in a horizontal `Stack` with 4px spacing. Visibility depends on breakpoint and mode:

| Button         | Mobile (<768px) | Desktop (>=768px)                     | Tick Mode            |
| -------------- | --------------- | ------------------------------------- | -------------------- |
| Mirror         | Hidden          | Visible (if board supports mirroring) | Same                 |
| Play mode link | Hidden          | Visible (if not already on /play/)    | Same                 |
| Nav prev/next  | Hidden          | Visible                               | Same                 |
| Attempt        | Hidden          | Hidden                                | Visible              |
| Tick           | Visible         | Visible                               | Visible (saves tick) |

**Mirror button:** `SyncOutlined` icon. When mirrored state is active: purple background (`themeTokens.colors.purple`), white icon, primary color. Calls `mirrorClimb()` and tracks `'Mirror Climb Toggled'`.

**Play mode link:** `OpenInFullOutlined` icon wrapped in `LocaleLink` to the play URL. Tracks `'Play Mode Entered'`.

**Navigation buttons (desktop only):** Two `QueueNavButton` components -- previous (`FastRewindOutlined`) and next (`FastForwardOutlined`). Each calls `setCurrentClimbQueueItem(target)` where target is from `getPreviousClimbQueueItem()` or `getNextClimbQueueItem()`. Also tracks `'Queue Navigation'` and `'Wall Advance'` analytics events.

**Attempt button (tick mode only):** `PersonFallingIcon` with error-muted background (`themeTokens.colors.errorMuted`), error-colored icon. Calls `quickTickBarRef.current?.saveAttempt(element)`. Wrapped in `TickButtonWithLabel` with label text.

**Tick button:** Persistent `TickButton` component. Behavior depends on state:

- **No tick mode active + authenticated:** Tap activates tick mode (`setActiveDrawer('tick')`)
- **Tick mode active:** Tap saves the tick (`quickTickBarRef.current?.save(element)`)
- **Not authenticated:** Either opens external Aurora app URL or shows sign-in drawer
- Shows ascent badge count from logbook
- Icon changes based on `isFlash` and `ascentType` state

---

### E.4 Quick Tick Mode (Tick Row)

The tick row is a collapsible panel between the session header and the swipe container. It uses the same CSS grid row collapse pattern (`grid-template-rows: 0fr/1fr`) as the session header, with 200ms ease-out transitions on both `grid-template-rows` and `opacity`.

#### E.4.1 Entry and exit

**Entry:** `setActiveDrawer('tick')` sets `tickBarActive = true`, which:

1. Sets `tickRowVisible = true` (keeps DOM mounted)
2. Collapses the session header row (removes `sessionHeaderExpanded` class)
3. Expands the tick row (adds `tickRowExpanded` class)
4. Restores persisted expanded state from `getPreference<boolean>('tickBarExpanded')`
5. Closes expanded participants panel
6. Snapshots the current climb into `tickClimb` so the bar stays frozen on it

**Exit:** `setActiveDrawer('none')` sets `tickBarActive = false`, which:

1. Resets `tickSwipeOffset` to 0
2. Resets `isFlash` to false
3. Resets `ascentType` to 'send'
4. Resets `tickBarExpanded` to false
5. After 200ms delay (to let collapse animation play): sets `tickRowVisible = false`, clears `tickComment` and `tickCommentFocused`

**Backdrop overlay:** When tick mode is active, a full-screen fixed overlay is rendered via `createPortal` to `document.body`:

- Background: `var(--overlay-light)`
- z-index: 9
- 200ms opacity transition
- Tap anywhere on overlay dismisses tick mode
- `pointer-events: auto` only when active

#### E.4.2 Layout

```
[Drag Handle Bar (centered, absolute)]
[Toolbar: [Expand/Collapse button (left)]  [Close button (right)]]
[QuickTickBar controls]
[Comment field]
```

**Drag handle bar:** Centered absolute element -- 36px wide, 4px tall, 2px border-radius, `var(--neutral-200)` background (dark: `var(--neutral-500)`). Visual-only grab indicator at the top of the tick row.

**Toolbar row:** Flex row with space-between alignment.

- Left: Expand/collapse button with up/down chevron icon (16px, 70% opacity) + text label ("More" / "Less"), 12px font, weight 600
- Right: Close button -- `CloseOutlined` (16px) with `action.selected` background, `action.focus` hover, 2px padding

**QuickTickBar:** The `QuickTickBar` component manages tick form state:

- **Tick target:** Snapshots the climb on first render so edits to grade/quality persist even if the wall climb changes
- **Quality:** Star rating (null by default)
- **Difficulty:** Grade override (undefined by default, uses climb grade)
- **Attempt count:** Number input starting at 1
- **Ascent type:** Derived -- flash if no prior history and 1 attempt, otherwise send

**Compact layout (default):**

```
[Comment input (flex:1)]  [Grade button]  [Star picker]  [Tries picker]
```

**Expanded layout:**

```
[Full-height comment field]
[Grade picker (scrollable)]
[Star picker]
[Tries picker]
[Ascent type toggle]
```

Each picker section has `data-scrollable-picker` attribute to prevent swipe-to-dismiss gestures from interfering with horizontal scroll in grade pickers.

#### E.4.3 Comment field

**Compact mode:**

- Inline `TextField` -- single line, `minRows: 1`, `maxRows: 1` (expands to 4 when focused)
- `ChatBubbleOutlineOutlined` start adornment (16px, 50% opacity)
- Max length: 2000 characters
- When focused (`tickCommentFocused: true`): Container gets `position: relative`, `height: 40px`, `z-index: 2`. The TextField inside is absolutely positioned so it grows downward over the queue bar without reflowing the tick row.

**Expanded mode:**

- Separate `TextField` -- `minRows: 2`, `maxRows: 4`
- No start adornment icon
- Same max length and styling

#### E.4.4 Vertical swipe behavior

The tick row supports vertical swipe-to-dismiss gestures via `react-swipeable`:

**Swipe tracking:**

- `tickSwipeOffset` tracks vertical displacement in pixels
- Swipe is disabled when comment field is focused (`tickCommentFocused`) or tick mode is inactive
- Horizontal swipe is ignored (`Math.abs(deltaX) > Math.abs(deltaY)`)
- Targets with `[data-scrollable-picker]` attribute are excluded

**Compact mode swipe thresholds:**

- Swipe up >= 50px: Expand tick bar (`handleTickBarExpandedChange(true)`)
- Swipe down >= 80px: Dismiss tick mode entirely (`setActiveDrawer('none')`)
- Both directions tracked for visual feedback

**Expanded mode swipe thresholds:**

- Swipe down >= 120px (or velocity > 0.5): Dismiss tick mode entirely
- Swipe down >= 50px: Collapse to compact (`handleTickBarExpandedChange(false)`)
- Swipe up: No action (already expanded)
- Only downward offset tracked for visual feedback

**Visual feedback during downward swipe:**

- `gridTemplateRows` shrinks: `fraction = max(0, 1 - offset/150)`, applied as `${fraction}fr`
- `opacity` fades: same fraction value
- `transition: none` during active swipe (follows finger directly)
- Spring-back on release: resumes `transition: grid-template-rows 200ms ease-out, opacity 200ms ease-out`

**Expanded state persistence:**

- `handleTickBarExpandedChange(expanded)` stores the value in `setPreference('tickBarExpanded', expanded)` (IndexedDB)
- On next tick mode entry, the persisted value is restored

#### E.4.5 Tick submission

**Save (via tick button or save trigger):** Calls `quickTickBarRef.current?.save(originElement)` which:

1. Builds the tick payload (quality, difficulty, attempt count, comment, ascent type)
2. Calls `saveTick` mutation
3. On success: adds climb UUID to `localTickedClimbs` set (for tick badge display), calls `onSave` which dismisses tick mode
4. Shows confirmation animation (confetti from origin element position)
5. On error: calls `onError` which shows snackbar `t('queueBar.tickError')`

**Save attempt:** Calls `quickTickBarRef.current?.saveAttempt(originElement)` -- same flow but ascent type is forced to 'attempt'.

---

### E.5 Reconnect View

When `isReconnecting` is true (session exists, not fully disconnected, connection state is `reconnecting`/`stale`/`error`), the entire card renders a reconnect-specific layout:

**Reconnect row:**

```
[CircularProgress (16px, thickness 5)]  [Message text]  [Cancel button]
```

- Message: "Connection error" or "Reconnecting..." depending on `connectionState`
- Cancel button: `MuiButton` text variant, small size

**Confirm row (after tapping cancel):**

```
[Confirmation text]  [Leave button (error color, CloseOutlined)]  [Keep button (CheckOutlined)]
```

- Leave button calls `handleLeaveSession()` which tries `endSession()`, falls back to `disconnect()`, shows warning snackbar on failure
- Keep button dismisses the confirm row

The reconnect view still shows the climb thumbnail (using the same grade tint background) but replaces the title area with the reconnect/confirm UI.

---

### E.6 Queue Drawer (Expanded Queue List)

#### E.6.1 How it opens

- Tap queue badge icon in session header
- Tap queue button in play-view action bar
- Opens as a `SwipeableDrawer` from the bottom, 60% height, with drag-to-resize handle

#### E.6.2 Drawer header

```
[Drag handle zone (horizontal)]
[Title "Queue" (left)]  [History toggle | Edit | Clear | Close (right)]
```

**Header actions (non-edit mode):**

- History toggle: `HistoryOutlined` icon button -- when active, shows bordered style (`border: 1px solid divider`). Toggles `showHistory` state.
- Edit button: `EditOutlined` icon -- enters edit mode

**Header actions (edit mode):**

- Clear all: `DeleteOutlined` icon + "Clear" text button -- removes all items from queue
- Close edit: `CloseOutlined` icon -- exits edit mode

**Header styling:** `themeTokens.spacing[4]` vertical padding, `themeTokens.spacing[6]` horizontal padding, bottom border `1px solid var(--neutral-200)`.

#### E.6.3 Queue list structure (virtualized)

The `QueueList` component uses `@tanstack/react-virtual` (`useVirtualizer`) with a flat row model. All row types are flattened into a single discriminated union array (`FlatRow[]`):

**Row types in order:**

| Row Type            | Height Estimate | Description                                              |
| ------------------- | --------------- | -------------------------------------------------------- |
| `history-show-all`  | 44px            | "Show full history" button (shows count of hidden items) |
| `history-item`      | 102px           | Past climbs, 60% opacity                                 |
| `history-divider`   | 17px            | MUI Divider separating history from current              |
| `current-item`      | 102px           | Highlighted current climb, grade tint background         |
| `future-item`       | 102px           | Upcoming queue items                                     |
| `suggestion-header` | 36px            | "Next up" overline text                                  |
| `suggestion`        | 102px           | Similar climbs from search/playlist                      |
| `loading`           | 220px           | Three-row skeleton placeholder                           |
| `end-message`       | 52px            | "No more climbs" disabled text                           |

**Virtualizer configuration:**

- Overscan: 10 items
- Scroll element: External ref from parent (for drawer resize coordination)
- Item keys: `q-{uuid}` for queue items, `s-{uuid}` for suggestions, static strings for meta rows
- Items use `contain: layout style paint` and absolute positioning with `translateY` for performance

**History display:**

- Default limit: `DEFAULT_HISTORY_DISPLAY_LIMIT = 5` most recent history items
- "Show full history" button shows hidden count and expands to show all
- `showFullHistory` resets to false when the drawer becomes inactive (`active` prop transitions to false)

**Scroll-to-current:** On drawer open (after 100ms transition delay), `scrollToIndex(scrollTargetFlatIndex, { align: 'center', behavior: 'smooth' })` centers the current item.

**Suggestions (infinite scroll):**

- Only rendered when `active && !viewOnlyMode`
- Loads from either playlist suggestions or search suggestions
- Loading state shows three skeleton rows (64x60 thumbnail + text + 32x32 button placeholder)
- Suggestion thumbnail tap calls `previewClimbFromBrowse(climb)` -- in solo, sends to wall; in party, previews locally

#### E.6.4 Queue item row (QueueClimbListItem)

Each queue item wraps `ClimbListItem` with queue-specific behavior:

**Visual states:**

- **Current item:** Grade tint background via `getGradeTintColor(difficulty, 'light', isDark)`, fallback to `var(--semantic-selected)`
- **History item:** `var(--neutral-100)` background, 60% content opacity
- **Future item:** Transparent background, full opacity

**Content layout:**

```
[Thumbnail (64px)]  [Climb Title + Grade + Setter]  [After-title slot]  [Three-dot menu]
```

**After-title slot varies:**

- **History items:** Tick badge -- `TickIcon` wrapped in `MuiBadge` showing ascent count. Badge color: green (`themeTokens.colors.success`) for successful ascent, red (`themeTokens.colors.error`) for attempts only. Tap opens tick drawer for that climb.
- **Current + future items:** Attribution avatar -- `MuiAvatar` (24x24) showing the user who added the climb (`addedByUser.avatarUrl`) with tooltip. If no user info, shows Bluetooth icon (climb was added via BLE board).
- **Editable items:** Edit button (`EditOutlined`, 16px) appears before the trailing element, routed to `/b/{boardSlug}/{angle}/create?editClimbUuid={uuid}`.

**Swipe gestures (non-edit mode):**

| Direction                | Threshold | Action                                    | Visual                                                                     |
| ------------------------ | --------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| Swipe left (short, 60px) | 60px      | Primary action: opens actions drawer      | Primary color background                                                   |
| Swipe left (long, 150px) | 150px     | Secondary action: opens playlist selector | Neutral-600 background                                                     |
| Swipe right              | 60px      | Tick the climb                            | Green (`themeTokens.colors.success`) background + white CheckOutlined icon |

Note: Queue items override the default swipe-right action (which would be "add to queue" on non-queue list items) to "tick" instead, since items are already in the queue.

**Tap interactions:**

- Single tap: `setCurrentClimbQueueItem(item)` -- makes this the active climb
- Thumbnail tap: `setCurrentClimbQueueItem(item)` then `dispatchOpenPlayDrawer()` -- sets active and opens play drawer

**Drag-and-drop reorder (non-edit mode):**
Each item registers as both a `draggable` source and a `dropTargetForElements` using `@atlaskit/pragmatic-drag-and-drop`:

- `draggable` provides `{ index, id: item.uuid }` as initial data
- Drop target uses `attachClosestEdge` with `allowedEdges: ['top', 'bottom']`
- During drag, `DropIndicator` renders at the closest edge (top or bottom)
- On drop, `monitorForElements` at the list level computes new order via `reorder()` from `@atlaskit/pragmatic-drag-and-drop/reorder` and calls `setQueue(newQueue)`

**Edit mode:**

- Checkbox appears left of each item
- Tap anywhere toggles selection
- Drag-and-drop is disabled
- Swipe gestures are disabled
- Selected items can be bulk-removed via the sticky bar at the bottom

#### E.6.5 Shared drawers (performance optimization)

The queue list uses a shared-drawer pattern instead of per-item drawers:

1. **One global actions drawer:** `actionsClimb` state holds the climb; drawer mounts only when non-null. Contains `ClimbActions` with excluded actions computed via `getExcludedClimbActions(boardName, 'list')`.

2. **One global playlist selector drawer:** `playlistClimb` state; `PlaylistSelectionContent` inside a SwipeableDrawer.

3. **One global tick drawer:** `tickClimb` + `tickDrawerVisible` state; renders `LogAscentDrawer` when authenticated, sign-in prompt when not.

This avoids 100+ nested drawer trees that would result from rendering a drawer per queue item.

#### E.6.6 Drawer interactions

- **Drag-to-resize:** `useDrawerDragResize` hook manages height changes by dragging the handle
- **Pull-to-close:** `usePullToClose` hook handles downward-swipe-to-close on the scroll container
- **Close cleanup:** Resets edit mode, selected items, and show-history state to defaults

---

### E.7 Session Overview Panel (Session Details)

The `SessionOverviewPanel` component renders session statistics and can appear in two modes.

#### E.7.1 Compact mode

Renders when `compact={true}`, typically within the sesh-settings drawer or session header expansion:

```
[Board Thumbnail (90px square)]  [Board Name (bold)]
                                  [Angle Selector dropdown]
```

- Board thumbnail: `BoardRenderer` with `thumbnail fillHeight` mode, 6px border-radius, `var(--neutral-100)` background, subtle shadow
- Board name: `body2` typography, weight 600. Shows `namedBoardName` or capitalized `boardDetails.board_name`
- Angle selector: `AngleSelector` component with current angle and available angles for the board

After the board info, renders `afterParticipants` slot (participant list) and goal (if set).

#### E.7.2 Full mode

Renders when `compact={false}`, shows all session statistics:

**Stats chips (wrapped flex row, 8px gap):**

| Chip                      | Condition                       | Style                                                                                         |
| ------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| Flashes                   | `totalFlashes > 0`              | `bgcolor: success.main`, `color: success.contrastText`, `FlashOnOutlined` icon                |
| Sends (excluding flashes) | `totalSends - totalFlashes > 0` | `color="primary"`, `CheckCircleOutlineOutlined` icon                                          |
| Attempts                  | `totalAttempts > 0`             | `variant="outlined"`, `ErrorOutlineOutlined` icon                                             |
| Duration                  | `durationMinutes > 0`           | `variant="outlined"`, `TimerOutlined` icon. Format: `Xm` for <60min, `Xh Ym` otherwise        |
| Climb count               | Always                          | `variant="outlined"`, text only                                                               |
| Hardest grade             | `hardestGrade` exists           | `variant="outlined"`, formatted via `useGradeFormat`. Shows skeleton while grade format loads |

**Session goal (if set):**

```
[FlagOutlined (16px, action color)]  [Goal text (body2, text.secondary)]
```

**Board types (if any):**

```
[Chip per board type, capitalized, small, outlined]
```

**Grade distribution chart (if data exists):**

- `CssBarChart` component inside a `Card`
- Height: 160px (desktop), 120px (mobile)
- Gap: 3px between bars
- Bars built via `buildSessionGradeBars(gradeDistribution, formatGrade)`
- Legend below chart: colored squares (10x10, 2px border-radius) + caption text, centered, 12px gap

#### E.7.3 Summary parts builder

`buildSessionSummaryParts()` function creates a condensed string array for collapsed display:

- "X flashes" (if any)
- "X sends" (non-flash sends, if any)
- "X attempts" (if any)
- "X climbs" (always)
- "Hardest: {grade}" (if exists, formatted via `formatGrade`)

---

### E.8 Queue State Management (QueueContext)

The `GraphQLQueueProvider` is the central state manager. It uses a reducer pattern with fine-grained context splits for performance.

#### E.8.1 Context architecture (six separate contexts)

| Context                   | Data                                                       | Re-render trigger                 |
| ------------------------- | ---------------------------------------------------------- | --------------------------------- |
| `CurrentClimbContext`     | `{ currentClimb, currentClimbQueueItem }`                  | Wall climb changes                |
| `CurrentClimbUuidContext` | `string \| null`                                           | Only the UUID string changes      |
| `QueueListContext`        | `{ queue, suggestedClimbs }`                               | Queue array or suggestions change |
| `SearchContext`           | `{ searchParams, results, counts, fetching states }`       | Search state changes              |
| `SessionContext`          | `{ viewOnlyMode, connectionState, sessionId, users, ... }` | Session metadata changes          |
| `QueueActionsContext`     | All action functions                                       | Never (stable identity)           |

The combined `QueueContext` still exists for backward compatibility and the queue-bridge plumbing.

#### E.8.2 State shape

```typescript
type QueueState = {
  queue: ClimbQueueItem[]              // All items (history + current + future)
  currentClimbQueueItem: ClimbQueueItem | null  // The climb on the wall
  climbSearchParams: SearchRequestPagination    // Filter/sort state
  playlistSuggestionSource: PlaylistSuggestionSource | null
  hasDoneFirstFetch: boolean
  needsResync: boolean
  pendingCurrentClimbUpdates: Map<string, ...>
}
```

#### E.8.3 Key actions

| Action                                | Behavior                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `addToQueue(climb, source)`           | Creates `ClimbQueueItem` with UUID, dispatches `DELTA_ADD_QUEUE_ITEM`, broadcasts via persistent session if connected, buffers if offline |
| `removeFromQueue(item)`               | Dispatches `DELTA_REMOVE_QUEUE_ITEM`, broadcasts removal                                                                                  |
| `setCurrentClimb(climb, options)`     | Creates item, dispatches `DELTA_UPDATE_CURRENT_CLIMB` with `insertAfterCurrent: true`, broadcasts, returns the new item                   |
| `setCurrentClimbQueueItem(item)`      | Sets an existing queue item as current (no new item creation)                                                                             |
| `previewClimbFromBrowse(climb)`       | Calls `setCurrentClimb` + opens drawer. In a session this broadcasts to everyone (always-live)                                            |
| `mirrorClimb()`                       | Toggles mirrored flag on current climb, dispatches `DELTA_MIRROR_CURRENT_CLIMB`                                                           |
| `setQueue(newQueue)`                  | Bulk replace after reorder, broadcasts full queue via `persistentSession.setQueue()`                                                      |
| `getNextClimbQueueItem(options?)`     | Walk forward: queue first, then suggestions. With `suggestionsOnly: true`, walks only suggestions                                         |
| `getPreviousClimbQueueItem(options?)` | Walk backward: queue only by default. With `suggestionsOnly: true`, walks suggestions backward                                            |
| `replaceQueueItem(uuid, climb)`       | Replace an existing item's climb (used by create form during edit)                                                                        |
| `fetchMoreClimbs()`                   | Trigger next page of search results for suggestions                                                                                       |

#### E.8.4 Queue restoration

On mount, the queue state is restored from one of two sources:

1. **Persistent session (party mode):** When `isPersistentSessionActive && hasConnected`, dispatches `INITIAL_QUEUE_DATA` with `persistentSession.queue` and `persistentSession.currentClimbQueueItem`.

2. **In-memory bridge (solo, SPA navigation):** When no party session and `isLocalQueueLoaded && localBoardPath === baseBoardPath`, restores from `persistentSession.localQueue` and `localCurrentClimbQueueItem`.

#### E.8.5 Real-time sync via queue event subscription

The `useQueueEventSubscription` hook subscribes to `persistentSession.subscribeToQueueEvents()` and dispatches reducer actions:

| Server Event          | Reducer Action                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `FullSync`            | `INITIAL_QUEUE_DATA` with full queue + current climb                                                           |
| `QueueItemAdded`      | `DELTA_ADD_QUEUE_ITEM` with item and optional position                                                         |
| `QueueItemRemoved`    | `DELTA_REMOVE_QUEUE_ITEM` with uuid                                                                            |
| `QueueReordered`      | `DELTA_REORDER_QUEUE_ITEM` with uuid, oldIndex, newIndex                                                       |
| `CurrentClimbChanged` | `DELTA_UPDATE_CURRENT_CLIMB` with current item, server event flag, client/correlation IDs for echo suppression |
| `ClimbMirrored`       | `DELTA_MIRROR_CURRENT_CLIMB` with mirrored flag and mirroredUuid for race-condition guard                      |

**Echo suppression:** When `CurrentClimbChanged` arrives from the server with a `correlationId` matching a locally-dispatched pending update, the event is suppressed to prevent double-application.

**Resync mechanism:** When `needsResync` flag is set (corrupted data detected), triggers `persistentSession.triggerResync()` and clears the flag.

#### E.8.6 Offline handling

**Offline queue buffer:**

- `useOfflineQueueBuffer` hook maintains an array of items added while disconnected
- Buffer limit exists; shows warning snackbar when full
- Synced to `persistentSession.offlineBufferRef` for FullSync merge

**Offline reconciliation:**

- `useOfflineReconciliation` hook pushes buffered additions on reconnect
- Watches `isDisconnected`, `isPersistentSessionActive`, `hasConnected`, `users`

**Mutation guard:**

- `useMutationGuard` returns `viewOnlyMode` and `canMutate`
- `viewOnlyMode` is true when connected to a session but can't mutate (e.g., read-only viewer)
- `guardMutation()` returns true (blocks) when mutation is not allowed; callers check and early-return

#### E.8.7 Wall-confirmed state

- Sessions are always-live: there is no driver to track. Any participant's climb change broadcasts to everyone and is relayed to the board by whoever holds a BLE connection.
- Wall-confirmed state comes from session events: `WallConfirmedClimb` lights the lightbulb, `WallDisconnected` turns it off (the current climb is preserved). Pressing the lightbulb re-asserts the current climb to the board.

---

### E.9 Play-View Drawer Integration

The `PlayViewDrawer` is rendered from the queue control bar but documented separately. Key integration points:

- `activeDrawer === 'play'` controls open state
- `drawerDisplayedItem` state holds a climb when opened via browse or direct `/view/{uuid}` hit
- Reset to null on drawer close and when `activeDrawer` leaves 'play'
- `PLAY_DRAWER_EVENT` listener stores climb payloads

**MiniSessionBar** (inside the play-view drawer):

- Shows the current climb on the wall; the lightbulb re-asserts the current climb (lit when `WallConfirmedClimb` confirms it, unlit after `WallDisconnected`)
- Audience AvatarGroup on the right side
- Warm whisper tint background: `color-mix(in srgb, warning 5%, transparent)`

---

### E.10 Mobile Adaptation Notes

#### E.10.1 Queue control bar positioning

- Render as a persistent bottom bar using absolute/fixed positioning above the Expo Router tab bar
- Use `react-native-safe-area-context` for bottom inset handling
- The bar should be part of the tab layout's persistent UI, not per-screen

#### E.10.2 Swipe navigation

Replace `react-swipeable` (DOM-based) with `react-native-gesture-handler` `PanGestureHandler`:

- Configure `activeOffsetX` to match the 80px threshold
- Use `Gesture.Pan()` from RNGH v2 with `failOffsetY` to let vertical scroll pass through
- Map `swipeOffset` to a `react-native-reanimated` `useSharedValue` for 60fps tracking
- Exit and snap-back animations: `withTiming` with matching durations (300ms exit, 200ms snap)

**Peek behavior:** Use `Animated.View` with `translateX` transform driven by the shared value. Clamp via `interpolate()` with `Extrapolation.CLAMP`.

**Swipe hint:** Replace DOM `animate()` with Reanimated `withSequence` + `withDelay` + `withTiming`. Replace IndexedDB check with AsyncStorage (`@react-native-async-storage/async-storage`).

#### E.10.3 Tick row expand/collapse

Replace CSS grid collapse with Reanimated `useAnimatedStyle`:

- Shared value `tickRowHeight` transitions between 0 and measured content height
- `opacity` shared value transitions 0 to 1
- Use `withTiming(value, { duration: 200, easing: Easing.out(Easing.ease) })`
- Vertical swipe-to-dismiss: `PanGestureHandler` with `onGestureEvent` updating height shared value

#### E.10.4 Queue list

Replace `@tanstack/react-virtual` with `@shopify/flash-list`:

- Set `estimatedItemSize: 102`
- Use `overrideItemLayout` for non-standard row heights (divider: 17, header: 36, loading: 220, end: 52)
- `getItemType` returns the discriminated union type for recycling optimization
- Sticky header for "Next up" section via `stickyHeaderIndices`

#### E.10.5 Drag-and-drop reorder

Replace `@atlaskit/pragmatic-drag-and-drop` with `react-native-draggable-flatlist` or a custom `LongPressGestureHandler` + `PanGestureHandler`:

- Long press activates drag mode (haptic feedback via `expo-haptics`)
- Drop indicator rendered as `Animated.View` at closest edge
- On drop, recompute order and call `setQueue(newQueue)`

#### E.10.6 Swipe actions on queue items

Replace DOM-based swipe with `react-native-gesture-handler` `Swipeable` component or custom `PanGestureHandler`:

- Right action (swipe left): Tick button with green background
- Left short action: Queue add (primary color)
- Left long action: Playlist selector (neutral color)
- Threshold values: 60px (short), 150px (long) -- may need density adjustment for mobile

#### E.10.7 Session details panel

Render as a bottom sheet using `@gorhom/bottom-sheet`:

- Snap points: collapsed (session header height), half-expanded (50%), full-expanded (90%)
- `BottomSheetScrollView` for scrollable content
- Grade distribution chart: use `react-native-svg` for the bar chart

#### E.10.8 Grade tint background

Use `Animated.View` with `useAnimatedStyle` and `backgroundColor` driven by a shared value:

- `interpolateColor` for smooth transitions between grade tint colors
- Fall back to theme surface color when no climb is active

#### E.10.9 Offline indicator

Same `CloudOffOutlined` icon treatment but using `react-native-vector-icons` or Expo's `@expo/vector-icons`:

- Dismissible banner with `Pressable` + `Animated.View` opacity transition

#### E.10.10 Shared drawer pattern

On React Native, use a single `BottomSheet` instance per drawer type at the navigator level:

- Actions sheet, playlist sheet, and tick sheet -- each with portal-style state management
- Prevents per-item sheet instantiation (same optimization as web's shared drawers)
- Consider `react-native-portal` or a context-based sheet manager

#### E.10.11 State management

The `QueueContext` architecture (fine-grained contexts, reducer, stable action refs) translates directly to React Native. Key differences:

- Replace IndexedDB persistence with AsyncStorage
- Replace WebSocket connection manager with the same `graphql-ws` client (already platform-agnostic)
- Replace `window.addEventListener` event dispatching with a simple EventEmitter or React context callbacks
- `setPreference` / `getPreference` calls switch to AsyncStorage wrappers

#### E.10.12 Haptic feedback

Add haptic feedback for interactions that have no web equivalent:

- Swipe threshold crossed: `Haptics.impactAsync(ImpactFeedbackStyle.Light)`
- Tick saved: `Haptics.notificationAsync(NotificationFeedbackType.Success)`
- Drag-and-drop activated: `Haptics.impactAsync(ImpactFeedbackStyle.Medium)`
- Session disconnect: `Haptics.notificationAsync(NotificationFeedbackType.Warning)`
