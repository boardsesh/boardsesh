## Navigation Architecture

### Bottom Tab Bar

**Web component:** `packages/web/app/components/bottom-tab-bar/bottom-tab-bar.tsx`

**Mobile layout:** `packages/mobile/app/(tabs)/_layout.tsx`

**Layout:**
The bottom tab bar is fixed at the bottom of the screen. On mobile it spans edge-to-edge with safe area padding at the bottom. On desktop it constrains to `maxWidth: 480px` centered.

There are **5 tabs** (the web has a 6th "Create" tab but it is between Discover and You):

| Tab      | Label                   | Icon                                | Value     | Destination                                                                         |
| -------- | ----------------------- | ----------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| Home     | `bottomTabBar.home`     | `HomeOutlined` (20px)               | `home`    | `/`                                                                                 |
| Climbs   | `bottomTabBar.climb`    | `FormatListBulletedOutlined` (20px) | `climbs`  | Last-used board's `/list` URL, or opens Board Selector Drawer if no board context   |
| Discover | `bottomTabBar.discover` | `LocalOfferOutlined` (20px)         | `library` | `/playlists` or `/discover/` path                                                   |
| Feed     | `bottomTabBar.feed`     | `DynamicFeedOutlined` (20px)        | `feed`    | `/feed`                                                                             |
| Create   | `bottomTabBar.create`   | `AddOutlined` (20px)                | `create`  | Last-used board's `/create` URL, or opens Board Selector Drawer if no board context |
| You      | `bottomTabBar.you`      | `PersonOutlined` (20px)             | `you`     | `/you` (auth-gated: opens auth modal if not authenticated)                          |

**Active/Inactive states:**

- Inactive: `color: var(--neutral-400)` (gray)
- Active: `color: themeTokens.colors.primary` (brand rose/red)
- No ripple effect: `WebkitTapHighlightColor: transparent`

**Background:**

- Light mode: `rgba(255, 255, 255, 0.3)` with `backdrop-filter: blur(5px)`
- Dark mode: `rgba(26, 26, 26, 0.7)` with `backdrop-filter: blur(20px)`
- Border radius: `themeTokens.borderRadius.xl` (16px) on all corners
- In native/Capacitor mode: 0px border radius, edge-to-edge

**Safe area handling:**

- Bottom padding: `var(--safe-area-inset-bottom)` via CSS env()
- On iOS Safari: extends below the wrapper with negative margin to cover the home indicator zone
- In native: safe area handled by platform

**Tab behavior details:**

- **Climbs tab**: If board context exists (from active session or current page), navigates directly to that board's list URL. If no context, asynchronously checks IndexedDB for last-used board (`getLastUsedBoard()`). If found, navigates there. If not found, opens `BoardSelectorDrawer` (Board Discovery Scroll with popular configs, user boards, and custom board option).
- **Create tab**: Same fallback logic as Climbs tab but navigates to the `/create` variant of the URL. Opens Board Selector Drawer with `isCreateClimbFlow=true` when no board context.
- **You tab**: If `sessionStatus !== 'loading'` and user is not authenticated, prevents navigation and opens auth modal with title `bottomTabBar.youSignInTitle` and description `bottomTabBar.youSignInDescription`. On auth success, navigates to `/you`.

#### Mobile: library entry and tab variants

The mobile tabs remain **Home, Climbs, Session, Discover, You**, in that order.
Session keeps the `/record` route; only its visible navigation label changes.
An ordinary launch and untargeted post-login entry select **Climbs**, using the
stored active board. Selecting the initial tab does not reorder the bar. Explicit
deep links, session joins and warm resumes retain their own destinations.
Screenshot mode intentionally starts on Home to preserve the capture readiness contract.

- **Native iPhone:** Liquid Glass on iOS 26 uses `NativeTabs`. Climbs retains
  `role="search"` and its native bottom search field. The queue accessory,
  session/connection badge and scroll minimization retain their current behavior.
- **Other phones:** Material and older-iOS Liquid Glass use JS `Tabs` with
  `MaterialTabBar`. Tablet sidebars retain their existing order and panes.
