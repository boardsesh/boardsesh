# React Native Performance Playbook: Mobile App

Best practices and enforcement for `packages/mobile`. This is the mobile counterpart to
`docs/react-performance-audit.md` (web). The web audit catalogues _specific fixes_; this doc
states the _rules_ — each with the rule, why it matters on a phone, and a real example already
living in this codebase to copy from.

The expensive surfaces on mobile are the same three as web — the climb list, the play-view
drawer, and the queue — but the cost model is different. There is no browser to skip paints for
us: every unnecessary re-render runs on the JS thread, competes with gesture/animation worklets on
the UI thread, and shows up as dropped frames on a mid-range Android device, not as a profiler
squiggle. The bar is "60fps while scrolling the climbs list and swiping the play drawer on a
large-logbook account," and the evidence for clearing it is a before/after recording.

---

## 1. Provider context values: memoize, and split state from actions

**Rule:** Any context that many screens subscribe to must provide a `useMemo`'d value object.
When the provider holds both frequently-replaced state (a logbook array, reducer state, a roster)
**and** the stable callbacks consumers depend on, split them into separate contexts so a callback-only
consumer never re-renders when the data churns.

**Why:** An inline `value={{ ... }}` allocates a new object every render, so every `useContext`
consumer re-renders every time the provider does — regardless of `React.memo`. On mobile that
cascade lands on the JS thread mid-scroll. Bundling a volatile array with the callbacks is the
same trap one level up: a logbook merge while the user scrolls re-renders every component that only
wanted `saveTick`.

**Lint config:** `react/jsx-no-constructed-context-values` is configured as `error` for
`packages/mobile/**` and `packages/shared/**` (in both `.oxlintrc.json` and the `vite.config.ts`
`lint` block), with a repo-wide `warn`. It flags the inline `<Ctx.Provider value={{ ... }}>`
anti-pattern. Caveat: vite-plus's bundled linter does not currently _execute_ this off-by-default
`react/*` rule — it shows in `vp lint --rules` but never fires — so today the rule enforces at
editor / raw-oxlint time and as a forward-looking guard, not in `vp lint` / CI. Until vite-plus
runs it, this one is a **review-checklist item** (see CLAUDE.md → Mobile performance checklist), not
an automated gate.

**Examples in this repo:**

- `packages/shared/board-react/src/board-provider.tsx` — the `value` is `useMemo`'d over
  `[boardName, isAuthenticated, …, logbook, logbookByClimbAngle, getLogbook, saveTick, …]`. The
  mutation callbacks (`saveTick`/`saveClimb`/`updateClimb`) are kept stable via the
  ref-updated-in-`useEffect` + empty-dep-`useCallback` pattern (lines 90–116), so a React Query
  `mutateAsync` reference change does not churn the context.
- `packages/mobile/src/providers/queue-provider.tsx` — splits into **two** contexts:
  `QueueContext` (full state + actions) and `QueueSessionControlContext` (just the wall-control
  state + callbacks). A component that only drives take/release control subscribes to the smaller
  context and skips the per-queue-update re-render. Both values are `useMemo`'d with explicit deps.
- `packages/mobile/src/providers/toast-provider.tsx` / `auth-provider.tsx` — the value is a
  `useMemo` over the single stable `showToast` / the auth callbacks. (Both previously used an inline
  `value={{ … }}`; this is exactly what the lint rule now blocks.)

**Anti-pattern:**

```tsx
// BAD: new object every render → every useToast() consumer re-renders.
<ToastContext.Provider value={{ showToast }}>

// GOOD: stable reference; only changes when showToast does (it never does).
const value = useMemo<ToastContextValue>(() => ({ showToast }), [showToast]);
<ToastContext.Provider value={value}>
```

---

## 2. Virtualize anything user-growable; cap any `loadMore` drain

