# React Performance Audit: Core Experience

Audit of queue control bar, climb list, and play view drawer — April 2026.

---

## 1. Queue Control Bar

### Unstable adapter context object

**File:** `packages/web/app/components/queue-control/queue-bridge-context.tsx:204-281`
**Status:** Fixed

The `usePersistentSessionQueueAdapter()` creates a context object with 20+ properties. Even though it's wrapped in `useMemo`, the dependency array includes derived values (`parsedParams`, `queue`, `currentClimbQueueItem`) that change frequently. Every change recreates the entire context object, causing all consumers to re-render.

**Fix applied:** Split the adapter's single `useMemo` into three: `actionsValue` (stable callbacks), `dataValue` (volatile state), and `contextValue` (combined for backward compat). `QueueBridgeProvider` now provides all three contexts (`QueueActionsContext`, `QueueDataContext`, `QueueContext`), matching `GraphQLQueueProvider`. Consumers using `useQueueActions()` now get a stable reference that doesn't change on queue/data updates.

### Overly broad context subscription

**File:** `packages/web/app/components/queue-control/queue-control-bar.tsx:96-111`
**Status:** Fixed

The bar calls `useQueueContext()` which subscribes to the combined context (data + actions). The codebase already has split hooks (`useQueueData()` + `useQueueActions()` in `QueueContext.tsx:467-489`), but the control bar doesn't use them. Any data change (connection state, suggested climbs, user list) triggers a full bar re-render even when only action callbacks are needed.

**Fix applied:** Migrated all 10 production consumers from `useQueueContext()` to the split `useQueueData()` + `useQueueActions()` hooks. Components that only need actions (stable callbacks) no longer re-render on data changes. Components that only need data don't subscribe to the actions context. Zero production `useQueueContext()` calls remain.

### Color mode coupling

**File:** `packages/web/app/components/queue-control/queue-control-bar.tsx:124-126`
**Status:** Open

`useColorMode()` subscribes to theme changes, causing the entire bar to re-render on dark/light toggle.

### URL callback instability

**File:** `packages/web/app/components/queue-control/queue-control-bar.tsx:137-184`
**Status:** Open

`buildClimbUrl` depends on `boardDetails` and `params` which may not be referentially stable across renders.

### Inline style recreation

**File:** `packages/web/app/components/queue-control/queue-control-bar.tsx:452-455`
**Status:** Open

Dynamic style objects created every render. Should be memoized or moved to CSS.

---

## 2. Climb List

### No list virtualization / native paint skipping

**Files:** `packages/web/app/components/board-page/climbs-list.tsx`
**Status:** Fixed

Both grid and list modes used `.map()` directly — all items rendered to DOM at once. With infinite scroll, lists can grow to 200+ items.

**Fix applied:** List mode now uses `useWindowVirtualizer` from `@tanstack/react-virtual` (`climbs-list.tsx:552-561`) — only items in the visible window plus an overscan buffer mount to the DOM. Grid mode keeps the older `content-visibility: auto` approach (CSS-only paint skipping) because grid items have a stable aspect ratio and benefit from native infinite-scroll feel.

**Overscan tuning:** Reduced from 25 → 10 (~1070px headroom) to cut first-paint mount count by ~40% on `/list` after a Chrome DevTools trace showed the previous value was driving 2 s of style recalc and 2.2 s of forced reflow on initial render. Pinned in `climbs-list-virtualization.test.tsx`.

### O(n^2) deduplication

**File:** `packages/web/app/components/board-page/board-page-climbs-list.tsx:54`
**Status:** Fixed

Used `findIndex` inside `filter` — quadratic complexity. Replaced with a `Set`-based O(n) approach.

### Shared drawer state causes full list re-renders

**Files:** `packages/web/app/components/board-page/climbs-list.tsx`, `liked-climbs-list.tsx`
**Status:** Fixed

`activeDrawerClimb` and `drawerMode` state lived in the list parent. Opening/closing any item's action drawer re-rendered the entire list (200+ items). Extracted drawers into a separate `SharedDrawers` component with an imperative handle (`useImperativeHandle`). Drawer state now lives in the sibling component, so open/close never triggers a list re-render.

### Handler map recreation

**File:** `packages/web/app/components/board-page/climbs-list.tsx:197-203`
**Status:** Analyzed — low impact

Creates a new `Map` of click handlers for every climb on each `climbs` change (100+ closures). However, `ClimbListItem`'s custom memo comparator (line 560-578) does not check `onSelect`, and uses a ref pattern for callbacks. The map changing doesn't actually cause child re-renders. Cost is O(n) closure allocation only — not a bottleneck.

### Canvas thumbnails for most items

**Files:** `packages/web/app/components/climb-card/climb-thumbnail.tsx`, `climbs-list.tsx:377,402`
**Status:** Open

Only first N items use image layers; the rest use expensive canvas rendering. With `content-visibility: auto`, off-screen canvas items are now skipped by the browser, which mitigates the impact. Further optimization: consider lazy-loading canvas renderers only when items enter the viewport.

