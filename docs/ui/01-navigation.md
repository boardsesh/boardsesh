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

The mobile tabs are **Home, Session, Discover, You, Climbs**, in that order:
Climbs is the rightmost tab, like Apple Music's Search tab (HIG Tab bars: the
search tab sits "at the trailing end"). The native iPad bar and its sidebar follow
the same order; the JS tablet rails list Climbs last among the primary rows, with
You pinned at the bottom. Session keeps the `/record`
route; only its visible navigation label changes.
An ordinary launch and untargeted post-login entry select **Climbs**, using the
stored active board, unless the climber chose **Home** under Settings › Home ›
"Open the app on" (#6289; it moved from General to the Home page with #6546). Selecting the initial tab does not reorder the bar.

- **Where it lives:** `startupScreen: 'climbs' | 'home'` in the MMKV settings store,
  default `climbs`, per device. Sign-out does not clear it. An unknown stored value
  opens Climbs, and older bundles ignore the key, so an OTA rollback opens Climbs.
- **Who reads it:** only `getAppEntryTab()` / `getAppEntryHref()` in
  `src/lib/app-entry-route.ts`, synchronously. `app/(tabs)/_layout.tsx` reads it
  once at module load for `initialRouteName`; the launcher (`app/index.tsx`), the
  post-login redirect and the session-unavailable recovery in `auth-provider.tsx`
  read it on render.
- **When it applies:** from the next start. Changing it never navigates, and
  nothing re-reads it on resume, so returning from the background keeps the
  current screen.
- **What still wins:** a deep link resolves to its own route and never renders the
  launcher; a tapped notification pushes its destination after entry; the
  onboarding gate pushes the first-board picker over whichever tab is showing; on
  web a post-login `next=` return is read before the start-up tab. Session joins
  and warm resumes keep their own destinations too.
- **Screenshot mode** always starts on Home to preserve the capture readiness
  contract, whatever the simulator has stored.

The bar itself depends on the device:

- **Native iPhone:** Liquid Glass uses `NativeTabs` (the system UIKit tab bar) on
  every iPhone, iOS 18 included. Climbs is an ordinary labelled tab, like Apple
  Music's Search tab, not `role="search"`: since SDK 58 that role is a
  UISearchTab, which iOS 26 sets apart from the other tabs and which brings a
  search field into the bar. The queue accessory and scroll minimization ride
  the iOS 26 bar. On an iOS 27 iPhone Climbs is also the bar's prominent tab, so
  it stays on screen at the right when the bar collapses, as Music's Search does;
  the collapsed accessory fills the room left between it and the selected tab. On iOS 18 the bar has neither, and the current climb rides
  the floating JS queue bar just above the native bar.
- **Platter controls (iOS 26):** the open platter shows the lightbulb and the tick. The
  collapsed platter has one 44pt slot: the bulb while a board is bound and nobody holds it,
  otherwise the tick. A mark on the thumbnail's top-trailing corner shows who holds the board in
  both placements: amber `lightbulb.fill` (LED board you hold), brand-tone `pin.fill` (board with
  no lights you hold), `person.fill` (a teammate holds it), nothing when it is free. The collapsed
  platter's climb link reads the connection aloud; the open one leaves that to its bulb. The
  platter's bulb and tick send `placement` (`regular` / `inline`) on `Board Connect Tapped` and
  `Quick Tick Opened`.
- **Climbs header (iOS 26 Liquid Glass, where the accessory platter mounts):** while you hold the board and no other climb is lit on the
  wall, the centre slot shows a "You have the board" capsule (brand-tone pin and "You have the
  wall" for a board with no lights). The "On the wall" capsule keeps priority. The tap opens the
  Bluetooth controls sheet when this device holds the radio link and logs `Board Controls Opened
  {surface: 'header_pill'}`; otherwise it is plain text. Both capsules share the
  `HeaderStatusCapsule` glass shell. Material and Android are unchanged: their bar never
  collapses, so its bulb stays visible; neither does the iOS 18 floating bar.
  The header hides the Climbs title by drawing it in a clear colour
  (`HIDDEN_HEADER_TITLE_STYLE`), not with an empty title view: the native stack keeps one
  centre view per screen, and a capsule swapped into an empty one kept its zero size and
  stayed invisible until the tab was left and re-entered.
- **Climbs search, every platform:** the Climbs screen has no search field and
  its header draws no "Climbs" title (`NativeRootHeader` `titleHidden`; the tab
  names the screen). The climb-name search is the first row of the Filters
  sheet, as in the Logbook. A second tap on the Climbs tab with the list showing
  opens Filters without the keyboard (`useTabReselect`, which listens for the tab
  bar's re-press; the JS tablet rails navigate without one, so there the Filters
  chip is the way in). On a collapsed bar that tap also expands the bar. That is UIKit, not
  us: iOS expands a minimized bar on any tab tap, the prominent one included, and offers no API to
  keep it minimized. Checked on iOS 27 with the Filters sheet off and with a programmatic scroll
  after the tap; the bar expanded both times (#6885, closed as platform behaviour). A typed name shows as the first token under the chips and
  counts in the Filters badge.
- **Other phones:** Material, and Liquid Glass forced on Android, use JS `Tabs`
  with `MaterialTabBar`.
- **Tablets:** one JS `Tabs` navigator at every width (sidebar at regular width,
  `MaterialTabBar` in a narrow split), so a Split View resize keeps each tab's
  state. `NativeTabs` remounts when a tab's `hidden` flag flips, and the
  iPad-only On the Wall tab would have to be hidden in a narrow split (a sixth
  native tab spills into UIKit's More list), so the iPad shell stays JS. The
  native `sidebarAdaptable` sidebar is not used for the same reason, and because
  it cannot host the live wall cell or report its width to the pane budgets.
- **Session setup:** Browse climbs opens the selected board's library
  directly, without rewriting the board selection.
  Change board is a separate action; its picker returns to Session. First-time
  board selection still finishes on Climbs. Start opens Climbs after creating the
  session and appending any generated workout; a failed start stays on Session.
  The board card uses separate full-width Browse climbs and Change board rows;
  a small selected-board thumbnail leads Browse climbs and board details wrap
  beneath its label. Both rows disappear once the session is running; the Climbs
  tab remains available. During Start, the setup form remains
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
returns, and other picker entries; `returnTo` records the destination.
`pickSource` names the list the board was tapped in (`your_boards`, `nearby`,
`offline`, `bluetooth` or `gym_finder`) and `followed` says whether the pick
added it to Your boards. The gym finder binds through the same `useActivateBoard`
path, so its picks report this event (and close out onboarding when the picker
forwarded `source=onboarding`). Pushed from the picker's "Find gym" (which adds
`from=picker`), it reports no opening of its own, because the picker already
did, and its picks carry the picker's `source`. Opened on its own from Home or
My gyms, it reports its own opening, and both events say `source: gym_finder`,
so those picks never count against the picker's openings. Creation
flows retain their existing creation/activation events. Screen-event deduplication
is unchanged, so these events diagnose reselection without restoring a per-screen
navigation stream. They do not establish a retrospective before/after baseline.

A pick follows the board unless the climber built it (`ownerId` matches them) or
already follows it. `UserBoard.isOwned` plays no part: it is the creator's "a
real wall" flag and is true for almost every board built in the app, which is
why, before #5654, a gym or community board someone else built was bound but
never followed, and the picker said "No boards yet" on the next open. Someone
else's private board is never followed, because the server refuses it, and a
signed-out climber follows nothing.

Because nearly every board someone else built now counts as new to the climber,
adoption's "Download X?" dialog only appears on picks from the picker and the
gym finder. The onboarding bind (which makes its own offer) and the play
drawer's wall switch pass `offerOffline: false`: they still follow the board,
and the "keep boards offline" setting still downloads it, but they never ask.

The app also follows the board it launched on, once per account and board
(`Active Board Follow Healed`), when the server says it is neither the climber's
nor followed. It started as the repair for picks made before #5654, but it is a
lasting rule: it covers every board the app launches on, including boards bound
without a pick at all (a party session join, a `/b/` or climb deep link, the
Bluetooth mismatch switch, the drawer's board switch). So a friend's wall you
joined a session on shows up in Your boards after the next launch. The
`active-board-follow-heal-kill` mobile flag turns it off fleet-wide; the heal
waits for flags to resolve, so the switch holds from the next launch.

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