**Rule:** A list backed by data the user can grow (search results, the logbook, a playlist) must be
virtualized — `FlashList` for full screens, `BottomSheetFlatList` inside a Gorhom sheet. Never
`.map()` a growable array inside a `ScrollView`. Any "fetch the next page until `hasMore` is false"
loop must be capped or have a written justification.

**Why:** `.map()` in a `ScrollView` mounts every row up front. The climbs search pages 30 at a time
with infinite scroll, so the list grows unbounded; mounting 200+ `ClimbListRow`s (each with its own
swipe gesture + thumbnail render) blows the frame budget on mount and holds the memory the whole
session. Virtualization keeps the mounted set to the viewport plus an overscan window. An
unbounded drain-until-`hasMore` loop quietly fetches and mounts the entire catalog.

**Examples in this repo:**

- `packages/mobile/app/(tabs)/climbs/index.tsx` — `FlashList` with `onEndReached` +
  `onEndReachedThreshold={0.5}`. Crucially, `handleEndReached` (lines 488–495) is gated on
  `hasNextPage && !isClimbsLoading && !isFetchingNextPage && !isRefetching && !isLoadingMoreRef.current`
  — it fetches exactly one page per end-reached and the `isLoadingMoreRef` latch prevents a
  re-entrant drain. There is no "loop until hasMore" anywhere.
- `packages/mobile/src/components/play-drawer/BetaVideosSection.tsx` and queue lists use the Gorhom
  `BottomSheetFlatList` so the virtualization cooperates with the sheet's scroll gesture.

**Anti-pattern:** `{items.map((item) => <Row key={item.id} item={item} />)}` inside a
`<ScrollView>` for anything that isn't a fixed, small, known-length list. A fixed footer of 6
skeleton rows is fine; a search result set is not.

---

## 3. `React.memo` rows; `renderItem` deps with no `.length`, no inline closures

**Rule:** The row component a list renders is wrapped in `React.memo`. The `renderItem` passed to
the list is a `useCallback` whose dependency array contains **no array `.length`** and **no inline
closures created in render**. Hoist `keyExtractor` to module scope.

**Why:** FlashList recycles row instances; an unmemoized row re-renders on every recycle even when
its climb is unchanged. A `renderItem` that depends on `climbs.length` (or any value that changes
every page) gets a new identity every fetch, which defeats FlashList's recycling and re-renders the
whole visible window. Inline closures (`onPress={() => …}`) passed to a memoized row break its
`React.memo` by handing it a fresh prop each render.

**Good template — `packages/mobile/app/(tabs)/climbs/index.tsx`:**

- `keyExtractor` is a module-scope function (line 893), not an inline `(item) => item.uuid`.
- `renderClimbItem` is a `useCallback` (lines 699–727) whose deps are the board identity tuple plus
  the **stable** `handleClimbPress` / `openClimbActions` / `handleAddToQueue` callbacks and the
  scalar `activeClimbUuid`. No `visibleClimbs.length`, no inline arrows.
- The handlers it closes over (`handleClimbPress`, `handleAddToQueue`) are themselves `useCallback`s.
- `ClimbListRow` (`packages/mobile/src/components/ClimbListRow.tsx`) is `React.memo`'d and keeps its
  own gesture callbacks stable by reading the latest props through refs
  (`onPressRef.current = onPress`), so a parent re-render never recomposes its RNGH gestures.

**Anti-pattern:**

```tsx
// BAD: deps include .length → new renderItem every page → recycling defeated.
const renderItem = useCallback(({ item }) => <Row item={item} onTap={() => open(item)} />, [climbs.length]);
```

---

## 4. Per-row hooks do O(1) lookups, never O(N) scans

**Rule:** A hook called once per visible row must not scan an accumulating array. Read from a
pre-built index (a `Map`) keyed by the row's identity.

**Why:** A per-row `logbook.filter(...)` turns the climbs list into O(rows × logbook): every time a
scrolled page merges fresh ticks into a new `logbook` array, every visible row re-scans the whole
logbook. On a large-logbook account that is the single biggest scroll stall, and it gets worse as
the user logs more climbs — exactly the users we least want to punish.