- **Returning from Session:** Browse climbs opens the selected board's library
  directly, without rewriting the board selection or changing the live session.
  Change board is a separate action; its picker returns to Session. First-time
  board selection still finishes on Climbs. Start opens Climbs after creating the
  session and appending any generated workout; a failed start stays on Session.
  The board card uses separate full-width Browse climbs and Change board rows;
  board details wrap beneath Browse climbs. During Start, the setup form remains
  visible and Start stays disabled until the native tab leaves Session, so live
  settings never flash during the handoff. Switching tabs manually while creation
  is pending cancels the automatic redirect, while session and queue creation finish.
- **Restoring a board:** local disk reads and bounded retries run independently
  of internet connectivity. Pending reads show loading; failed reads offer Retry.
  Only a successful read returning no board permits setup or a Choose board prompt.
  Existing saved-board and account-isolation rules remain in force. Filters keep
  their existing persistence; scroll position is retained within the running app,
  not restored across process restarts.

The picker emits `Board Picker Opened` once after the active-board read settles
and `Board Picker Selection Completed` after an existing-board selection is
persisted. `sameBoard` compares UUIDs; `sameConfig` compares board type, layout,
size and hold sets. A failed restoration records unknown (`null`) rather than
claiming there was no board. `source` distinguishes onboarding, explicit Session
returns, and other picker entries; `returnTo` records the destination. Creation
flows retain their existing creation/activation events. Screen-event deduplication
is unchanged, so these events diagnose reselection without restoring a per-screen
navigation stream. They do not establish a retrospective before/after baseline.

### Header Patterns

**Web component:** `packages/web/app/components/global-header/global-header.tsx`

The global header is `position: fixed` at the top with `z-index: 10`. It has different configurations per route:

#### Search Header (default on board list pages)

**Layout:** `height: var(--global-header-height)`, `padding: 0 16px`, `gap: 12px`, flex row.

- **Left:** User avatar (UserDrawer component) -- tappable, opens profile/settings drawer
- **Center:** Search `TextField` -- takes `flex: 1`. On list pages: editable with live `nameFilter` binding. On non-list pages: read-only, tapping opens `UnifiedSearchDrawer`.
  - Start adornment: `SearchOutlined` (18px)
  - End adornment (when name filter active): Clear button `ClearOutlined` (16px)
  - Input font size: 14px, padding: `6px 0`
  - Placeholder: `header.searchClimbsPlaceholder` on list pages, `header.searchPlaceholder` elsewhere
- **Right:** Filter button (`FilterListOutlined`) on list pages only. Has active indicator dot (8px circle, `var(--color-primary)`, absolute positioned top-right). Notification bell (`NotificationsOutlined`) with unread count badge (red, max 99).

**Background:**

- Light: `linear-gradient(to bottom, rgba(255,255,255,0.85), rgba(255,255,255,0.6))` with `blur(12px)`, bottom border `rgba(0,0,0,0.06)`
- Dark: `linear-gradient(to bottom, rgba(26,26,26,0.85), rgba(26,26,26,0.6))` with `blur(20px)`, bottom border `rgba(255,255,255,0.08)`
- Dark mode search input: white background, black text (intentional per design guidelines)

#### Profile/You Header (centered title pattern)

**Layout:** 3-column CSS grid: `minmax(48px, 1fr) auto minmax(48px, 1fr)`

- **Left:** UserDrawer avatar + Settings gear icon (`SettingsOutlined`)
- **Center:** Title text (`Typography h6`, max-width `min(60vw, 320px)`, centered, ellipsis overflow). Title is "You" on `/you`.
- **Right:** Stats filter button (`TuneOutlined`, with active dot indicator), Share button (`IosShareOutlined`), Notification bell

#### Profile View Header (other user's profile)

- **Left:** Back button (chevron left)
- **Center:** "Profile" title (or child page title: "Statistics", "Sessions", "Created Climbs")
- **Right:** Stats filter button (when active), Share button (on root profile page)

