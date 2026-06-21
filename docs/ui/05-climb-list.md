## Climb List

### Board Page Climb List

**Web component:** `packages/web/app/components/board-page/climbs-list.tsx`

**Web route:** `/b/{board_slug}/{angle}/list` or `/{board_name}/{layout_id}/{size_id}/{set_ids}/{angle}/list`

**Mobile status:** Stack screen within board tab

**Layout:** Vertical scrollable list. Header row with search pills + view toggle + angle selector. Main content area with climbs. Bottom tab bar with spacer.

**Header row:**

- **Left (flex: 1, overflow hidden):** Search summary pills (horizontal scroll, `headerInline` prop) -- chips showing active filter descriptions. Each chip is removable.
- **Right (flex-shrink: 0):**
  - View mode toggle: two `IconButton`s side by side (gap 2px)
    - List icon (`FormatListBulletedOutlined`) -- opacity 1 when active, 0.4 when inactive
    - Grid icon (`AppsOutlined`) -- opacity 1 when active, 0.4 when inactive
    - ID attributes for onboarding: `onboarding-view-mode-list`, `onboarding-view-mode-grid`
  - Angle selector component (right of view toggle)
- Min height: 40px, padding: `8px 12px`

**View modes:**

#### List Mode (default, persisted to IndexedDB as `climbListViewMode`)

- **Virtualized:** Uses `@tanstack/react-virtual` `useWindowVirtualizer`
  - `estimateSize: () => 107` (107px per item)
  - `overscan: 10` (10 items rendered above/below viewport)
  - `initialRect: { width: 375, height: 812 }` (for SSR)
  - Absolute positioned items with `transform: translateY(${start}px)`
  - `contain: 'layout style paint'` for rendering optimization
- **Infinite scroll:** Triggered when last virtual item index >= `visibleClimbs.length - 5`
- **Item component:** `ClimbListItem` (see below)
- **Swipe hint:** `SwipeHintOrchestrator` renders after list items

#### Grid Mode

- **Layout:** Flexbox wrap, `gap: themeTokens.spacing[4]` (16px)
- **Item width:** `xs: 100%`, `lg: calc(50% - 8px)` (two columns on large screens)
- **Item component:** `ClimbCard` (see below)
- **Infinite scroll:** Intersection Observer sentinel at bottom of list
- **Not virtualized** (all visible items rendered)

**Loading states:**

- Initial load: 10 skeleton items matching the active view mode
- Load more: additional skeletons appended below existing items
- End of results: centered text "No more climbs" (when `!hasMore && climbs.length > 0`)

**Batched rendering:** When search results are replaced (not appended), only the first 6 items render synchronously. The rest render on the next animation frame. The window scrolls to top with `behavior: 'instant'`.

**Data sources:**

- `searchClimbs` GraphQL query with pagination (`page`, `pageSize`)
- `useUISearchParams()` for filter state (synced to URL query params)
- `useInfiniteScroll()` hook for grid mode sentinel
- `getPreference('climbListViewMode')` / `setPreference()` for view mode persistence

### Climb List Item (List Mode)

**Web component:** `packages/web/app/components/climb-card/climb-list-item.tsx`

**Layout:** Horizontal flex row, padding `8px 8px`, gap `12px`, border-bottom `1px solid var(--border-subtle)`, cursor pointer.

- **Left (64px width, flex-shrink 0):** Thumbnail with ascent status badge
  - `ClimbThumbnail` -- SVG-rendered board with highlighted holds
  - `HeartAnimationOverlay` -- heart animation on double-tap favorite (size 32px)
  - `AscentStatus` badge -- positioned absolute on thumbnail corner. Three states: lightning bolt on amber (flash), checkmark on green (sent), X on orange (attempted), or nothing. Priority: flash > send > attempt. The badge does not live on the climb row — it reads from the user's logbook (separately-fetched user ticks), filtered by `climbUuid` + active angle, so the `searchClimbs` payload stays denormalised and CDN-cacheable.
  - Double-tap on thumbnail: toggles favorite via `useDoubleTapFavorite`

- **Center (flex: 1, min-width 0):** `ClimbTitle` component
  - Grade (colored, right-positioned via `gradePosition: 'right'`)
  - Climb name (truncated with ellipsis, font size `themeTokens.typography.fontSize.xl`)
  - Setter info shown
  - Favorite star indicator
  - "No match" indicator if applicable

- **Right (flex-shrink 0):** Menu button (`MoreHorizOutlined`, neutral-400 color, disableRipple)

**Swipe gestures (via `useSwipeActions` hook):**

- **Swipe left (reveals right action):**
  - Default: Add to queue. Green background (`themeTokens.colors.success`). Shows `AddOutlined` icon, crossfades to `CheckOutlined` on confirmation.
  - Action width: 100px (default) or 120px (override)
  - Threshold: 60px to trigger
  - Override: can be replaced with tick action (in queue drawer)

- **Swipe right (reveals left action):**
  - Short swipe (60px threshold, 120px reveal): Primary color background. Shows `LocalOfferOutlined` icon. Opens playlist selector drawer.
  - Long swipe (150px threshold, 180px reveal max): Neutral-600 background. Shows `MoreHorizOutlined` icon. Opens full actions drawer.
  - Transition between short/long: opacity crossfade starts at 115px