**Example in this repo:**

- `packages/shared/board-react/src/board-provider.tsx` builds `logbookByClimbAngle` — a
  `Map<\`${climb_uuid}:${angle}\`, LogbookEntry[]>` — once per logbook change (lines 71–83).
- `packages/mobile/src/hooks/use-ascent-status.ts` reads it: `board.logbookByClimbAngle.get(key)`
  is one map lookup over that row's handful of ticks, then a `useMemo` over `[entries, isMirror]`.
  The whole climbs list dropped from O(rows × logbook) to O(rows) per merge.

**Anti-pattern:** `const ticks = logbook.filter((e) => e.climb_uuid === climbUuid && e.angle === angle)`
inside a hook that every row calls.

---

## 5. Worklet gestures: gate `runOnJS(setState)`, mirror read JS values into shared values

**Rule:** A gesture worklet must not `runOnJS(setState)` on every frame — gate the cross-thread hop
on a value _change_ (a boolean edge, a threshold crossing). JS values the worklet reads (flags like
`enabled`, `reduceMotion`) must be **mirrored into shared values** via a `useEffect`, not listed in
the gesture `useMemo`'s dependency array.

**Why:** `onUpdate`/`onTouchesMove` fire ~60×/sec on the UI thread. A `runOnJS` per frame floods
the JS thread with hops and serializes a UI-thread gesture behind JS-thread work — the exact stutter
virtualization is meant to avoid. And rebuilding the gesture (`Gesture.Pan()`) mid-interaction
because a dep flipped leaves React Native Gesture Handler stuck on iOS — the swipe just dies. The
fix is to keep the gesture object referentially stable and feed it live values through shared values
it can read on the UI thread.

**Example in this repo — `packages/mobile/src/components/play-drawer/use-carousel-gesture.ts`:**

- `enabled` and `reduceMotion` are mirrored into `enabledSV` / `reduceMotionSV` shared values via
  `useEffect` (lines 44–56). The gesture `useMemo` reads `enabledSV.value` / `reduceMotionSV.value`
  inside the worklet and does **not** list `enabled`/`reduceMotion` in its deps, so flipping either
  flag never recomposes the gesture.
- The haptic `runOnJS(triggerHaptic)()` (line 170) fires once per drag — gated behind
  `!hasTriggeredHaptic.value`, a shared-value latch flipped on the threshold crossing — not on every
  `onUpdate` frame.
- `packages/mobile/src/components/ClimbListRow.tsx` follows the same pattern: the swipe-commit
  haptic is gated by `useAnimatedReaction` on the `>= COMMIT_THRESHOLD` boolean edge (lines 39–43),
  so `runOnJS(hapticLight)` fires once per arm, not per frame.

**Anti-pattern:**

```ts
// BAD: a JS hop every frame, and `enabled` in deps rebuilds the gesture mid-swipe.
const gesture = useMemo(
  () =>
    Gesture.Pan().onUpdate((e) => {
      'worklet';
      runOnJS(setOffset)(e.translationX); // floods JS thread
    }),
  [enabled],
); // rebuild mid-gesture → RNGH stuck on iOS
```

**Composing a pan overlay with per-element taps —
`packages/mobile/src/components/create-climb/use-zoomed-hold-tap-gesture.ts`:**
When a zoomed board mounts an `absoluteFill` pan overlay above tappable elements, the overlay
swallows their touches (RNGH only offers a touch to the hit view + ancestors), so the overlay's
gesture must resolve taps itself. Two non-obvious choices there:

