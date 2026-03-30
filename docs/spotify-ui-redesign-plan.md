# Spotify-Inspired UI Redesign Plan

## Overview

This plan transforms Boardsesh's UI into a Spotify-like experience with a persistent bottom navigation bar, a "now playing" bar that expands into a full-screen view, compact list items with swipe gestures, and drawer-based flows for party mode, creation, and search. The goal is a cohesive, polished mobile-first experience that feels fluid and modern.

---

## Current Architecture Reference

| Component | File | Role |
|---|---|---|
| Main Layout | `packages/web/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/layout.tsx` | Server component. Header + Content + Affixed QueueControlBar. Wraps children in `BoardSessionBridge > ConnectionSettingsProvider > GraphQLQueueProvider > PartyProvider`. |
| List Layout | `.../[angle]/list/layout-client.tsx` | Client component. Main content + desktop sidebar with 3 tabs (Queue/Search/Search by Hold). Sidebar uses AntD `Sider` at 400px width. |
| Header | `packages/web/app/components/board-page/header.tsx` | Client component. Logo, angle selector, create (desktop), party, LED, user menu. Mobile has a meatball menu dropdown. Uses `usePageMode()` to adapt layout per page type. |
| QueueControlBar | `packages/web/app/components/queue-control/queue-control-bar.tsx` | Now-playing bar (~45px compact, 36px thumbnail) with swipe left/right (prev/next), queue drawer (bottom, 70%), play button link, mirror, prev/next buttons (desktop-only via `.navButtons` CSS), tick. **Persistent globally**: rendered at root level via `GlobalQueueControlBar` when off board routes, or by board `layout.tsx` when on board routes. Replaces `FloatingSessionThumbnail`. |
| ClimbCard | `packages/web/app/components/climb-card/climb-card.tsx` | Card view with cover image, horizontal ClimbTitle header, action footer. Has two render paths: `ClimbCardWithActions` (generates actions dynamically) and `ClimbCardStatic` (memoized with external actions). |
| ClimbTitle | `packages/web/app/components/climb-card/climb-title.tsx` | Name, grade (colorized), quality stars, setter info. Supports `layout="horizontal"` and stacked modes. |
| QueueListItem | `packages/web/app/components/queue-control/queue-list-item.tsx` | Compact row with thumbnail, swipe right=tick, swipe left=delete. Includes drag-and-drop via `@atlaskit/pragmatic-drag-and-drop`. Uses direction detection (horizontal vs vertical) to avoid scroll conflicts. Has ellipsis dropdown menu with View/Tick/Open in App/Remove actions. |
| PlayView | `.../play/[climb_uuid]/play-view-client.tsx` | Full board renderer with swipe navigation. Uses `SWIPE_THRESHOLD=80` (different from queue items' 100). Shows swipe hint that auto-hides after 3 seconds. |
| ShareBoardButton | `packages/web/app/components/board-page/share-button.tsx` | Party mode drawer (top placement, 70vh height). Has Start/Join session tabs. Shows users list, QR code, share URL when connected. |
| SendClimbToBoardButton | `packages/web/app/components/board-bluetooth-control/send-climb-to-board-button.tsx` | Bluetooth LED connection. Dynamically imported (`next/dynamic`, SSR disabled). Auto-sends climb on `currentClimbQueueItem` change when connected. Uses `useWakeLock` to prevent sleep while connected. Shows iOS Bluefy browser recommendation modal. |
| SearchButton/Drawer | `packages/web/app/components/search-drawer/` | Desktop sidebar filter column (hidden on mobile via CSS module). Mobile search is `SearchClimbNameInput` in header + `SearchButton` icon for advanced filters. After redesign, search moves entirely to the Search tab/page (bottom tab bar) and desktop sidebar. |
| ClimbActions | `packages/web/app/components/climb-actions/` | Modular action system with 9 action types: viewDetails, fork, favorite, queue, tick, openInApp, mirror, share, playlist. Supports `icon`, `button`, `compact`, and `dropdown` view modes. |
| BoardRenderer | `packages/web/app/components/board-renderer/board-renderer.tsx` | SVG board visualization with `fillHeight` option |
| ClimbsList | `packages/web/app/components/board-page/climbs-list.tsx` | Client component. Paginated climb list with IntersectionObserver infinite scroll. Uses `Row`/`Col` grid layout (xs=24, lg=12). Deduplicates by UUID. Hash-based scroll position restoration. |

---

## Design Principles

1. **Bottom-up navigation** - All primary navigation lives at the bottom of the screen within thumb reach
2. **Progressive disclosure** - Simple surface, rich detail on demand (drawers, menus)
3. **Gestural interaction** - Swipe actions for common operations (heart, queue, tick, delete)
4. **Smooth transitions** - Full-screen drawer transitions for play view, not page navigations
5. **Consistent density** - Two list modes (compact/expanded) instead of full cards vs queue items
6. **Minimal chrome** - Reduce header clutter, move actions closer to content

---

## Wireframes (ASCII)

### Mobile Layout - List View (Compact Mode)
```
┌────────────────────────────────────┐
│ [👤]  [Logo]        [Angle ▾]     │  ← Simplified header
├────────────────────────────────────┤
│                                    │
│ ┌──────────────────────────────┐   │
│ │ [Thumb] V4  "Problem Name"  ⋮│   │  ← Compact climb row
│ │         ★★★  By setter     ⋮│   │    Swipe L=♡, R=+Queue
│ └──────────────────────────────┘   │
│ ┌──────────────────────────────┐   │
│ │ [Thumb] V7  "Another Climb" ⋮│   │
│ │         ★★☆  By setter2    ⋮│   │
│ └──────────────────────────────┘   │
│ ...                                │
│                                    │
├────────────────────────────────────┤
│ [T] "Current Climb" V4  [Q] [✓]  │  ← Now Playing bar (~45px, compact)
├────────────────────────────────────┤
│  🏠 Climb  📚 Your Library ✚ Create │  ← Bottom tab bar
└────────────────────────────────────┘
```

> **Note**: The now-playing bar is persistent and appears on **every screen** when there is an active queue (local or party mode). The thumbnail `[T]` is 36px wide (compact). When navigating away from the board route, the bar remains visible and tapping it returns to the board.

### Mobile Layout - List View (Expanded/Card Mode)
```
┌────────────────────────────────────┐
│ [👤]  [Logo]        [Angle ▾]     │
├────────────────────────────────────┤
│                                    │
│ ┌──────────────────────────────┐   │
│ │  "Problem Name"    V4       │   │  ← Standard climb card
│ │  ★★★  By setter             │   │    (existing ClimbCard)
│ │ ┌──────────────────────────┐ │   │
│ │ │                          │ │   │
│ │ │    [Board Renderer]      │ │   │
│ │ │                          │ │   │
│ │ └──────────────────────────┘ │   │
│ │  ♡  +Queue  🔗Share  ...    │   │
│ └──────────────────────────────┘   │
│                                    │
├────────────────────────────────────┤
│ [T] "Current Climb" V4  [Q] [✓]  │  ← Compact now-playing bar (~45px)
├────────────────────────────────────┤
│  🏠 Climb  📚 Your Library ✚ Create │
└────────────────────────────────────┘
```

### Now Playing Expanded (Full-screen Drawer)
```
┌────────────────────────────────────┐
│  ⌄ (drag handle)                   │  ← Drag down to dismiss
├────────────────────────────────────┤
│                                    │
│  "Problem Name"           V4      │  ← ClimbTitle horizontal
│  ★★★  By setter  @ 40°            │
│                                    │
│ ┌──────────────────────────────┐   │
│ │                              │   │
│ │                              │   │
│ │      [Board Renderer]        │   │  ← Swipe left/right here
│ │    (card swipe animation)    │   │    to navigate between climbs
│ │                              │   │    Card slides out, next slides in
│ │                              │   │
│ └──────────────────────────────┘   │
│                                    │
├────────────────────────────────────┤
│ [Mirror] [♡] [Party] [LED] [✓]    │  ← Action bar
├────────────────────────────────────┤
│  ◀ Prev │ ▮▮ Current │ Next ▶     │  ← Mini transport controls
└────────────────────────────────────┘
```

**Swipe navigation**: Spotify-style card swiping where the board renderer card physically translates with the user's finger, and the next/previous card slides in from the edge. No static arrow indicators - the motion itself provides feedback.

### Desktop Layout
```
┌─────────────────────────────────────────────────────────────┐
│ [👤] [Logo]  [Angle ▾]  [Create] [Party] [LED]             │
├──────────────────────────────────┬──────────────────────────┤
│                                  │                          │
│  Climb list (2-col grid)         │  Sidebar (400px)         │
│  - Toggle: Compact / Card        │  Tabs: Queue | Search    │
│                                  │                          │
│  [Card] [Card]                   │  [Queue items...]        │
│  [Card] [Card]                   │                          │
│  ...                             │                          │
│                                  │                          │
├──────────────────────────────────┴──────────────────────────┤
│ [T] "Current Climb" V4  [🔄Mirror] [Q] [Party] [✓]  ~45px │
└─────────────────────────────────────────────────────────────┘
```

> **Note**: The queue control bar is persistent globally. On desktop, it appears at the bottom of every page when a queue is active. The compact 36px thumbnail keeps it unobtrusive.

---

## Phase 1: Bottom Tab Bar

### What changes
Add a persistent bottom tab bar below the QueueControlBar with three tabs: **Climb**, **Your Library**, and **Create**.

**Note:** Search functionality remains in the header on mobile list pages (search input + advanced search button). The bottom tab bar provides navigation, not search.

### Home Screen

A new landing/home screen accessible via the first tab. This is a placeholder for a future discovery/dashboard experience.

**New file: `packages/web/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/home/page.tsx`**
- Server component, minimal placeholder content
- For now: a centered message like "Home - Coming Soon" or a redirect to `/list`
- This will eventually become a discovery/dashboard screen (recent climbs, suggested climbs, activity feed, etc.)

**New file: `packages/web/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/home/home-placeholder.tsx`**
- Client component with placeholder UI

**Feature flag**: `NEXT_PUBLIC_ENABLE_HOME_SCREEN`
- When `'true'`: Home tab navigates to the `/home` route
- When falsy (default): Home tab navigates to `/list` instead (acts as the Climb tab)
- This matches the existing feature flag pattern
- Add to `.env.local`: `NEXT_PUBLIC_ENABLE_HOME_SCREEN=false`

### Files to modify

1. **New file: `packages/web/app/components/bottom-tab-bar/bottom-tab-bar.tsx`**
   - Client component (`'use client'`)
   - Three tabs: Climb (navigates to list), Your Library (navigates to playlists), Create (opens create drawer)
   - Icons: Use AntD icons - `UnorderedListOutlined` for Climb, `TagOutlined` for Your Library, `PlusOutlined` for Create
   - Active state: Primary color (`themeTokens.colors.primary`) for active tab icon + label
   - Inactive state: `themeTokens.neutral[400]` color
   - Fixed at the bottom, full width
   - Height: ~50px with safe-area-inset-bottom padding for iOS
   - Desktop: Hidden (search/queue available in sidebar, create in header)
   - **Props needed**: Requires board route parameters to construct navigation URLs

2. **New file: `packages/web/app/components/bottom-tab-bar/bottom-tab-bar.module.css`**
   - Media query to hide on desktop (>= 768px)
   - Safe area inset for iOS home indicator: `padding-bottom: env(safe-area-inset-bottom)`

3. **Modify: `packages/web/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/layout.tsx`**
   - **Important**: This is a server component. The BottomTabBar is a client component, so it needs to be placed correctly within the component tree.
   - Add BottomTabBar below the Affix'd QueueControlBar
   - Wrap both in a shared bottom container
   - Adjust Content height to account for tab bar height
   - **Note**: The current layout uses `<Affix offsetBottom={0}>` around QueueControlBar. The BottomTabBar should be placed outside/below the Affix, or both should be wrapped in a new bottom-anchored container. Consider replacing `<Affix>` with a simple flex layout since both elements are permanently fixed at the bottom.
   - **Note**: The Content area currently has `height: '80vh'` which will need adjustment to account for the tab bar. Consider using `flex: 1` with proper `calc()` or letting flexbox handle it naturally.

4. **Mobile search stays in header**
   - The `SearchClimbNameInput` (text input) and `SearchButton` (advanced filters icon) **remain in the header** on mobile list pages.
   - This keeps search easily accessible while browsing climbs.
   - The bottom tab bar is for navigation only (Climb, Your Library, Create).

5. **New file: `packages/web/app/components/create-drawer/create-drawer.tsx`**
   - Bottom drawer with creation options
   - Items:
     - "Create Climb" - links to `/create` route
     - "Create Playlist" - links to `/playlists` with create action
   - **Note**: Both URLs require the full board route context (`board_name/layout_id/size_id/set_ids/angle`). The component needs access to `boardDetails` and `angle` props (or use URL params) to construct proper slug-based URLs, matching the pattern used in `header.tsx` with `generateLayoutSlug`/`generateSizeSlug`/`generateSetSlug`.
   - **Note**: Hide playlist option for MoonBoard (matching existing header behavior: `isMoonboard` check)
   - Each item: Icon + label, full-width rows
   - Simple AntD Drawer with bottom placement, auto height

### Behavior
- **Climb tab**: Navigates to the `/list` route (the climb list). This is the default/first tab.
- **Your Library tab**: Navigates to the `/playlists` route. Shows as active when on playlists page.
- **Create tab**: Opens the CreateDrawer with options (Climb, Playlist). The Playlist option opens a Create Playlist form directly.
- Active tab state reflects current context (Climb when on /list, Your Library when on /playlists, etc.)
- On desktop (>= 768px): Tab bar is hidden. Search and create remain in header/sidebar.
- **On play/view/create pages**: Tab bar remains visible. On play pages the user may want to quickly return to the list or access playlists.

### Integration with header
- **Keep** the mobile `SearchClimbNameInput` and `SearchButton` in the header on list pages - search stays accessible while browsing
- Keep the desktop sidebar search
- Remove "Create Climb" from the mobile meatball menu (`mobileMenuItems` in header.tsx, key `create-climb`) - moved to bottom tab bar's New drawer

### Home screen route
- Add the `/home` route alongside the existing `/list` route under the `[angle]` segment
- The home page reuses the same layout as list (header + content + queue bar + tab bar)
- The home page is purely a placeholder - feature-flagged off by default, so the Home tab acts as a `/list` navigation until enabled

### Considerations
- **Onboarding tour**: The existing `OnboardingTour` component in `layout-client.tsx` may reference the old header elements. Verify tour steps still point to valid targets after moving buttons.
- **Controller mode**: When in controller mode (URL has `controllerUrl` param), the Create tab may not be relevant. Consider hiding it or adjusting behavior.

---

## Phase 2: Compact Climb List Mode [DONE]

### What changes
Add a "compact" display mode for the climb list that renders climbs as slim rows (similar to QueueListItem) instead of full cards.

### Files to modify/create

1. **New file: `packages/web/app/components/climb-card/climb-list-item.tsx`**
   - Compact list item component, similar structure to QueueListItem
   - Layout:
     ```
     ┌─────────────────────────────────────────────────────┐
     │ [Thumbnail]  Name + Setter     [V-Grade]    [⋮]    │
     │   48×auto    ★★★  AscentStatus (colorized)  (menu) │
     └─────────────────────────────────────────────────────┘
     ```
   - Left side: `ClimbThumbnail` (48px width, maintains aspect ratio)
   - Center: Climb name (single line, ellipsis overflow), quality stars, setter name (secondary text, small), `AscentStatus` icon (reuse from `queue-list-item.tsx`)
   - Right side: Large colorized V-grade text, ellipsis button
   - Total height: ~60-64px per item
   - No horizontal padding waste - edge-to-edge content
   - The V-grade should be visually prominent with the grade color as the text color, similar to how ClimbTitle renders it in horizontal mode but larger/bolder
   - **Selected state**: Show `themeTokens.semantic.selected` background + left border (matching QueueListItem's `isCurrent` style) when `currentClimb?.uuid === climb.uuid`
   - **Tap handler**: Single tap should set as current climb (`setCurrentClimb`), double-tap opens play drawer (Phase 3) or navigates to view. This matches the existing `handleClimbDoubleClick` pattern in `climbs-list.tsx`.

2. **Add swipe actions to `climb-list-item.tsx`**
   - Reuse the swipe pattern from `queue-list-item.tsx` (same SWIPE_THRESHOLD=100, MAX_SWIPE=120)
   - **Important**: Copy the direction-detection logic from `queue-list-item.tsx` (the `isHorizontalSwipe` state pattern), not the simpler swipe from `queue-control-bar.tsx`. The direction detection prevents scroll conflicts by checking `absX > absY` before committing to horizontal swipe. Without this, vertical scrolling through the list will be janky.
   - **Swipe right (reveals left)**: Heart/favorite action
     - Background: `themeTokens.colors.error` (red, matching heart color)
     - Icon: `HeartOutlined` / `HeartFilled`
     - Action: Toggle favorite on the climb via `useFavorite()` hook from `climb-actions/use-favorite.ts`
     - **Auth requirement**: Favorite requires authentication (`AUTH_REQUIRED_ACTIONS` includes 'favorite'). If not authenticated, the swipe action should open the auth modal or show a brief toast prompting sign-in.
   - **Swipe left (reveals right)**: Add to queue action
     - Background: `themeTokens.colors.primary` (cyan)
     - Icon: `PlusOutlined` or `OrderedListOutlined`
     - Action: Add climb to queue via `setCurrentClimb()` from QueueContext (the existing pattern adds to queue)
     - **Feedback**: Brief visual confirmation (e.g., snap animation or toast) that the climb was added

3. **Ellipsis menu drawer: `packages/web/app/components/climb-card/climb-actions-drawer.tsx`**
   - Bottom drawer triggered by the `⋮` (`MoreOutlined` icon, matching existing patterns) button
   - Header: ClimbTitle (stacked layout) with thumbnail
   - Body: Full list of actions as large tap targets (rows, not icons):
     - ♡ Favorite / Unfavorite
     - + Add to Queue
     - ✓ Log Ascent
     - 🔗 Share
     - 📋 Add to Playlist
     - 📱 Open in Aurora App
     - 🔄 Mirror (if board supports mirroring)
     - 🍴 Fork/Edit (if board supports it - matching the `fork` action type)
     - ℹ️ View Details (navigate to /view/ page)
   - Each row: Icon (24px) + Label text, full width, ~48px height
   - **Implementation approach**: Use the existing `ClimbActions` component with `viewMode="button"` or create a new `viewMode="list"` that renders full-width rows. The existing action system already handles availability, auth requirements, and board-specific filtering. Adding a new view mode is cleaner than reimplementing action logic.
   - **Note**: The `ClimbActions` component uses hooks internally (each action is a component). The drawer must render within the React tree properly to support this.

4. **Modify: `packages/web/app/components/board-page/climbs-list.tsx`**
   - Add a view mode toggle: "Grid" (current cards) vs "List" (compact)
   - Store preference in IndexedDB via `user-preferences-db.ts` (key: `climbListViewMode`)
   - Toggle button in a sticky header area above the list
   - Icons: `AppstoreOutlined` for grid, `UnorderedListOutlined` for list
   - When in list mode: Render `ClimbListItem` instead of `ClimbCard`
   - When in list mode: Single column layout (no grid), full width items
   - When in grid mode: Keep existing 2-column card grid (`Col xs={24} lg={12}`)
   - Default to compact/list mode on all devices (user can toggle to grid if preferred)
   - **Important**: The current `climbs-list.tsx` passes `boardDetails` and `onCoverDoubleClick` to `ClimbCard`. The `ClimbListItem` needs the same props plus the swipe action handlers. Thread `boardDetails` through for thumbnail rendering and action construction.
   - **Hash-based scroll restoration**: The existing `restoreScrollFromHash()` and `updateHash()` must work with both modes. Since items use `id={climb.uuid}`, this should work unchanged as long as `ClimbListItem` also renders with the same `id` attribute.
   - **Infinite scroll**: The `IntersectionObserver` on `loadMoreRef` works independently of item type, so no changes needed there.

5. **Modify: `packages/web/app/components/climb-card/climb-thumbnail.tsx`**
   - No changes needed - already supports the 48px fixed-width pattern

### Performance considerations
- ClimbListItem should be `React.memo`'d with custom comparator (compare by `climb.uuid` and `selected` state)
- Swipe state is local to each item (no parent re-renders)
- Virtual scrolling is not needed yet (existing infinite scroll pagination handles this)
- **FavoritesProvider**: The `useFavorite()` hook requires `FavoritesProvider` in the component tree. Verify that this provider exists above `ClimbsList` in the hierarchy, or add it if missing. The current `ClimbCard` → `ClimbCardWithActions` path may handle this differently.

---

## Phase 3: Now Playing Bar Redesign + Full-screen Play Drawer [DONE]

### What changes
- Redesign QueueControlBar to be simpler with only essential controls
- Tapping the bar opens a full-screen drawer (the "play view") instead of navigating to `/play/[uuid]`
- Remove the `ExpandOutlined` (play mode) button; the bar itself is the entry point
- Add a queue list button and keep the tick button
- Move party mode button to the bar

### 3A: QueueControlBar Redesign — Persistent Global Bar

The QueueControlBar becomes a **persistent, globally visible** component that appears on **every screen** when there is an active queue — regardless of whether it's a local queue or a party mode session. This replaces the current `FloatingSessionThumbnail` (the small floating card in the bottom-right corner).

**Key architectural change**: Currently, QueueControlBar only renders within the board layout (`[angle]/layout.tsx`). After this redesign, it renders at the **root layout level** and is visible across all pages (home, settings, other boards, etc.) whenever a queue is active. When the user is on the board route that owns the queue, the bar uses the existing QueueContext. When on other pages, it sources data from `PersistentSessionContext` (which already tracks `localBoardDetails`, `localQueue`, `localCurrentClimbQueueItem` for local mode, and `activeSession.boardDetails` for party mode).

**Replaces**: `FloatingSessionThumbnail` (`packages/web/app/components/persistent-session/floating-session-thumbnail.tsx`) — this component is removed entirely. The full QueueControlBar provides a richer, more consistent experience than a small thumbnail card.

#### Compact vertical sizing

The bar is **20% shorter vertically** than the current implementation. This is achieved by:
- Reducing the board thumbnail from **48px** width to **36px** width (maintains aspect ratio, so height also shrinks proportionally)
- Reducing vertical padding from `4px 12px 0px 12px` to `2px 12px 0px 12px`
- This brings the total bar height from ~56px to ~45px, making it less intrusive as a persistent global element

Updated `boardPreviewContainerStyle`:
```tsx
const boardPreviewContainerStyle = {
  width: 36, // Reduced from 48 for compact bar
  height: 'auto',
  flexShrink: 0,
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  overflow: 'hidden',
};
```

#### Button cluster changes

**Modify: `packages/web/app/components/queue-control/queue-control-bar.tsx`**

Current button cluster (mobile): `[Mirror] [Play] [Tick]` (Prev/Next are hidden on mobile via `.navButtons` CSS class)
Current button cluster (desktop): `[Mirror] [Play] [Prev] [Next] [Tick]`

New mobile button cluster: `[Party] [Queue] [Tick]`
New desktop button cluster: `[Mirror] [Play] [Prev] [Next] [Party] [Queue] [Tick]`

Changes:
- **Remove (mobile only)**: `ExpandOutlined` play mode link button - replaced by tapping the bar itself
- **Move (mobile only)**: Mirror button to full-screen play view action bar
- **Keep (desktop)**: `ExpandOutlined` play link and mirror button - desktop still navigates to `/play/` route
- **Keep (desktop)**: Previous/Next navigation buttons (already hidden on mobile via `.navButtons` CSS class)
- **Add**: Party mode button (the `ShareBoardButton` component, moved from header). **Note**: `ShareBoardButton` currently manages its own drawer state internally - it renders both the button and the drawer. Moving it is straightforward since it's self-contained.
- **Add**: Queue list button (`UnorderedListOutlined`) that opens the queue drawer (replaces tapping the climb info text)
- **Keep**: Tick button stays
- **Remove**: "Added by" avatar indicator from the bar (move to play drawer or remove - it clutters the simplified bar)

New mobile layout:
```
┌────────────────────────────────────────────────────────┐
│ [Thumb] "Climb Name" V4 ★★★  │  [👥Party] [≡Q] [✓]  │
│  36px    @ 40°                │                        │
└────────────────────────────────────────────────────────┘
```
(Bar height: ~45px, down from ~56px)

Tap behavior:
- Tapping the **left section** (thumbnail + climb info) navigates back to the board route (when on non-board pages) or opens the full-screen play drawer (when on board pages, mobile only)
- Tapping **Queue button** opens the existing queue drawer
- Tapping **Party button** opens the party mode drawer (see Phase 5)
- Tapping **Tick button** logs ascent (existing behavior)

Swipe behavior (Spotify-style card swipe):
- Swipe left/right on the bar to navigate between climbs
- **Replace** the current arrow-indicator swipe pattern (FastBackwardOutlined/FastForwardOutlined backgrounds) with a card-swipe animation
- During swipe: the current climb info (thumbnail + ClimbTitle section) translates horizontally with the finger
- The next/previous climb info slides in from the opposite edge
- On swipe completion: current info animates out, next info slides to center, queue advances
- This matches the Spotify "now playing" bar behavior where you can swipe between tracks and see the track info physically move
- The swipe action backgrounds (cyan with arrow icons) should be removed entirely

The click handler on the climb info section needs conditional behavior:
- **On non-board pages**: Always navigate back to the board route (same behavior as current `FloatingSessionThumbnail` tap)
- **On board pages, mobile**: Open the full-screen play drawer (new behavior)
- **On board pages, desktop list page**: Currently does nothing (the `toggleQueueDrawer` already returns early on desktop list page). Change to keep existing no-op on desktop list, open play drawer on desktop non-list pages.
- **Note**: The current `toggleQueueDrawer` uses `window.matchMedia('(min-width: 768px)')` for the desktop check. Continue using this pattern for conditional behavior.

#### Global rendering implementation

**New file: `packages/web/app/components/queue-control/global-queue-control-bar.tsx`**

A wrapper component that handles rendering the QueueControlBar globally:

```
┌──────────────────────────────────────────────────────────┐
│ Visibility logic:                                        │
│                                                          │
│ 1. If on a board route that owns the queue:              │
│    → Bar is rendered by board layout.tsx (existing)       │
│    → Global wrapper hides itself to avoid duplication     │
│                                                          │
│ 2. If on ANY other page with an active queue:            │
│    → Global wrapper renders the compact QueueControlBar  │
│    → Data sourced from PersistentSessionContext           │
│    → Tap navigates back to the board route               │
│                                                          │
│ 3. If no active queue (local or party):                  │
│    → Global wrapper renders nothing                      │
│                                                          │
│ "Active queue" = localQueue.length > 0                   │
│   OR localCurrentClimbQueueItem exists                   │
│   OR activeSession exists (party mode)                   │
└──────────────────────────────────────────────────────────┘
```

**Data sourcing** (when on non-board pages):
- `boardDetails` → from `PersistentSessionContext`: `localBoardDetails` (local mode) or `activeSession.boardDetails` (party mode)
- `currentClimb` → from `PersistentSessionContext`: `localCurrentClimbQueueItem` (local) or `currentClimbQueueItem` (party)
- `queue` → from `PersistentSessionContext`: `localQueue` (local) or `queue` (party)
- `angle` → from `PersistentSessionContext`: extracted from `localBoardPath` or `activeSession.parsedParams.angle`
- **Note**: The `PersistentSessionContext` already stores all of this data — no new state management needed

**Modify: Root layout (`packages/web/app/layout.tsx`)** or the relevant parent layout:
- Add `<GlobalQueueControlBar />` as a fixed-bottom element
- Position: `position: fixed; bottom: 0; width: 100%; z-index: 999`
- When on a board route, this component renders nothing (the board layout renders its own `QueueControlBar` via `<Affix>`)
- When on non-board pages, it renders the compact QueueControlBar
- Other page content needs `padding-bottom` to account for the bar when it's visible

**Modify: `packages/web/app/components/persistent-session/floating-session-thumbnail.tsx`**
- **Delete this file entirely** — the `GlobalQueueControlBar` replaces it
- Remove the `FloatingSessionThumbnail` import from wherever it's rendered (likely in root layout or persistent session provider)

**Modify: `packages/web/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/layout.tsx`**
- The existing `<Affix offsetBottom={0}><QueueControlBar /></Affix>` continues to work as-is for board pages
- The QueueControlBar on board pages uses the full QueueContext (with all queue operations)
- Apply the same compact sizing (36px thumbnail, reduced padding) to the board-route instance too

### 3B: Full-Screen Play Drawer

**New file: `packages/web/app/components/play-view/play-view-drawer.tsx`**

A drawer component that replaces the `/play/` route for mobile interaction:

- **Placement**: Bottom
- **Height**: 100% viewport (or 95% with rounded top corners)
- **Animation**: Smooth slide-up from the now-playing bar, like Spotify's now-playing expansion
- **Drag to close**: AntD Drawer doesn't natively support drag-to-dismiss. Options:
  1. Use AntD Drawer's built-in close button + swipe-down gesture via `react-swipeable` on the handle area
  2. Implement a custom bottom sheet component (more complex but true Spotify feel)
  3. Use a library like `react-spring-bottom-sheet` - but adds a dependency
  - **Recommended**: Start with AntD Drawer + a custom drag handle using `react-swipeable` (already a dependency). If the UX isn't smooth enough, revisit with a custom solution.

Content (reuse existing PlayView logic):
```
┌──────────────────────────────────────┐
│  ── (drag handle bar) ──            │
│                                      │
│  "Problem Name"             V4      │  ClimbTitle (horizontal)
│  ★★★  By setter  @ 40°              │  with AscentStatus
│                                      │
│ ┌──────────────────────────────────┐ │
│ │                                  │ │
│ │       [Board Renderer]           │ │  Card-swipe container
│ │      (Spotify-style swipe)       │ │  Finger drags card, next
│ │                                  │ │  card slides in from edge
│ └──────────────────────────────────┘ │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ [🔄] [♡] [👥] [💡LED] [✓Tick]  │ │  Action bar
│ └──────────────────────────────────┘ │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ [◀ Prev]  Current Name  [Next ▶]│ │  Mini transport
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

**Swipe navigation**: Uses a Spotify-style card swipe pattern. The board renderer is contained in a "card" that translates with the user's finger during horizontal swipe. When the swipe exceeds the threshold, the current card animates off-screen and the next/previous card slides in from the opposite edge. No static arrow indicators are shown - the physical card motion provides all navigation feedback.

Action bar buttons:
- **Mirror** (`SyncOutlined`): Toggle mirrored state (purple when active, using `themeTokens.colors.purple`). Use existing `mirrorClimb()` from QueueContext.
- **Favorite** (`HeartOutlined`/`HeartFilled`): Toggle favorite. Use `useFavorite()` hook.
- **Party** (`TeamOutlined`): Open party drawer. Render `ShareBoardButton` or trigger its drawer.
- **LED** (`BulbOutlined`/`BulbFilled`): Connect/send to board (only if Bluetooth supported). **Note**: `SendClimbToBoardButton` is dynamically imported with `ssr: false` because LED placement data is ~50KB. The play drawer should also use dynamic import or the extracted `useBluetoothConnection` hook (Phase 5).
- **Tick** (`CheckOutlined`): Log ascent. Use `TickButton` component.

Mini transport controls:
- Shows previous/current/next climb names
- Tap previous/next to navigate
- Current climb name centered, truncated with ellipsis

Key implementation details:
- Extract the swipe navigation logic from `play-view-client.tsx` into a shared hook: `usePlayViewNavigation()`
- **Note on swipe thresholds**: `play-view-client.tsx` uses `SWIPE_THRESHOLD=80`, while `queue-control-bar.tsx` and `queue-list-item.tsx` use `SWIPE_THRESHOLD=100`. The shared hook should use 80 (the play view value) since it's for navigating between climbs in the renderer view.
- The drawer should manage its own URL state - when opened, push a `#playing` hash to enable back-button closing via `popstate` event listener
- When the drawer is open and the user navigates (swipe/buttons), update the queue's `currentClimbQueueItem` via `setCurrentClimbQueueItem()` without URL navigation
- The existing `/play/[uuid]` route should remain functional for direct links and desktop, but mobile primarily uses the drawer
- **BoardRenderer lazy mounting**: Only mount `BoardRenderer` when the drawer is open (`destroyOnClose` or conditional render) to avoid performance impact. BoardRenderer renders an SVG with potentially hundreds of hold elements.
- **Wake lock**: The play drawer should also use `useWakeLock(true)` when open, matching the behavior of `SendClimbToBoardButton` when Bluetooth is connected.

**Card-swipe navigation pattern (Spotify-style)**:
- Remove the static arrow indicators (`LeftOutlined`/`RightOutlined` overlays) from the current play view
- Instead, the board renderer area becomes a horizontally swipeable card container
- During a swipe: the current card (board renderer) translates with the finger via `transform: translateX(${swipeOffset}px)`
- The next/previous card is pre-rendered off-screen (e.g., `translateX(100%)` or `translateX(-100%)`) and moves into view as the current card moves out
- On swipe completion (past threshold): animate the current card fully off-screen and the next card to center position using CSS transitions (~300ms ease-out)
- On swipe cancellation (below threshold): snap the current card back to center
- **Pre-rendering consideration**: Pre-rendering the next/previous BoardRenderer could be expensive. Options:
  1. **Lightweight preview**: Show a placeholder (climb thumbnail or miniature board) as the incoming card, then swap to full BoardRenderer after the animation completes
  2. **Cached render**: If the BoardRenderer is pure (same props = same output), consider caching the SVG output
  3. **Defer rendering**: Only render the incoming card's BoardRenderer after the swipe animation settles. During the swipe, show a colored placeholder card with the climb name/grade.
  - **Recommended**: Option 3 (defer rendering) for simplicity. The transition is fast enough (~300ms) that a brief placeholder is acceptable.

**New file: `packages/web/app/components/play-view/use-play-view-navigation.ts`**
- Shared hook extracting swipe logic from play-view-client.tsx
- Handles: handleNext, handlePrevious, swipeHandlers, swipeOffset, isAnimating, direction
- **No longer provides**: showSwipeHint (removed - the card motion itself is the feedback)
- Parameters: `{ boardDetails, angle, navigateOnChange?: boolean }` - when `navigateOnChange=true` (page route), push URL; when `false` (drawer), just update queue state
- Returns `{ swipeHandlers, swipeOffset, isAnimating, handleNext, handlePrevious, nextClimb, prevClimb }`
- Used by both PlayViewDrawer and PlayViewClient

### 3C: Impact on existing Play route

**Modify: `.../play/[climb_uuid]/play-view-client.tsx`**
- Keep the full page play view for desktop users and direct URL access
- Extract navigation logic to the shared hook (`usePlayViewNavigation` with `navigateOnChange: true`)
- **Replace** the static arrow indicator overlays (`LeftOutlined`/`RightOutlined` with opacity transitions) with the Spotify-style card-swipe animation (board renderer card translates with finger, next card slides in)
- **Remove** the `showSwipeHint` text ("Swipe left/right to navigate") - the card motion is self-explanatory
- On mobile, consider auto-redirecting to list view with the drawer open (or just keep both paths working). **Recommendation**: Keep both working. Direct links to `/play/` should work on mobile without redirect - forcing a redirect would break shared URLs.

**Modify: `.../play/layout-client.tsx`**
- No changes needed for desktop sidebar behavior

### Drawer state management
- The play drawer state (`isPlayDrawerOpen`) lives in `QueueControlBar` as local state
- **Potential issue**: If the play drawer is open and the user taps the Queue button, both drawers could overlap. Solution: Close the play drawer before opening the queue drawer. Use a single `activeDrawer` state: `'none' | 'play' | 'queue'`
- **Potential issue**: If the play drawer is open and the user triggers a page navigation (e.g., tapping a bottom tab), the drawer should auto-close. Listen for pathname changes via `usePathname()` to close the drawer.

---

## Phase 4: Header Redesign — Board Selector, User Drawer, Simplified Layout [DONE]

### What changes
- **Remove** the top-right meatball/ellipsis menu entirely
- **Add** a board selector next to the angle selector for switching boards
- **Add** a user avatar button in the top-right that opens a left-side user drawer
- Reduce header clutter by moving Party/LED/Search to bottom tab bar and queue control bar (from earlier phases)

### 4A: User Avatar & Left Drawer

**Remove**: The mobile meatball menu (`MoreOutlined` button + `mobileMenuItems` Dropdown) — entirely deleted
**Remove**: The desktop user dropdown (`UserOutlined` button + `userMenuItems` Dropdown) — replaced by the same drawer

**New file: `packages/web/app/components/user-drawer/user-drawer.tsx`**

A left-side drawer triggered by tapping the user avatar in the top-right corner of the header.

Trigger button:
- Logged in: User's avatar image (`session.user.image`) or initials fallback in a small circular AntD `Avatar`
- Not logged in: Generic `UserOutlined` icon in a circular avatar (neutral background)
- Position: Top-right of header (replaces the meatball menu on mobile, replaces the user dropdown on desktop)
- Works on both mobile and desktop (same component, same behavior)

Drawer:
- **Placement**: `"left"` (slides in from the left edge)
- **Width**: ~300px on desktop, ~85vw on mobile
- **Content**:

```
┌──────────────────────────────┐
│  ← (close)                   │
│                               │
│  ┌─────┐                      │
│  │     │  Username             │
│  │ AVA │  user@email.com       │
│  │     │                      │
│  └─────┘                      │
│                               │
│  [View Profile]               │  → /crusher/[user_id]
│                               │
├───────────────────────────────┤
│                               │
│  🔀 Change Board              │  → board switcher (see below)
│  ⚙ Settings                   │  → /settings
│  🎯 Classify Holds            │  opens HoldClassificationWizard
│  🕐 Recents                   │  → recent boards/sessions
│  📋 My Playlists              │  → /playlists (hidden for MoonBoard)
│                               │
├───────────────────────────────┤
│                               │
│  ❓ Help                       │  → /help
│  ℹ️ About                      │  → /about
│                               │
├───────────────────────────────┤
│                               │
│  🚪 Logout                    │  calls signOut()
│                               │
└───────────────────────────────┘
```

- **Not logged in** variant: Show avatar placeholder + "Sign in" button at the top. Below: Change Board, Recents, Help, About.
- **Change Board**: Navigates to the root setup wizard (`/`) or shows an inline list of `SUPPORTED_BOARDS` (kilter, tension, moonboard if enabled). Tapping a board navigates to `/[board_name]` to pick layout/size/sets. If the user has recently visited other board configurations (from `session-history-panel.tsx` data), those can appear as quick-switch options under Recents as well.
- **Recents section**: Shows recently visited board configurations from stored session data. Each entry shows board name + layout + size, tapping navigates directly to that configuration. This provides a quick way to switch between boards without going through the full setup wizard.

### 4B: Header Layout After Redesign

**Modify: `packages/web/app/components/board-page/header.tsx`**

All pages:
```
Mobile:   [Avatar]  [Logo]  [Angle ▾]
Desktop:  [Avatar]  [Logo]  [Angle ▾]  [+ Create]  [👥 Party]  [💡 LED]
```

Create page (unchanged):
```
Mobile:   [Logo]  [Cancel]  [Beta]  [Publish]
Desktop:  [Logo]  [Cancel]  [Beta]  [Publish]
```

Play/view pages:
```
Mobile:   [Avatar]  [← Back]  [Logo]  [Angle ▾]
Desktop:  [Avatar]  [Logo]  [Angle ▾]  [+ Create]  [👥 Party]  [💡 LED]
```

Key changes:
- **Avatar** is now the leftmost element (before Logo) — tapping opens the left user drawer
- **Meatball menu** (`MoreOutlined`) is completely removed — all items move to the user drawer
- **Desktop user dropdown** is completely removed — replaced by the same avatar → drawer
- **Board switching** lives in the user drawer (via "Change Board" item), not the header bar
- Desktop still shows Party, LED, Create buttons inline (unchanged from earlier phases)
- **Mobile `SearchButton`** (advanced filters icon) already moved to bottom tab bar (Phase 1)
- **Mobile `SearchClimbNameInput`** removed from header — search now lives entirely in the Search tab's full-screen experience (Phase 1)

### Files to modify

**Modify: `packages/web/app/components/board-page/header.tsx`**

Removals:
- **Remove**: `ShareBoardButton` (party mode) from `onboarding-party-light-buttons` span (mobile only) — moved to QueueControlBar in Phase 3
- **Remove**: `SendClimbToBoardButton` (LED) from `onboarding-party-light-buttons` span (mobile only) — moved to play view drawer in Phase 3
- **Remove**: Mobile `SearchButton` — moved to bottom tab bar in Phase 1
- **Remove**: `SearchClimbNameInput` — search now lives in the Search tab experience (Phase 1)
- **Remove**: `UISearchParamsProvider` wrapper in header (was there for search components, no longer needed)
- **Remove**: `mobileMenuItems` array and the mobile meatball `Dropdown` entirely
- **Remove**: `userMenuItems` array and the desktop user `Dropdown` entirely
- **Remove**: All `signOut`, `setShowAuthModal`, `setShowHoldClassification` handlers from header (they move to user drawer)

Additions:
- **Add**: `<UserDrawerButton />` component (avatar that opens the drawer) — leftmost position

**New file: `packages/web/app/components/user-drawer/user-drawer.tsx`**
- Left-side drawer with user info, navigation links, and actions

**New file: `packages/web/app/components/user-drawer/user-drawer.module.css`**
- Styles for drawer sections, avatar area, menu items

**Modify: `packages/web/app/components/board-page/header.module.css`**
- Remove `.mobileMenuButton` class (no longer needed)
- May need new positioning for avatar button

### Header height
- Keep at `8dvh` / min 48px
- The added board selector may make the header slightly more crowded — if needed, make the board selector icon-only on mobile with a tooltip

### Considerations
- **Onboarding tour references**: Tour steps referencing `onboarding-party-light-buttons` need updating (Party/LED moved in earlier phases). The user avatar is a new stable target for a "profile" tour step.
- **Dynamic import of SendClimbToBoardButton**: After this phase, only loaded on desktop in the header. Play drawer (Phase 3) handles its own LED button.
- **HoldClassificationWizard**: Currently rendered in `header.tsx` and triggered by meatball menu. After redesign, the wizard should be rendered within or triggered from the user drawer. The drawer can manage its own `showHoldClassification` state.
- **AuthModal**: Currently rendered in `header.tsx`. After redesign, the user drawer handles sign-in. Move `AuthModal` rendering to the user drawer component.
- **Session data for Recents**: The `session-history-panel.tsx` already reads stored sessions from IndexedDB. Reuse this data source for the Recents section in the user drawer.

---

## Phase 5: Party Mode & LED as Drawer [DONE]

### What changes
Convert party mode into a bottom drawer (instead of top drawer) and integrate LED connection into it.

### Files to modify

**Modify: `packages/web/app/components/board-page/share-button.tsx`**
- Change drawer placement from `"top"` to `"bottom"`
- Change drawer styles from `wrapper: { height: '70vh' }` to appropriate bottom drawer height
- Rename component to `PartyModeButton` (optional, for clarity). **Note**: This requires updating all import sites: `header.tsx`, `queue-control-bar.tsx` (added in Phase 3), and `play-view-drawer.tsx` (added in Phase 3B). If renaming, also update the named export `ShareBoardButton`.
- Add a "Connect to Board" section. The existing drawer already uses AntD `Tabs` for Start/Join session. Add a third tab:
  1. **Start Session** - existing start session UI
  2. **Join Session** - existing join session UI
  3. **Connect to Board (LED)** - Bluetooth connection UI
- When a session is active (connected state), the tab structure collapses to show session info + LED tab

**New section within the party drawer: LED Connection tab**
- "Connect to Board" button (replaces the header LED button on mobile)
- Connection status indicator (connected/disconnected)
- When connected: "Connected to [device name]" with disconnect option
- This reuses the logic from `SendClimbToBoardButton` but presents it differently
- On mobile, this is the only way to access LED. On desktop, the header button remains as a quick shortcut.
- **Note**: Show iOS Bluefy recommendation within this tab when `navigator.bluetooth` is not available, reusing the existing modal content from `SendClimbToBoardButton`.
- **Note**: The auto-send on climb change behavior (the `useEffect` watching `currentClimbQueueItem` in `SendClimbToBoardButton`) must be preserved. The extracted `useBluetoothConnection` hook should include this auto-send effect.

**Modify: `packages/web/app/components/board-bluetooth-control/send-climb-to-board-button.tsx`**
- Extract connection logic into a shared hook: `useBluetoothConnection()`
- The button component becomes a thin wrapper around the hook
- The party drawer's LED section also uses the same hook
- **Keep the dynamic import pattern** - the button still needs `next/dynamic` with `ssr: false` for the header usage on desktop

**New file: `packages/web/app/components/board-bluetooth-control/use-bluetooth-connection.ts`**
- Extracts: device ref, characteristic ref, connect/disconnect, send climb, connection state
- Returns: `{ isConnected, isLoading, connect, disconnect, sendClimb, showBluetoothWarning, isBluetoothSupported }`
- **Must include**: The `useWakeLock(isConnected)` call to prevent device sleep while connected
- **Must include**: The disconnection event listener (`gattserverdisconnected`)
- **Must include**: The auto-send effect when `currentClimbQueueItem` changes
- **Must include**: The `convertToMirroredFramesString` logic for mirrored climbs
- **Dependency**: Needs `boardDetails` prop for `getLedPlacements()` and `getBluetoothPacket()` - these require `board_name`, `layout_id`, `size_id`
- **Dependency**: Needs `currentClimbQueueItem` from `useQueueContext()` - decide whether the hook subscribes to context internally or receives it as a parameter. Recommend: receive as parameter for flexibility.

### Party mode trigger locations
- **QueueControlBar**: Party mode button (badge shows connected user count)
- **Play view drawer action bar**: Party mode button
- **Desktop header**: Keeps existing position (ShareBoardButton)

### Considerations
- **Multiple instances of ShareBoardButton**: After Phase 3, `ShareBoardButton` renders in QueueControlBar, the play drawer action bar, and the desktop header. Each instance manages its own drawer state independently, which is fine since only one drawer opens at a time. However, the button's badge (user count) relies on `useQueueContext()` which is shared.
- **Bluetooth singleton**: The `useBluetoothConnection` hook manages refs to a single Bluetooth device/characteristic. If multiple components mount this hook simultaneously, they'll each have independent refs, potentially causing conflicts. Solution: Either use a React context to share Bluetooth state, or ensure only one component mounts the hook at a time (e.g., the party drawer tab is the single source, with only a status indicator elsewhere).

---

## Phase 6: Queue List Improvements

### What changes
Minor refinements to the queue list to match the new design language.

### Files to modify

**Modify: `packages/web/app/components/queue-control/queue-list-item.tsx`**
- Ensure visual consistency with the new `ClimbListItem` compact format
- Same height (~60-64px), typography, grade coloring
- Keep existing swipe actions (swipe right=tick, swipe left=delete) - these are intentionally different from ClimbListItem's swipe actions (heart/queue) because queue items need tick and remove operations
- Keep drag-and-drop reordering (`@atlaskit/pragmatic-drag-and-drop`)
- Keep the existing ellipsis dropdown menu (View Climb, Tick, Open in App, Remove)
- **Note**: QueueListItem currently uses `Row`/`Col` with `xs`/`sm` breakpoints for layout. Consider switching to flexbox to match ClimbListItem and avoid layout inconsistency at different viewport sizes.

**Modify: queue drawer behavior in `queue-control-bar.tsx`**
- Queue drawer now opens from the dedicated Queue button on the bar (not from tapping climb info)
- Placement stays bottom, height stays 70%
- Add a count badge on the Queue button showing queue length
- **Keep**: The existing `TOUR_PLAY_VIEW_EVENT` listener that opens/closes the play view for the guided tour.
- **Keep**: The `handleDrawerOpenChange` callback that scrolls to the current climb when the drawer opens

---

## Phase 7: Desktop Adaptation

### What changes
Ensure the desktop experience remains cohesive while the mobile experience is transformed.

### Desktop-specific behavior

1. **No bottom tab bar** - Hidden via CSS media query (>= 768px)
2. **Sidebar stays** - Queue/Search/Search by Hold tabs in the sidebar (existing `ListLayoutClient` with 3 tabs, not 2)
3. **Header keeps** - Party, LED, Create buttons in header (wrapped in `.desktopOnly` class from `header.module.css`). User avatar + left drawer works the same on desktop (no separate user dropdown).
4. **Play view** - Desktop users still use the full `/play/` page route with the sidebar layout (`play/layout-client.tsx`)
5. **Climb list** - Default to compact (list) mode on all devices. Grid (card) mode available via toggle. Respect any stored IndexedDB preference.
6. **QueueControlBar** - Shows additional prev/next buttons on desktop (existing `.navButtons` CSS class already handles this), keeps mirror button visible, keeps play link

### Files to modify
- **`packages/web/app/components/bottom-tab-bar/bottom-tab-bar.module.css`**: `display: none` for >= 768px
- **`packages/web/app/components/queue-control/queue-control-bar.tsx`**: Conditional rendering of play link and mirror button on desktop (since desktop doesn't use the drawer). Use the existing `.navButtons` CSS pattern or add a new `.desktopOnly` class.
- **`packages/web/app/components/board-page/header.tsx`**: Desktop keeps party + LED + create buttons via `.desktopOnly` class. Avatar + user drawer works the same on both breakpoints.
- **`packages/web/app/components/queue-control/queue-control-bar.module.css`**: May need new CSS classes for desktop-only buttons (mirror, play link)

### Verification checklist
- The 3-tab sidebar (Queue/Search/Search by Hold) works unchanged
- Desktop header shows: Avatar, Logo, Angle, Create, Party, LED
- Desktop QueueControlBar shows: Mirror, Play link, Prev, Next, Party, Queue, Tick
- Bottom tab bar is invisible on desktop
- Play drawer never opens on desktop (tapping bar navigates to `/play/` route instead)
- Climb list defaults to compact mode on desktop (grid available via toggle)
- All keyboard navigation still works (tab, enter, etc.)

---

## Implementation Order

The phases are designed to be implemented sequentially, each building on the previous:

```
Phase 1: Bottom Tab Bar + Home Screen
  └─ Foundation for new navigation structure
  └─ Home screen placeholder (feature-flagged)
  └─ Create drawer for "Create" tab

Phase 2: Compact Climb List Mode
  └─ ClimbListItem component
  └─ Swipe actions (heart/queue)
  └─ Ellipsis menu drawer
  └─ View mode toggle

Phase 3: Now Playing Bar + Play Drawer
  └─ 3A: QueueControlBar button redesign
  └─ 3B: Full-screen play drawer
  └─ 3C: Shared navigation hook

Phase 4: Header Redesign — User Drawer + Board Selector
  └─ User avatar button + left drawer
  └─ Change Board in drawer
  └─ Recents from session history
  └─ Remove meatball menu + desktop user dropdown

Phase 5: Party Mode & LED Drawer
  └─ Bottom drawer conversion
  └─ LED integration
  └─ Bluetooth hook extraction

Phase 6: Queue List Polish
  └─ Visual alignment with compact list

Phase 7: Desktop Adaptation
  └─ Responsive breakpoint verification
  └─ Desktop-specific overrides
```

---

## Component Dependency Graph

```
Root layout (app/layout.tsx)
├── PersistentSessionProvider (already exists at root)
│   └── GlobalQueueControlBar [NEW] (persistent, visible on ALL pages when queue active)
│       ├── Shows compact QueueControlBar (~45px) on non-board pages
│       ├── Data from PersistentSessionContext (localQueue / activeSession)
│       ├── Tap → navigates back to board route
│       └── Hidden on board routes (board layout renders its own instance)
│
Board layout.tsx (server component)
├── BoardSessionBridge
│   └── ConnectionSettingsProvider
│       └── GraphQLQueueProvider (provides QueueContext used everywhere)
│           └── PartyProvider
│
├── BoardSeshHeader (redesigned)
│   ├── UserDrawerButton [NEW] (avatar → opens left drawer)
│   │   └── UserDrawer [NEW] (left-side)
│   │       ├── Avatar + Username + Email
│   │       ├── View Profile → /crusher/[user_id]
│   │       ├── Change Board → / (setup wizard) or quick-switch
│   │       ├── Settings → /settings
│   │       ├── Classify Holds → HoldClassificationWizard
│   │       ├── Recents (from session-history data)
│   │       ├── My Playlists → /playlists (hidden for MoonBoard)
│   │       ├── Help → /help
│   │       ├── About → /about
│   │       └── Logout / Sign In
│   ├── Logo
│   ├── AngleSelector
│   ├── CreateModeButtons (only on /create page)
│   └── [Desktop only]: CreateButton, ShareBoardButton, SendClimbToBoardButton
│
├── Content
│   ├── ClimbsList
│   │   ├── ViewModeToggle [NEW] (Grid/List switch, sticky)
│   │   ├── ClimbCard (grid mode)
│   │   └── ClimbListItem (compact mode) [NEW]
│   │       ├── ClimbThumbnail
│   │       ├── ClimbTitle (name, grade, stars, AscentStatus)
│   │       ├── Swipe: Heart / Add to Queue
│   │       └── ClimbActionsDrawer [NEW]
│   │           └── ClimbActions (viewMode="list" or "button")
│   │
│   └── ListLayoutClient (desktop sidebar)
│       └── Tabs: Queue | Search | Search by Hold
│
├── QueueControlBar (redesigned, compact ~45px with 36px thumbnail)
│   ├── ClimbThumbnail (36px) + ClimbTitle (mobile: tap → PlayViewDrawer)
│   ├── [Desktop only]: MirrorButton, PlayLink, PrevButton, NextButton
│   ├── ShareBoardButton / PartyModeButton (moved from header)
│   ├── QueueButton [NEW] (badge with count, opens queue drawer)
│   ├── TickButton
│   ├── Queue Drawer (existing, bottom, 70%)
│   └── PlayViewDrawer [NEW] (mobile only, bottom, 95-100%)
│       ├── Drag handle (react-swipeable)
│       ├── ClimbTitle (horizontal) + AscentStatus
│       ├── BoardRenderer (lazy-mounted, fillHeight)
│       ├── Swipe Navigation (usePlayViewNavigation hook)
│       ├── Action Bar [Mirror, Heart, Party, LED, Tick]
│       └── Mini Transport [Prev | Current | Next]
│
└── BottomTabBar [NEW] (mobile only)
    ├── Climb Tab → Navigate to /list
    ├── Your Library Tab → Navigate to /playlists
    └── Create Tab → Open CreateDrawer [NEW]
        ├── Climb → /create route
        └── Playlist → Opens Create Playlist drawer (hidden for MoonBoard)
```

---

## Shared Hooks to Extract

| Hook | Source | Used By | Key Dependencies |
|---|---|---|---|
| `usePlayViewNavigation` | `play-view-client.tsx` | PlayViewDrawer, PlayViewClient | `useQueueContext()`, `react-swipeable`, `boardDetails`, `angle`. Parameterized with `navigateOnChange` to control URL push behavior. |
| `useBluetoothConnection` | `send-climb-to-board-button.tsx` | SendClimbToBoardButton, PartyDrawer LED section, PlayViewDrawer LED button | `boardDetails` (for LED placements), `currentClimbQueueItem` (for auto-send). Includes `useWakeLock`, disconnect listener, mirrored frames conversion. **Singleton concern**: Must ensure only one active Bluetooth connection across all consumers - consider a BluetoothContext provider instead of a plain hook. |

---

## CSS / Styling Approach

- All new components use **themeTokens** for colors, spacing, radii
- CSS modules for layout-only styles (flex, grid, responsive breakpoints)
- Inline styles for dynamic values (colors from theme, computed values)
- Media queries at 768px breakpoint for mobile/desktop splits
- Use `env(safe-area-inset-bottom)` for iOS safe area on bottom bar
- AntD Drawer component for all drawer UIs (consistent animations)
- Swipe gesture patterns reuse the existing `react-swipeable` + offset/threshold pattern

---

## Transition Animations

| Transition | Type | Duration |
|---|---|---|
| Play drawer open/close | Drawer slide-up | 300ms (AntD default) |
| Bottom tab active state | Color transition | 150ms ease |
| Card swipe (play view) | Transform translateX | Immediate (follows finger), 300ms ease-out on release |
| Card swipe (queue bar) | Transform translateX | Immediate (follows finger), 200ms ease-out on release |
| Card swipe snap-back | Transform translateX | 200ms ease (when below threshold) |
| List item swipe action reveal | Transform + opacity | Immediate (follows finger) |
| List item swipe snap-back | Transform | 150ms ease (existing) |
| List mode toggle | Fade / layout shift | 200ms ease |
| Create drawer open | Drawer slide-up | 300ms |

---

## Accessibility Considerations

- Bottom tab bar items have `aria-label` and `role="tab"`
- Play drawer has `aria-label="Now playing"` and manages focus on open
- Swipe actions have non-swipe alternatives (ellipsis menu for list items, buttons in play view)
- Color-coded grades maintain sufficient contrast ratios
- All interactive elements maintain minimum 44x44px touch targets

---

## State Management Impact

- **One new context likely needed**: `BluetoothContext` to share Bluetooth connection state across `SendClimbToBoardButton` (desktop header), play drawer LED button, and party drawer LED tab. A plain hook would create independent connection instances. Alternatively, keep the hook-only approach but mount it in exactly one place and pass state down via props.
- **Existing contexts consumed**: `QueueContext` (via `useQueueContext()`), `BoardProvider` (via `useBoardProvider()`), `FavoritesProvider` (via `useFavorite()`), `PersistentSessionContext` (via `usePersistentSession()` — used by `GlobalQueueControlBar` for off-route rendering)
- **Global bar visibility**: Derived from `PersistentSessionContext` state: `hasActiveQueue = (localQueue.length > 0 || !!localCurrentClimbQueueItem || !!activeSession)`. Combined with `useIsOnBoardRoute()` to determine whether the global instance or board-route instance should render.
- **View mode preference**: IndexedDB via `user-preferences-db.ts` (`climbListViewMode: 'compact' | 'grid'`). Default to `'compact'` on all devices when no stored preference.
- **Play drawer open state**: Local state in QueueControlBar. Use a single `activeDrawer: 'none' | 'play' | 'queue'` state to prevent drawer stacking conflicts.
- **Bottom tab active state**: Derived from current URL pathname via `usePathname()`
- **Bluetooth connection state**: Extracted to shared hook or context (see above)
- **Hash state for play drawer**: `#playing` hash pushed on drawer open, cleared on close. `popstate` listener to close drawer on back button.

---

## Risk Areas & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Play drawer performance | BoardRenderer in drawer renders complex SVG with hundreds of hold elements | Lazy-render: only mount BoardRenderer when drawer `open=true`. Use AntD Drawer's `destroyOnClose` or conditional render. |
| Swipe conflict with scroll | Horizontal swipes on ClimbListItem could interfere with vertical scroll in the list | Copy the direction-detection pattern from `queue-list-item.tsx` (not `queue-control-bar.tsx`). The `isHorizontalSwipe` state with `absX > absY` check on first 10px of movement is critical. |
| Desktop regression | Moving buttons around might break desktop flow | Phase 7 explicitly verifies desktop. Use existing `.desktopOnly`/`.mobileOnly` CSS classes from `header.module.css`. Add equivalent classes to `queue-control-bar.module.css`. |
| Deep link to /play/ | Existing play URLs must still work on mobile | Keep the `/play/` route fully functional. Don't auto-redirect to list+drawer. Both paths work. |
| Party mode button discovery | Moving from header to bar might confuse users | Badge with user count draws attention. Consider a one-time tooltip on the new party button location using the existing onboarding tour system. |
| Double drawer stacking | Play drawer open + queue drawer open simultaneously | Use single `activeDrawer` state in QueueControlBar: `'none' | 'play' | 'queue'`. Opening one automatically closes the other. |
| Bluetooth singleton conflict | Multiple components mounting `useBluetoothConnection` create independent connections | Use a BluetoothContext provider or ensure hook is mounted in exactly one place with state shared via props/context. |
| Global bar data availability | `GlobalQueueControlBar` needs board details and queue data from `PersistentSessionContext` which may have stale or missing data | `PersistentSessionContext` already persists `localBoardDetails`, `localQueue`, `localCurrentClimbQueueItem`. For party mode, `activeSession.boardDetails` is always set on activation. If data is missing, the global bar simply doesn't render (same as current `FloatingSessionThumbnail` logic). |
| Global bar z-index conflicts | Persistent bar at root level may overlap modals, drawers, or other fixed-position elements on non-board pages | Use `z-index: 999` (below AntD modals at 1000+). Add `padding-bottom` to page content when bar is visible. Test with auth modals, setup wizard, and board selection pages. |
| AntD Drawer drag-to-dismiss | AntD Drawer doesn't natively support drag-to-close gesture | Implement custom drag handle with `react-swipeable` at the top of the drawer. On downward swipe past threshold, call `onClose`. May feel less smooth than native sheet - test early. |
| LED data bundle size | LED placement data (~50KB) loaded via `getLedPlacements()` | Currently dynamically imported in header. After redesign, also needed in play drawer. Use dynamic import in both locations, or move to BluetoothContext that lazy-loads data on first connection attempt. |
| Onboarding tour breakage | Tour steps reference element IDs that move or disappear on mobile | Audit all tour step selectors (`onboarding-queue-bar`, `onboarding-party-light-buttons`, `onboarding-climb-card`, `onboarding-queue-toggle`) and update targets for the new layout. |
| Create URL construction | BottomTabBar and CreateDrawer need board route context to build `/create` and `/playlists` URLs | Pass `boardDetails` and `angle` as props from `layout.tsx`, or use `useParams()` to read from URL. Prefer props from the server component for accuracy. |

---

## Testing Checklist

### Phase 1
- [x] Bottom tab bar renders on mobile, hidden on desktop
- [x] Climb tab navigates to /list
- [x] Your Library tab navigates to /playlists
- [x] Your Library tab shows as active when on playlists page
- [x] Create tab opens create drawer
- [x] Create drawer options work (Climb navigates to /create, Playlist opens create playlist form)
- [x] Create drawer hides playlist option for MoonBoard
- [x] iOS safe area padding works (`env(safe-area-inset-bottom)`)
- [x] Tab bar does not overlap QueueControlBar
- [x] Content area scrolling is not blocked by tab bar
- [x] Tab bar shows on play/view pages
- [x] Active tab state highlights correctly on /list, /playlists, and other pages
- [x] Search input and advanced search button remain in header on list pages (mobile)

### Phase 2
- [x] Compact list items render correctly with proper layout
- [x] Grade colors match existing ClimbTitle colors
- [x] AscentStatus icon shows on compact list items
- [x] Swipe right favorites a climb (visual feedback, auth check)
- [x] Swipe left adds to queue (visual feedback + queue updates)
- [x] Swipe direction detection works (vertical scroll not blocked)
- [x] Ellipsis menu opens bottom drawer with all actions
- [x] All actions in drawer work (favorite, queue, tick, share, playlist, open-in-app, mirror, fork, view)
- [x] View mode toggle persists across page loads (IndexedDB)
- [x] View mode defaults to compact on all devices
- [x] Infinite scroll works in both modes
- [x] Scroll position restoration (hash-based) works in both modes
- [x] Selected climb highlighting works in compact mode

### Phase 3
- [x] QueueControlBar is ~45px tall (20% shorter than before) with 36px thumbnail
- [x] Bar appears on **all pages** when there is an active local queue
- [x] Bar appears on **all pages** when there is an active party session
- [x] Bar does NOT appear when there is no queue and no active session
- [x] On non-board pages, tapping the bar navigates back to the board route
- [x] On board pages, tapping the bar opens full-screen drawer (mobile only)
- [x] On board pages, tapping the bar navigates to /play/ route (desktop)
- [x] Global bar hides when navigating to a board route (board layout renders its own)
- [x] No duplicate bars visible on board routes
- [x] `FloatingSessionThumbnail` is fully removed — no floating card appears anywhere
- [x] Play drawer shows board renderer correctly (lazy-mounted)
- [x] Card-swipe navigation works in play drawer (content translates, next card slides in)
- [x] Card-swipe navigation works in QueueControlBar (current climb slides out, next slides in)
- [x] Mirror/favorite/tick actions work in play drawer
- [x] Drag-to-close works smoothly (custom react-swipeable handle)
- [x] Back button closes play drawer (hash-based `#playing`)
- [x] Queue button opens queue drawer (play drawer closes first)
- [x] Party button opens party drawer
- [x] Desktop QueueControlBar still has mirror, play link, prev/next buttons
- [x] /play/ URLs still work for direct links on all devices
- [x] Wake lock activates when play drawer is open
- [x] Page content has proper bottom padding when global bar is visible

### Phase 4
- [x] Meatball menu is completely removed (mobile and desktop)
- [x] Desktop user dropdown is completely removed
- [x] User avatar button appears top-left on all pages
- [x] Tapping avatar opens left-side user drawer
- [x] User drawer shows correct content when logged in (avatar, username, email, all menu items)
- [x] User drawer shows sign-in prompt when logged out
- [x] "Change Board" navigates to setup wizard or shows board list
- [x] "Recents" shows recently visited board configurations
- [x] "Classify Holds" opens HoldClassificationWizard from the drawer
- [x] Logout works from the drawer
- [x] Desktop header still has Create, Party, LED buttons inline
- [x] Mobile header is simplified (Avatar, Logo, Angle)
- [x] All removed items are accessible via user drawer or other new locations
- [x] Onboarding tour steps still target valid elements
- [x] SendClimbToBoardButton dynamic import only loads on desktop

### Phase 5
- [x] Party drawer opens from bottom (not top)
- [x] Party drawer has 3 tabs: Start, Join, Connect to Board
- [x] LED connection tab shows Bluefy recommendation on iOS
- [x] Bluetooth hook works from party drawer LED tab
- [x] Start/join/leave session flows work unchanged
- [x] LED auto-sends on climb change (existing behavior preserved)
- [x] Wake lock activates when Bluetooth connected
- [x] No duplicate Bluetooth connections from multiple hook instances

### Phase 6
- [ ] Queue list items visually match compact climb list items (height, typography)
- [ ] Drag-and-drop reordering still works
- [ ] Queue badge shows correct count on Queue button
- [ ] Onboarding tour can still open/close queue drawer

### Phase 7
- [ ] Desktop sidebar works unchanged (3 tabs: Queue, Search, Search by Hold)
- [ ] Desktop header has all expected buttons
- [ ] Desktop play page works as before (full route with sidebar)
- [ ] Responsive breakpoints are clean (no flickering between mobile/desktop)
- [ ] Bottom tab bar is invisible on desktop
- [ ] Climb list defaults to compact on desktop (grid via toggle)
- [ ] Desktop QueueControlBar shows all buttons (mirror, play, prev, next, party, queue, tick)

---

## Cleanup & Consolidation

The UI redesign touches many of the same files where duplicated patterns exist. This is the ideal time to consolidate them rather than adding more duplication. These cleanups should be done **during** the relevant phase, not as a separate pass.

### 1. URL Construction Consolidation (do in Phase 1)

**Problem**: The slug-vs-numeric URL fallback pattern is copy-pasted 20+ times across 9+ files:
```tsx
// This pattern repeats everywhere:
const url = boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names
  ? constructPlayUrlWithSlugs(board_name, layout_name, size_name, ...)
  : `/${board_name}/${layout_id}/${size_id}/${set_ids.join(',')}/${angle}/play/${uuid}`;
```

**Files with duplication**:
- `queue-control-bar.tsx` (2 instances: `buildClimbUrl()`, `getPlayUrl()`)
- `next-climb-button.tsx` (1 instance)
- `previous-climb-button.tsx` (1 instance)
- `play-view-client.tsx` (2 instances: `getBackToListUrl()`, `navigateToClimb()`)
- `climb-view-actions.tsx` (1 instance: `getBackToListUrl()`)
- `playlist-view-actions.tsx` (1 instance: `getBackToListUrl()`)
- `playlists-list-content.tsx` (2 instances)
- `discover-playlists-content.tsx` (1 instance)
- `header.tsx` (2 instances: `getBackToListUrl()`, `createClimbUrl`)

**Consolidation**: Add safe wrapper functions to `url-utils.ts`:
```tsx
// url-utils.ts - new functions
export const buildClimbPlayUrl = (boardDetails: BoardDetails, angle: Angle, climbUuid: string, climbName?: string) => { ... }
export const buildClimbViewUrl = (boardDetails: BoardDetails, angle: Angle, climbUuid: string, climbName?: string) => { ... }
export const buildClimbListUrl = (boardDetails: BoardDetails, angle: Angle) => { ... }
export const buildCreateUrl = (boardDetails: BoardDetails, angle: Angle) => { ... }
export const buildPlaylistsUrl = (boardDetails: BoardDetails, angle: Angle) => { ... }
```

Each function internally handles the slug-vs-numeric check. All 20+ call sites become one-liners.

**Also extract**: A shared hook `useClimbNavigation(boardDetails, angle)` that returns `{ navigateToClimb, navigateToList, buildClimbUrl }` for components that need router integration + search param preservation.

### 2. Swipe Logic Consolidation (do in Phases 2-3)

**Problem**: Three swipe implementations with overlapping but inconsistent code:

| File | Purpose | Threshold | MAX_SWIPE | Direction Detection | preventScrollOnSwipe |
|------|---------|-----------|-----------|--------------------|--------------------|
| `queue-control-bar.tsx` | Prev/next climb | 100 | 120 | None | `true` |
| `queue-list-item.tsx` | Tick/delete reveal | 100 | 120 | State-based (`isHorizontalSwipe`) | `false` + manual |
| `play-view-client.tsx` | Prev/next climb | 80 | Unclamped | Inline check | `false` |

**Consolidation**: Create two shared hooks in `packages/web/app/hooks/`:

1. **`use-card-swipe-navigation.ts`** - Spotify-style card swipe (Phase 3)
   - Used by: PlayViewDrawer, PlayViewClient, QueueControlBar
   - Handles: translateX animation, next/prev card transition, threshold detection
   - Parameters: `{ threshold?, onSwipeLeft, onSwipeRight }`

2. **`use-swipe-to-reveal.ts`** - Action reveal behind list items (Phase 2)
   - Used by: ClimbListItem (new), QueueListItem (refactored)
   - Handles: direction detection, clamped offset, action opacity, snap-back
   - Parameters: `{ threshold?, maxSwipe?, onSwipeLeft, onSwipeRight, leftAction, rightAction }`
   - Includes the `isHorizontalSwipe` direction detection from `queue-list-item.tsx`

**Naming inconsistency to fix**: `queue-list-item.tsx` has opacity variable names swapped (`leftActionOpacity` controls right-swipe opacity). Fix during extraction.

### 3. "Added By" Avatar Component (do in Phase 6)

**Problem**: Identical avatar rendering code (~15 lines) in `queue-control-bar.tsx` and `queue-list-item.tsx`:
```tsx
{item.addedByUser ? (
  <Tooltip title={item.addedByUser.username}>
    <Avatar size="small" src={item.addedByUser.avatarUrl} icon={<UserOutlined />} />
  </Tooltip>
) : (
  <Tooltip title="Added via Bluetooth">
    <Avatar size="small" style={{ backgroundColor: 'transparent' }}
      icon={<BluetoothIcon style={{ color: themeTokens.neutral[400] }} />} />
  </Tooltip>
)}
```

**Consolidation**: Extract to `packages/web/app/components/queue-control/added-by-avatar.tsx`:
```tsx
export const AddedByAvatar: React.FC<{ addedByUser?: QueueUser }> = ({ addedByUser }) => { ... }
```

### 4. Dead Code Removal (do during each phase)

After moving components around, the following become dead code and should be deleted:

**After Phase 3**:
- `floating-session-thumbnail.tsx`: **Delete entirely** — replaced by `GlobalQueueControlBar`
- Remove `FloatingSessionThumbnail` import and rendering from wherever it's mounted (root layout / persistent session area)
- `play-view-client.tsx`: `showSwipeHint` state and the 3-second timer effect
- `play-view-client.tsx`: Static arrow indicator overlays (`swipeIndicator` CSS classes)
- `play-view.module.css`: `.swipeIndicator`, `.swipeIndicatorLeft`, `.swipeIndicatorRight`, `.swipeIndicatorVisible` classes
- `queue-control-bar.tsx`: `FastBackwardOutlined` / `FastForwardOutlined` imports and swipe action backgrounds (`.swipeAction` colored divs)
- `queue-control-bar.tsx`: `boardPreviewContainerStyle` width updated from 48 to 36
- `queue-control-bar.module.css`: `.swipeAction` class (if no longer used)

**After Phase 4**:
- `header.tsx`: Entire `mobileMenuItems` array and the meatball `Dropdown` component
- `header.tsx`: Entire `userMenuItems` array and the desktop user `Dropdown` component
- `header.tsx`: `signOut` import and `handleSignOut` handler (moves to user drawer)
- `header.tsx`: `showAuthModal` state and `AuthModal` render (moves to user drawer)
- `header.tsx`: `showHoldClassification` state and `HoldClassificationWizard` render (moves to user drawer)
- `header.module.css`: `.mobileMenuButton` class (no longer needed)
- Verify the `onboarding-party-light-buttons` span doesn't become an empty wrapper on mobile
- **Note**: `SearchButton`, `SearchClimbNameInput`, and `UISearchParamsProvider` remain in header (search stays in header)

**After Phase 5**:
- `send-climb-to-board-button.tsx`: Connection logic that moves to `use-bluetooth-connection.ts` (the component becomes a thin wrapper)

### 5. Inline Style Cleanup (ongoing)

**Problem**: `CLAUDE.md` says "Try to avoid use of the style property", but several key files have 20-40+ inline style objects.

**Worst offenders being modified in the redesign**:
- `queue-control-bar.tsx` - heavy inline styles for the bar layout, swipe backgrounds, drawer
- `share-button.tsx` - inline styles for party mode drawer sections
- `queue-list-item.tsx` - inline styles for swipe backgrounds, item layout

**Approach**: As each file is modified during a phase, migrate inline styles to its CSS module. Don't do a separate refactor pass - do it incrementally as code is touched. Priority targets:
- Swipe action backgrounds → CSS module classes
- Flex layout containers → CSS module classes
- Theme token references → CSS custom properties (already partially done in `index.css`)

### 6. Board Feature Checks Consolidation (do in Phase 2)

**Problem**: `boardDetails.board_name === 'moonboard'` checks scattered across files. The redesign adds more MoonBoard-conditional behavior (CreateDrawer, ClimbListItem mirror action, PlayViewDrawer mirror button).

**Consolidation**: Create a utility or use existing `boardDetails` properties:
```tsx
// Already exists but underused:
boardDetails.supportsMirroring  // Use this instead of name checks for mirror

// Add to BoardDetails type if missing:
boardDetails.supportsPlaylists
boardDetails.supportsHoldClassification
boardDetails.supportsClimbCreation
```

This avoids the new components needing to know about specific board names.

### 7. Queue Clear Confirmation Pattern (do in Phase 6)

**Problem**: Queue clear with confirmation dialog duplicated in:
- `queue-control-bar.tsx` (queue drawer header)
- `list/layout-client.tsx` (desktop sidebar queue tab)
- `play/layout-client.tsx` (desktop play sidebar)

**Consolidation**: Extract to `packages/web/app/components/queue-control/clear-queue-button.tsx`:
```tsx
export const ClearQueueButton: React.FC<{ boardDetails: BoardDetails }> = ({ boardDetails }) => { ... }
```

Includes the Popconfirm, analytics tracking, and `setQueue([])` call.

### Summary

| Consolidation | Phase | Files Affected | LOC Saved (est.) |
|---|---|---|---|
| URL construction wrappers | 1 | 9+ files | ~200 lines |
| Swipe hooks extraction | 2-3 | 3 files → 2 hooks | ~150 lines |
| AddedByAvatar component | 6 | 2 files | ~25 lines |
| Dead code removal | 3-5 | 4+ files | ~80 lines |
| Inline style migration | Ongoing | 3+ files | Net zero (moves to CSS) |
| Board feature checks | 2 | 5+ files | ~20 lines + maintainability |
| ClearQueueButton | 6 | 3 files | ~40 lines |
| **Total** | | | **~515 lines** |

---

## Architecture Notes & Decisions

### Server vs Client Component Boundary

The main `layout.tsx` is a **server component** that wraps everything in providers. New client components (BottomTabBar, PlayViewDrawer, CreateDrawer) must be placed within the existing client boundary. Specifically:

- `BottomTabBar` needs `QueueContext` access (for active state) → must be inside `GraphQLQueueProvider`
- `PlayViewDrawer` needs `QueueContext` + `BoardProvider` → must be inside both providers
- `CreateDrawer` needs route params → can use `useParams()` or receive props from layout
- `GlobalQueueControlBar` needs `PersistentSessionContext` access → must be inside `PersistentSessionProvider` (which is already at root level)

The current provider stack is: `BoardSessionBridge > ConnectionSettingsProvider > GraphQLQueueProvider > PartyProvider`. All new components go inside this stack. The `GlobalQueueControlBar` is an exception — it lives **outside** the board layout, directly inside the root `PersistentSessionProvider`, so it can appear on any page.

### Persistent Queue Control Bar Architecture

The QueueControlBar has **two rendering modes**:

1. **Board-route mode** (existing, enhanced): Rendered by `[angle]/layout.tsx` inside the full provider stack. Has access to `QueueContext` with all mutation capabilities (add, remove, reorder, navigate). This is the fully interactive version.

2. **Global/off-route mode** (new): Rendered by `GlobalQueueControlBar` at the root layout level. Uses `PersistentSessionContext` for read-only queue data. Provides navigation back to the board route and basic controls (tick, queue drawer). When the user taps the bar, they're navigated back to the board route where the full QueueControlBar takes over.

**Why two instances instead of one?** The board-route QueueControlBar needs `QueueContext` which only exists within `GraphQLQueueProvider`. Moving `GraphQLQueueProvider` to the root would require it to always be connected, even when no board is selected. Keeping two instances — one board-scoped with full capabilities, one global with read-only persistent data — is simpler and avoids unnecessary WebSocket connections.

**Visibility coordination**: The `GlobalQueueControlBar` uses `useIsOnBoardRoute()` (already exists in `persistent-session-context.tsx`) to detect when it should hide. The board layout's own QueueControlBar renders as normal. There's no overlap.

### Existing Swipe Pattern Variants

The codebase has three distinct swipe implementations that will be consolidated:

1. **`queue-control-bar.tsx`** - Swipe left/right for prev/next climb. Uses `react-swipeable` with `preventScrollOnSwipe: true`. Reveals FastBackward/FastForward icons behind a translating bar. `SWIPE_THRESHOLD=100`. **Changing to**: Spotify card-swipe animation.

2. **`queue-list-item.tsx`** - Swipe left=delete, right=tick. Uses direction detection (`isHorizontalSwipe`) to avoid scroll conflicts. Has `preventScrollOnSwipe: false` and manual `preventDefault()`. `SWIPE_THRESHOLD=100`. **Keeping as-is** (list item reveal pattern, not card swipe).

3. **`play-view-client.tsx`** - Swipe left/right for prev/next. Shows static arrow indicators on swipe progress. `SWIPE_THRESHOLD=80`. **Changing to**: Spotify card-swipe animation. Arrow indicators removed.

After redesign:
- **Card swipe pattern** (Spotify-style): Used in PlayViewDrawer, PlayViewClient, QueueControlBar. Shared via `usePlayViewNavigation` hook.
- **Action reveal pattern**: Used in ClimbListItem (heart/queue), QueueListItem (tick/delete). Each implements locally but shares the same threshold constants and direction-detection logic.

### URL Strategy

The redesign adds a drawer-based play view and a new home route:

- `/home` - Home/dashboard placeholder (feature-flagged via `NEXT_PUBLIC_ENABLE_HOME_SCREEN`)
- `/list` - Climb list (unchanged)
- `/play/[uuid]` - Full play page (kept for desktop + direct links)
- `/view/[uuid]` - Climb details page (unchanged)
- `/create` - Climb creation (unchanged)
- `/playlists` - Playlists (unchanged)
- `#playing` hash - Transient state indicating play drawer is open (mobile only)

One new route (`/home`) is added. The play drawer is purely a client-side UI overlay.

### MoonBoard Considerations

Several features have MoonBoard-specific behavior:
- `boardDetails.board_name === 'moonboard'` checks exist in header.tsx
- MoonBoard doesn't support: playlists, hold classification, mirroring
- MoonBoard has its own renderer (`moonboard-renderer/`)
- The redesign should propagate these checks to new components:
  - CreateDrawer: hide "Create Playlist" for MoonBoard
  - ClimbListItem: hide mirror swipe/action for MoonBoard
  - PlayViewDrawer: hide mirror button for MoonBoard
  - Use `boardDetails.supportsMirroring` (existing boolean) rather than name checks where possible