- **Swipe animation:** Direct DOM manipulation (zero React re-renders during gesture). Opacity controlled via refs to inner layer elements.

**Selected state:** Background color changes to grade-tinted color (`getGradeTintColor(difficulty, 'light', isDark)`) or `var(--semantic-selected)` fallback.

**Unsupported/bigger-board state:** `opacity: 0.5`, `filter: 'grayscale(80%)'`. Tap is intercepted, shows warning snackbar.

**Drawers (per-item, rendered only when no parent drawer callbacks):**

- Actions drawer: `ClimbActionsDrawer` at 60% height with drag-to-resize
- Playlist selector drawer: `SwipeableDrawer` with `PlaylistSelectionContent`, max-height 70vh
- Queue drawer: `QueueDrawer` for viewing current queue

**Mobile adaptation notes:**

- Use `react-native-gesture-handler` `Swipeable` for swipe actions
- Or implement with `PanGestureHandler` + `react-native-reanimated` for custom gesture physics
- `FlashList` replaces virtualized list with `estimatedItemSize={107}`
- Thumbnail: pre-rendered image or `react-native-svg` inline
- Haptic feedback on swipe threshold crossing via `expo-haptics`
- The mobile `ClimbListRow` (`packages/mobile/src/components/ClimbListRow.tsx`) renders the shared `ClimbListItemContent`, which shows the user's ascent status as a monochrome glyph next to the grade (⚡ flash / ✓ sent / ✗ attempted — `ASCENT_STATUS_ICON`, tinted `secondaryLabel` so it never competes with the colour-coded grade), plus intrinsic-attribute glyphs inline after the name (© benchmark/classic, ⊘ no-match — the shared `ClimbAttributeIcons`). Ascent status is fed by the shared `BoardProvider` (`@boardsesh/board-react`): the climb-list screen calls `useBoardProvider().getLogbook(visibleUuids)` to incrementally fetch ticks for the climbs on screen via `GET_TICKS`, and `useAscentStatus` reads from `BoardProvider.logbook` filtered by climbUuid + active angle. The search query itself stays anonymous so it can be cached.
- Ellipsis tap and long swipe-right open the shared `ClimbActionsSheet` mounted in `DrawerHostProvider`. Until a dedicated mobile playlist selector ships, the short swipe-right also opens the actions sheet rather than no-op'ing.

### Climb Card (Grid Mode)

**Web component:** `packages/web/app/components/climb-card/climb-card.tsx`

**Layout:** MUI `Card` with header, content, and actions sections.

- **Header (`CardHeader`):** `ClimbTitle` component (horizontal layout, shows setter info). Padding top 8px, bottom 10px.
- **Content (`CardContent`):** Board thumbnail cover (`ClimbCardCover`). Padding 10px. Background tints to grade color when selected. Heart animation overlay on double-tap.
- **Actions (`CardActions`):** Row of action icons (justify: space-around), top border `1px solid var(--neutral-200)`. Actions include: open/view, add to queue, favorite, share, etc. Rendered via `ClimbActions` component in `viewMode="icon"`.

**Unsupported state:** Wrapper div: `opacity: 0.5`, `filter: 'grayscale(80%)'`.

**Selected state:** Content background: grade tint color or `var(--semantic-selected-light)`.

**Mobile adaptation notes:**

- Custom card component with `react-native-reanimated` for press animations
- Grid layout via `FlashList` with `numColumns={1}` (phone) or `numColumns={2}` (tablet)

### Search Drawer (Filters)

**Web component:** `packages/web/app/components/search-drawer/unified-search-drawer.tsx` and `accordion-search-form.tsx`

**Layout:** Top-anchored `SwipeableDrawer`. Full height in climb mode, 80vh otherwise. Category pills at top.

**Category pills:** Horizontal chip row: Climbs (only when boardDetails available), Boards, Gyms, Users, Playlists. Active chip: filled + primary color. Inactive: outlined.

**Climb search form (`AccordionSearchForm`):** Collapsible accordion sections:

1. **Climb section:**
   - Name input (`SearchClimbNameInput`)
   - Grade range picker (`GradeRangePicker`) -- chip-based grade selection
   - Tall/Wide climbs filter (Kilter Homewall only) -- switches
   - Setter name select (`SetterNameSelect`) -- autocomplete

2. **Quality section:**
   - Min rating picker (star rating)
   - Min ascents bucket picker (filters by number of logged ascents)

3. **Status section:**
   - Radio group: Any / Drafts / Established / Projects
   - "My sends only" filter (auth-gated)

4. **Holds section:**
   - Hold filter overlay on board renderer
   - Tap hold to set include/exclude filter per hold position
   - Hold type picker (include/exclude toggle + STARTING/HAND/FINISH/FOOT swatches)

5. **Zone section:**
   - Climb zone visualization on board

6. **Sort section:**
   - Sort select: Relevance, Date, Difficulty ascending, Difficulty descending

**Search pills (above climb list):**

- Active filters shown as removable chips in horizontal scroll
- "Clear all" button when multiple filters active
- Each pill shows filter summary (e.g., "V3--V7", "4+ stars", setter name)

**Data sources:**

- `useUISearchParams()` -- URL-synced search parameters
- `getGradesForBoard()` -- grade list for current board
- `useBoardProvider()` -- auth state for conditional filters

---