- **`Gesture.Race(pan, longPress, tap)`, not `Exclusive`.** `Exclusive` puts later gestures in a
  `waitFor` on the pan, and a `Pan` only _fails_ on touch-up — so a `LongPress` could never activate
  mid-hold (the role sheet would never open while held). With `Race`, the first gesture to activate
  wins; gate the pan behind an `activeOffset` (8px here) so a stationary touch goes to tap/long-press
  and only a real drag activates the pan. `activeOffsetX`/`activeOffsetY` are **OR'd** (crossing
  either axis activates), so single-axis drags pan fine.
- **Built once, reads everything live.** The composed gesture's `useMemo` deps are only stable
  shared values + the pan; render-scoped values (the hit-target list, the JS callbacks) are read
  through a `useRef` (same `callbacksRef` pattern as rule 5), so it never recomposes mid-session.
  The screen→board inverse transform runs in the worklet off `scaleSV`/`translateXSV`/`translateYSV`
  (mirrored container size for the center origin), then `runOnJS` resolves the nearest element once.

---

## 6. Warm board-art surfaces use the rasterized native-PNG path, not remote SVG

**Rule:** Any board-art surface that appears while scrolling, swiping, or inside always-mounted
chrome (the list thumbnail, the play-drawer board, the accessory bar) renders through the native-PNG
path: `useNativeClimbRender` + `LayeredClimbImage` with `cachePolicy="memory-disk"` on bundled
assets. Do not render mobile board backgrounds through `react-native-svg` `<Image href>` or any
remote URL.

**Why:** The removed SVG background renderer parsed the frames string, built an SVG hold overlay,
and painted N `<Circle>`s in `react-native-svg` on every render, on top of a remote image fetch for
board art that should be on disk. The native path renders the holds once into a cached PNG (deduped
by cache key, warmed from disk on launch — see the `renderedOverlays` map and
`warmupRenderedOverlaysOnce` in `use-native-climb-render.ts`) and stacks
it over bundled background images via `expo-image` with `cachePolicy="memory-disk"`, so a scrolled-
past climb is an instant cache hit with zero network and zero per-row SVG work. It also satisfies
the no-network offline rule — missing layers render as visible gray blocks rather than silently
fetching.

**Cache key shape (`buildCacheKey` in `use-native-climb-render.ts`):**
`v<RENDERER_VERSION>_<style>_w<width>_<board>_<layout>_<size>_<setIds>_<framesHash>`. Each token is
a collision-prevention contract — two climbs that share every token reuse one PNG, so a token must
exist for every input that changes the rendered pixels:

- `style`: `s` (stroke-only, the full-size play view) vs `f` (filled dots, the list/accessory
  thumbnail). Same climb, different hold styling.
- `width`: `full` (native board width, ~1080px — the play view) vs `<n>` (e.g. `400` — the
  list/accessory, which pass `renderWidth` so the Rust renderer rasterizes a small PNG instead of
  downscaling a large one on the main thread). Without this token the small and full overlays would
  collide and one would be reused at the wrong resolution. The token tracks the _requested_ width,
  not the clamped output, so it's stable per `(board, renderWidth)`.

The list thumbnail and the accessory thumbnail deliberately use the **same** `style` + `width`
tokens (`_f_` + `_w400_`) so a climb seen in the list is an instant cache hit in the accessory bar.
The matching `buildBoardKey` (which guards background-path state across FlashList row recycling)
carries a `full`/`thumb` variant token for the same reason — a recycled row must re-resolve, not
surface the previous size's bundled background paths.

**Examples in this repo:**

- Warm path (use this): `packages/mobile/src/hooks/use-native-climb-render.ts` +
  `packages/mobile/src/components/LayeredClimbImage.tsx` (`cachePolicy="memory-disk"`), wired up in
  `packages/mobile/src/components/ClimbListThumbnail.tsx` and `BoardImageNative.tsx`.
- Static diagrams should still avoid network board art. Use bundled background paths through
  `background-image-cache.ts` or draw diagram-only shapes; the old `react-native-svg` background
  renderer was removed because it accepted remote `<SvgImage href>` board-art URLs.

---

## 7. Board-art image memory: render at display size, recycle, release on background