### ClimbsList component not memoized

**File:** `packages/web/app/components/board-page/climbs-list.tsx`
**Status:** Open

The `ClimbsList` component itself is not wrapped in `React.memo`. Parent re-renders cascade through to all children. The `content-visibility` CSS fix mitigates the DOM cost, but React still reconciles the full VDOM.

---

## 3. Play View Drawer

### keepMounted with heavy children

**File:** `packages/web/app/components/play-view/play-view-drawer.tsx:273`
**Status:** Fixed

The main drawer uses `keepMounted={true}`, meaning `SwipeBoardCarousel` (canvas rendering), `ClimbDetailShellClient`, and API queries (beta videos, logbook) all run continuously even when the drawer is closed.

**Fix applied:** Gated all heavy content (`PlayDrawerContent`, `SwipeBoardCarousel`, child drawers) on `isOpen`. When the drawer is closed, the shell stays mounted for smooth animations but no expensive children render. Canvas rendering, API queries, and section builds are fully stopped when the drawer is not visible.

### PlayDrawerContent not memoized

**File:** `packages/web/app/components/play-view/play-view-drawer.tsx:55-66`
**Status:** Fixed

Called on every render without `React.memo`. `useBuildClimbDetailSections` re-evaluates unconditionally, triggering section queries and CollapsibleSection rebuilds.

**Fix applied:** Wrapped `PlayDrawerContent` in `React.memo`. Now only re-renders when its own props (`climb`, `boardType`, `angle`, `aboveFold`) change.

### SwipeBoardCarousel receives fresh callback props

**File:** `packages/web/app/components/play-view/play-view-drawer.tsx:302-318`
**Status:** Fixed

Not wrapped in `React.memo`. Receives callback props (`onSwipeNext`, `onDoubleTap`) that are new references on parent re-render, potentially causing canvas re-initialization.

**Fix applied:** Wrapped `SwipeBoardCarousel` in `React.memo`. Combined with `useCallback`-wrapped handlers in the parent, the carousel now skips re-renders when only unrelated parent state changes.

### Queue drawer height state cascade

**File:** `packages/web/app/components/play-view/play-view-drawer.tsx:90,183-194,501`
**Status:** Fixed

`queueDrawerHeight` state updates during drag gestures trigger parent re-renders, which cascade to the canvas renderer. Should use a ref + CSS variable instead of state.

**Fix applied:** Replaced `queueDrawerHeight` state with a ref (`queueDrawerHeightRef`) and direct DOM manipulation via a `paperRef` on the queue `SwipeableDrawer`. The `updateQueueDrawerHeight` helper writes to both the ref and the Paper element's inline `style.height`, bypassing React reconciliation entirely. Drag gestures no longer trigger re-renders of `PlayViewDrawer`, `SwipeBoardCarousel`, or `PlayDrawerContent`. The queue drawer's `styles` object was also extracted to a module-level constant (`QUEUE_DRAWER_STYLES`) to prevent object recreation on every render.

### Beta API queries fire unconditionally

**File:** `packages/web/app/components/play-view/play-view-beta-slider.tsx:36-45`
**Status:** Open

No visibility gating — queries run even when the section is collapsed or the drawer is closed.

### Logbook filtering not memoized

**File:** `packages/web/app/components/play-view/play-view-comments.tsx:24-26`
**Status:** Fixed

Refilters and resorts the logbook array on every parent re-render.

**Fix applied:** Wrapped in `useMemo` with `[logbook, climbUuid]` dependencies.

### Unused dynamic import

**File:** `packages/web/app/components/play-view/play-view-drawer.tsx:20`
**Status:** Fixed

`import dynamic from 'next/dynamic'` was imported but never used.

**Fix applied:** Removed the unused import.

---

## Priority Summary

| Priority | Issue                                     | Component         | Status    |
| -------- | ----------------------------------------- | ----------------- | --------- |
| P0       | CSS content-visibility for paint skipping | Climb List        | **Fixed** |
| P0       | keepMounted with canvas                   | Play View Drawer  | **Fixed** |
| P0       | Unstable bridge context                   | Queue Control Bar | **Fixed** |
| P1       | Combined context subscription             | Queue Control Bar | **Fixed** |
| P1       | Shared drawer state re-renders            | Climb List        | **Fixed** |
| P1       | O(n^2) dedup filter                       | Climb List        | **Fixed** |
| P1       | Unmemoized PlayDrawerContent              | Play View Drawer  | **Fixed** |
| P2       | Queue height via state                    | Play View Drawer  | **Fixed** |
| P2       | Canvas thumbnails for all items           | Climb List        | Mitigated |
| P2       | Beta API queries unconditional            | Play View Drawer  | Open      |
| P2       | Logbook filtering no memo                 | Play View Drawer  | **Fixed** |
| P3       | Color mode coupling                       | Queue Control Bar | Open      |
| P3       | Inline style recreation                   | Queue Control Bar | Open      |
| P3       | Unused dynamic import                     | Play View Drawer  | **Fixed** |