#### Home Page Header (transparent)

- Transparent background, no border, `pointer-events: none` on container, `pointer-events: auto` on children
- Only renders the UserDrawer avatar

#### Create Page Header

- Hidden entirely (`return null` when `isBoardCreatePath(pathname)`)

**Mobile adaptation notes:**

- Use `react-native-safe-area-context` for `paddingTop`
- `BlurView` for frosted glass effect
- Navigation header can be configured per-screen in Expo Router stack options
- Search bar: custom `TextInput` component in header

### Drawer/Sheet System

**Web component:** `packages/web/app/components/swipeable-drawer/swipeable-drawer.tsx`

All modals in the app use `SwipeableDrawer` (wrapping MUI's `MuiSwipeableDrawer`). Properties:

**Placement:** `bottom` (most common), `top` (search drawer), `left`, `right`

**Drag handle:**

- Horizontal (top/bottom): 36px wide, 4px tall, `border-radius: 2px`, color `var(--neutral-300, #d9d9d9)`, 12px padding zone
- Vertical (left/right): 4px wide, 36px tall, absolute positioned
- Mobile: drag handle visible. Desktop (768px+): drag handle hidden, close button shown instead.
- Close button: `CloseOutlined` icon, absolute positioned (top: 8px, side: 8px depending on placement), `backgroundColor: 'action.selected'`

**Swipe-to-close:**

- Custom momentum animation: calculates remaining distance, uses `cubic-bezier(0.0, 0, 0.2, 1)` easing
- Duration: proportional to remaining distance, range 120ms--300ms, base speed: full distance in 300ms
- Blocks swipe when touch originates inside `[data-swipe-blocked]` zones (e.g., map, zoomed board)

**Nested drawer stacking:** Drawers can nest via `disablePortal`. Parent drawer's swipe is blocked when touch starts inside a child drawer's Paper element (detected via `[data-swipeable-drawer]` data attribute).

**Backdrop:** Semi-transparent overlay. Click to close (unless `disableBackdropClick`). Custom mask color configurable via `styles.mask`.

**Transition callbacks:** `onTransitionEnd(open: boolean)` fires after slide animation completes. Used for unmount-after-close pattern to avoid keeping heavy drawer subtrees in the React tree.

**Common heights:**

- Default: auto (content-sized)
- Full height: `100dvh` or `100%` (board search, my boards)
- 85% height: `85dvh` (board selector)
- 80% height: `80vh` (unified search non-climb mode)
- 70% max: `maxHeight: 70vh` (playlist selector)
- 60%: `60%` (climb actions)

**Mobile adaptation notes:**

- Map directly to `@gorhom/bottom-sheet` `BottomSheetModal`
- `snapPoints` replaces fixed heights
- `handleIndicatorStyle` for drag handle styling
- `backdropComponent` for backdrop
- `enablePanDownToClose` for swipe dismiss
- Nested stacking via multiple `BottomSheetModalProvider` or sequential presentation

### Deep Linking

**URL structure:** `/b/[board_slug]/[angle]/...` (new slug-based routes) and legacy `/{board_name}/{layout_id}/{size_id}/{set_ids}/{angle}/...`

Maps to Expo Router stack navigation:

```
(tabs)/
  index.tsx              -> /
  feed.tsx               -> /feed
  you/
    index.tsx            -> /you
    ...
(board)/
  [board_slug]/
    [angle]/
      list.tsx           -> /b/{slug}/{angle}/list
      create.tsx         -> /b/{slug}/{angle}/create
      view/[uuid].tsx    -> /b/{slug}/{angle}/view/{uuid}
auth/
  login.tsx              -> /auth/login
  ...
```

### Auth Gating

- `/you/*` routes require authentication
- On web: server-side redirect to `/` if not authenticated
- Tab bar intercepts: You tab shows auth modal before navigation if `sessionStatus !== 'loading'` and not authenticated
- Create tab: opens auth modal when saving if not authenticated (form is accessible without auth)
- Queue actions (add to queue, create session): require auth via `openAuthModal`

---