**Rule:** Board-art surfaces are the app's largest memory consumer (decoded bitmaps live in the
Android native heap + as GPU textures, not the JS heap). Three contracts keep them in check:

- **Size the overlay to the display, keep the photo full-res.** The play-drawer board passes
  `renderWidth` (display px × `PixelRatio.get()`) so the per-climb holds overlay rasterizes at the
  shown size instead of the board's native ~1080px, plus `backgroundVariant="full"` so the *shared*
  board photo (one decode per board-config, reused across every climb) stays crisp. `renderWidth`
  alone would downgrade the photo to the 416px `thumb` — only the overlay should shrink.
- **`recyclingKey` on always-mounted board surfaces that swap climbs.** The carousel boards key on the
  climb's `frames` so swapping releases the previous overlay instead of holding both.
- **Release board-art on background.** `LayeredClimbImage` blanks its `<Image>` layers when
  `useIsAppBackgrounded()` is true, and `useImageCacheMemoryManagement` (mounted at the app root)
  sweeps expo-image's memory cache on background / `memoryWarning`. Re-decodes from disk on
  foreground (no network).

**Why:** On-device profiling (Pixel 8 Pro, Android 16) showed ~248 MB native heap idle on the feed
and the play-drawer carousel piling a native-res (~7 MB RGBA) overlay per swiped climb into the
cache. Display-sizing + recycling cut carousel browse-growth ~19%; background-blanking cut the
worst case (board left open on app-switch) ~96 MB. **Ceiling:** expo-image on Android is Glide,
whose cache/pool are sized to device RAM and resist JS `clearMemoryCache()` (the native allocator
retains freed pages), so the common feed-backgrounded footprint is unmoved by JS — the next lever is
native (`onTrimMemory(UI_HIDDEN) → Glide.clearMemory()`). The high MB on a 12 GB device overstates
real risk; Glide auto-sizes far smaller on 4–6 GB phones.

**Examples in this repo:**

- `packages/mobile/src/lib/app-visibility.ts` (`useIsAppBackgrounded`, one ref-counted AppState
  listener) + `packages/mobile/src/hooks/use-image-cache-memory-management.ts` (root cache sweep).
- `renderWidth` + `backgroundVariant` threaded through `BoardImageNative.tsx` →
  `use-native-climb-render.ts`; applied in `play-drawer/SwipeBoardCarousel.tsx`.

---

## Profiling workflow

Required evidence for any list / provider / theme PR: a **before/after recording on the climbs list
and the play drawer**, captured on a large-logbook account. A claim of "this is faster" without a
recording does not clear review.

1. **React DevTools Profiler — "Highlight updates when components render."** Turn it on, then scroll
   the climbs list and navigate the queue / play drawer. Every row that flashes on an unrelated
   state change is a missing `React.memo`, an unstable `renderItem` dep, or an unmemoized context
   value. The goal: scrolling highlights only newly-mounted rows; toggling the active climb
   highlights only the previously- and newly-selected rows, not the whole list; opening a toast
   highlights nothing in the list.
2. **Hermes sampling profiler with a large-logbook account.** Sign in as a user with a deep logbook
   (the O(N)-scan bugs are invisible on a fresh account). Record a profile while scrolling and while
   swiping the play-drawer carousel. Look for per-row `logbook.filter`, per-frame `runOnJS` hops, and
   repeated `BoardRenderer`/SVG work — these dominate the flame graph exactly on the accounts we care
   about.
3. **Frame timing.** Watch the perf monitor (JS + UI FPS) on a mid-range device, not just the
   simulator. UI-thread drops point at gesture/worklet issues (rule 5); JS-thread drops point at
   re-render cascades (rules 1, 3, 4) or per-row work (rule 4, 6).

When in doubt, copy the structure of `app/(tabs)/climbs/index.tsx` — it is the worked example for
rules 2, 3, and 4, and the surface every list/provider PR is measured against.
