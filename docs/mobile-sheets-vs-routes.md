# Mobile: sheets vs. routes — which surface to use

Guidance for `packages/mobile`. Every secondary surface in the app is either a **bottom
sheet** or an **expo-router route**. This doc is the decision tree for picking one, plus the
hard rules that explain _why_ — most of them learned the expensive way (see the scars at the
bottom). When you add a new drawer, picker, menu, or full-screen flow, start here.

## The one-line rule

> **Default to a bottom sheet. Reach for a route only when the surface is a _destination_,
> must _cover the tab bar_, must _host its own sub-sheets_, or needs _board gestures_.**

Most things are sheets. Routes are the exception, and each route variant earns its place.

## The two families

### Bottom sheets (`@expo/ui/community/bottom-sheet`)

Wrapped by two helpers so they don't drift (both supply the scrim, drag handle, and iOS 26 glass
background natively, plus JS-side keyboard avoidance for the `footer` slot — the Android Compose
dialog window does **not** resize for the keyboard, so the wrappers pad on both platforms):

| Wrapper                                            | Backing            | Opened by                                                                          | Use when                                                                                                                          |
| -------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **`ModalSheet`** (`src/components/ModalSheet.tsx`) | `BottomSheetModal` | imperatively via ref — `present()` / `dismiss()`, or the controlled `visible` prop | A button/handler opens it. Presents **above root chrome** (the queue bar / tab bar) for free. The default for an on-demand sheet. |
| **`Sheet`** (`src/components/Sheet.tsx`)           | `BottomSheet`      | declaratively — its presence in the tree shows it                                  | Its lifetime is tied to parent state.                                                                                             |

Examples: `QueueSheet`, `BoardSheet`, `LogAscentSheet`, `AngleSelectorSheet`,
`ClimbActionsSheet`, `AddBetaVideoSheet` (sheet surfaces), `CreateDrawer` + `HoldRoleSheet`
(declarative `Sheet`s).

**Expo web implementation exception.** App and shared code still import
`@expo/ui/community/bottom-sheet`, but Metro redirects that one module to
`src/web-shims/bottom-sheet.tsx` on web. Expo SDK 57's Vaul implementation renders a sheet,
but it is not compatible with the current interaction contract: gesture-lock props are no-ops,
configured detents cannot be dragged between, snap-point content gains a second scroll owner
around virtualized lists, keyboard behaviour props are no-ops, and there is no accurate
post-animation dismissal signal. The isolated web shim uses Gorhom until Expo's implementation
passes all of those gates. Keep Gorhom outside the native dependency graph because of the Android
freeze fixed in #3167. Web QA must cover a long queue, row reorder without sheet movement,
dragging between detents, note focus at a mobile viewport, and exactly-once dismissal. Soft-keyboard
behaviour remains a real-device browser check even though the adapter preserves Gorhom's input and
keyboard props.

Prefer the controlled `visible` prop over an imperative ref + a local `isPresentedRef`: the
coordinator reconciles present/dismiss from `visible`, and `onClose` fires only when the sheet is
genuinely going away out from under the parent — a user pan-down / backdrop, or a displacement by
another sheet in the group — never for a close the parent itself drove, so parent state can't be
cleared behind your back. `AddToPlaylistSheet` is the reference.

**Stacking above everything:** a **custom, non-sheet** overlay (Reanimated + plain views) can
render in a higher iOS window via react-native-screens' `FullWindowOverlay` — that's how
`ClimbReactionMenu` (the long-press context menu) floats above whatever's underneath. This does
**not** work for a native `@expo/ui` sheet: a SwiftUI `.sheet` presents off the **key window**
regardless of a `FullWindowOverlay` wrapper (the scar the player learned — see rule 1), so
wrapping a sheet in one pushes it _under_ the overlay window, not above. Sibling native sheets
instead stack via their own SwiftUI hosts — that's how `HoldRoleSheet` shows over the create
drawer (they're siblings in the create-climb route, not one nested in the other). There is **no**
`fullWindowOverlay` prop on `Sheet`; it was an inert no-op and has been removed.

**Inline body instead of a nested sheet:** when a surface needs a secondary picker/form but a
second native sheet can't stack (rule 1), extract the body as a **presentation-agnostic component**
that mounts no sheet/overlay of its own and takes its text input by injection, then render it inline
in both hosts. `InlinePlaylistPicker` (the "add to playlist" list + create form) is the reference:
it renders inline in `ClimbReactionMenu`'s `FullWindowOverlay` (plain `TextInput`) and inside
`AddToPlaylistSheet`'s `ModalSheet` (`BottomSheetTextInput`), so add-to-playlist never stacks a
second sheet. Feedback is inline, not a toast (a toast renders behind the overlay/sheet).

**In-tree opener override — a root menu opening a sheet over a route.** `ClimbReactionMenu` is a
`FullWindowOverlay` rendered at the **app root** (via `DrawerHostProvider`), but it floats over the
player route too. If one of its actions opens a sheet through a **root-level** opener
(`useDrawerHost().openAddBetaVideo` / `openLogAscent` → the sheets in `DrawerHostProvider`), that
sheet presents off the root and lands **under** the `/play` fullScreenModal — so from the player it
flashes open and vanishes (rule 1; #3505 was this, #3294 the playlist variant). The fix: when the
menu is opened **from the player**, thread the player's **own in-tree opener** through
`openClimbActions` → `ClimbReactionMenu` → `useClimbActions` (the `onAddBetaVideo` override, mirroring
`onEditEntry` / `onSelectPlaylist`), so the action drives `PlayDrawer`'s local `AddBetaVideoSheet`
(which presents inside the modal, above it) instead of the root one. Off the player (climb list,
logbook, board sheet) the override is omitted and the root sheet is correct — nothing covers it.
**Any new ellipsis action that opens a native sheet needs this override**, or it re-hits the bug.

**Every native sheet must go through the presentation coordinator.** `@expo/ui`
sheets all present off the **same** root-window view controller, and the library
does no serialization — overlapping a present with another sheet's dismiss
deadlocks UIKit and freezes the whole app (renders, but ignores every tap). The
`ModalSheet`/`Sheet` wrappers route through `SheetPresentationProvider`
(`src/providers/sheet-presentation-provider.tsx`) automatically. A surface with
custom chrome that renders the raw `BottomSheetModal`/`BottomSheet` directly must
drive present/dismiss with `useManagedSheet` (see `QueueSheet`, `BoardSheet`,
`LogAscentSheet`). The coordinator serializes transitions per **presenter group**
(default `'root'`) and auto-sequences a sheet-over-sheet open as
dismiss(A) → settle → present(B). **A displaced sheet is closed, not suspended**:
the coordinator clears its desired-open flag and fires `onDisplaced`, which
`useManagedSheet` delivers as the sheet's `onClose` (same contract as a user
pan-down), so the parent clears the state that drove `open`. Never design a flow
that expects a displaced sheet to come back by itself when the displacer closes —
that implicit resume was the phantom-tick-sheet bug (PR #3595). Two exceptions, both documented in-file:
`CreateDrawer` (a route-primary drawer that renders the raw `BottomSheet` without the
coordinator — it opens once as the create-climb route's primary sheet, and its only sub-sheet,
`HoldRoleSheet`, presents from its own sibling SwiftUI host, so the two never contend for the same
presenter) and the `FullWindowOverlay` menus (e.g. `ClimbReactionMenu`), which are custom overlays
in a higher window, not native sheets.

**How a dismiss "settles."** The coordinator needs to know when a dismiss animation has
really finished before it starts the next transition. On **iOS** that's the accurate native
signal: our `@expo/ui` patch (`patches/@expo%2Fui@57.0.11.patch` — the version is baked into the
filename, so it moves on every bump) forwards SwiftUI's
post-animation `.sheet(onDismiss:)` out of the community wrapper as `onFullyDismissed`, which
`useManagedSheet` routes into `coordinator.notifyFullyDismissed`. So a surface that renders the
raw `BottomSheetModal`/`BottomSheet` must pass `onFullyDismissed={managed.onFullyDismissed}` (the
`Sheet`/`ModalSheet` wrappers already do) — otherwise its handoffs fall back to the ceiling timer
and wait the full delay. A fixed per-platform timer (`IOS_SHEET_SETTLE_MS` / `ANDROID_SHEET_SETTLE_MS`)
is the fallback: it's the only settle signal on **Android** (Compose has no post-animation event),
and on iOS it's the ceiling for the rare case the native event never arrives (a Host torn down
mid-animation). A `__DEV__` warning fires only when the ceiling beats a native signal that was
expected (an iOS dismiss of a still-registered sheet).

Call `managed.dismissAndWait()` when the next step must not begin until that settle point. It
uses the coordinator's existing native-dismiss-or-ceiling lifecycle rather than starting a
second timer, and it also waits when `present()` is still in flight. Concurrent callers for the
same sheet share the outcome. The promise resolves with `{ status: 'dismissed' }` after a normal
settle (or the platform ceiling), and `{ status: 'aborted' }` if the sheet unregisters during the
handoff. Stop the follow-up action on `aborted`; the owning surface has gone away.

The same patch also guards the **Android** re-snap path: `snapToIndex` on an already-open
multi-detent sheet fires `expand()` / `partialExpand()` fire-and-forget on the native
`ModalBottomSheetView`. A store binary whose native `@expo/ui` predates one of those
AsyncFunctions rejects the call ("No handler registered for AsyncFunction …"), which — being
unawaited — surfaces as a crash-reported unhandled rejection (#3478). The patch attaches a
`.catch` so it no-ops on those binaries and never reaches a native build that has the method.
This is the OTA-ahead-of-native invariant in `docs/mobile-ota-updates.md`: OTA JS must not call
native `@expo/ui` methods newer than the min shipped binary without a guard.

**iOS sizing — the single-flex-child contract.** Hand the native `@expo/ui` sheet exactly ONE
flex child; multiple direct children make it size to content and collapse a `flex: 1` scroll body.
And on iOS the SwiftUI host can propose an **unbounded** height to that child, so a `flex: 1`
column sizes to its content instead of the detent and anything past the detent (a pinned footer)
lands off-screen (#3330). The `Sheet` / `ModalSheet` wrappers pin that single flex child to the
active detent's height on iOS via `useSheetColumnStyle` (`src/components/use-sheet-column-style.ts`);
Android bounds it natively and keeps `flex: 1`. A raw-`BottomSheet` surface with a pinned footer
(`ClimbFilterSheet`, `LogAscentSheet`) must apply the same hook itself.

**Android sizing — only two real states.** `@expo/ui`'s Android sheet is a plain Material 3
`ModalBottomSheet`: it never reads the requested `%` snap-point _values_, only the detent count
and which index is requested — it has a fixed ~50% "partial" state and a content-fitting
"expanded" state, nothing in between (see `androidSafeSnapPoints` in
`src/components/sheet-snap-points.ts`). A sheet whose detents are tuned against iOS's real first
fraction (e.g. `65%`/`80%`, sized so a pinned footer fits under the form) can be TALLER than
Android's ~50% partial state, stranding that footer below the fold (#4723). But its "expanded"
state only actually fits content when `@expo/ui`'s content-fitting path is on — `enableDynamicSizing`
with **no** snap points, so the shim sets `fitToContents` and hosts the RN tree in an
`RNHostView matchContents` that forces the Compose node to the RN child's measured height. A
single near-full detent (`['92%']`) does NOT take that path — the sheet fills the screen and a
short form floats in ~310 dp of void above the footer (#4720).

For a multi-detent form with a pinned footer, pass `androidContentSized` to `Sheet` / `ModalSheet`
(`LogAscentSheet` and `LogbookEditSheet` opt in). On Android it drops the `%` detents and takes
the content-fitting path; iOS / web keep the exact detents and the `useSheetColumnStyle` bound.
Two things make it safe for a scroll body — the case `androidSafeSnapPoints`'s old comment warned
content-fitting would collapse:

- The single flex child (the `KeyboardAvoidingView`) takes a **`maxHeight`** of
  `window − topInset − chrome`, not `flex: 1` — under a `matchContents` host a `flex: 1` child
  resolves to zero. At rest it measures to the form; a keyboard-up long note pushes it into the
  ceiling.
- The scroll body takes **`flexShrink: 1`**, not `flex: 1` — content height at rest (this is what
  closes the void), and it shrinks-and-scrolls once the column hits its ceiling so the footer
  stays pinned above the keyboard instead of the note clipping.

`skipPartiallyExpanded` still comes for free (the shim sets it whenever `fitToContents` or a
single detent), so the ~50% partial trap of #4723 stays closed — the sheet can only rest at its
one content-fitted state or Hidden, no imperative re-snap in the mix.

The bound isn't optional the moment a surface gains a scroll body: without it the scroll view
never gains an overflow, so nothing scrolls **and** the footer is off-screen. `LogAscentSheet`
went years on a plain `flex: 1` column safely — it had no scroll body and no pinned footer, so
neither failure mode had anything to bite. Adding either one makes the hook load-bearing. A sheet
with more than one detent should also pass `activeIndex` from the native `onChange`, so the bound
tracks the resting detent instead of leaving dead space under the footer at the taller one.

### Routes (`expo-router` `Stack.Screen`)

| `presentation`         | Looks like                                           | Use when                                                                                                                                 | Examples                                                                                                       |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| _(none — pushed)_      | Full-screen, slides in from the side, back-navigable | A deep destination, **or** a full-screen interactive board (pan/pinch) where a modal's pan would fight the gestures                      | session detail; `holds` / `zone` / `setters` filters                                                           |
| **`modal`**            | pageSheet card with a top gap, dimmed parent behind  | A self-contained flow launched from a tab; a card is fine                                                                                | `boards`, `share-beta`, `join`                                                                                 |
| **`transparentModal`** | Transparent — the live screen behind stays visible   | A drawer-as-route that should show the screen behind it, **or** a full-screen cover that must NOT disturb the screen behind (see rule 2) | `create-climb` (shows the climbs list, dimmed); the **player** (with an opaque backing to read as full-screen) |
| **`fullScreenModal`**  | Opaque full-screen cover                             | An immersive full-screen flow that is **not** presented over the iOS 26 native tab bar                                                   | `onboarding`                                                                                                   |

## The decision tree

```
Is it a secondary surface OVER the current screen, or its own full surface?

├─ Secondary surface ─────────────────────────► BOTTOM SHEET
│    ├─ Opened imperatively (button → present)?  → ModalSheet
│    ├─ Tied to parent state (declarative)?      → Sheet
│    └─ Must float above everything (CUSTOM overlay,   → FullWindowOverlay
│        not a native sheet)?                            (native sheets present off the key
│                                                         window — a wrapper can't lift them)
│
└─ Its own full surface ──────────────────────► ROUTE
     ├─ Deep destination (back / URL)?            → pushed route
     ├─ Full-screen interactive board (pan/pinch)?→ pushed route  (NOT a modal — rule 3)
     ├─ Self-contained card flow from a tab?      → modal (pageSheet)
     ├─ Drawer that shows the live screen behind? → transparentModal
     └─ Immersive cover hosting many sub-sheets?  → transparentModal + opaque backing
                                                    (NOT fullScreenModal over NativeTabs — rule 2)
```

## The four hard rules (the _why_)

1. **A bottom sheet can't host other native sheets stacking above it.** `@expo/ui` sheets
   present off the **main window's** view controller, not off the sheet. So the moment a
   surface needs several sub-sheets to stack _above_ it (the player opens beta / queue / share
   / angle / tick / climb-actions), it **must** be a route — a real modal view controller, off
   which those sub-sheets present and stack naturally. This is the single reason the player is
   a route and not a sheet. **If a sheet only needs to hand off to ONE sub-surface at a time**
   (not stack several), it can stay a sheet and instead **suspend → push a route → re-present**:
   set its controlled `open` to `false` (a coordinator self-dismiss, so it doesn't unmount and
   the draft survives), `router.push` the sub-route, and flip `open` back to `true` on a
   `useFocusEffect` when the screen re-focuses (covers Done _and_ swipe-back). The sub-route
   hands its result back through a tiny pub/sub handoff. This is how `ClimbFilterSheet` opens the
   `setters` / `holds` / `zone` filters.

2. **Never `fullScreenModal` over the iOS 26 `NativeTabs`.** A `fullScreenModal` snapshots the
   presenting tab view controller for its transition; the native bottom-accessory glass platter
   then lingers stacked under the live one (doubled climb name), and the alternative —
   unmounting the accessory — churns the native tab-bar height and shoves the docked Climbs
   search field. Use **`transparentModal` + an opaque backing** instead: the tabs screen stays
   live behind it (never snapshotted), so the accessory stays mounted and stable. The player
   paints its own opaque `View` under its `GlassSurface` so the live tabs screen doesn't show
   through. See `isTabsChromeRoute` in `src/lib/route-segments.ts`.

   A **pushed route** under `NativeTabs` is different: the native tab bar remains, but route
   classification deliberately unmounts the BottomAccessory / queue chrome on screens such as
   session detail. Its bottom layout must therefore trust the UIKit safe-area inset for the
   chrome that is actually present; it must not carry the accessory reserve forward from the tab
   root or add the tab-bar height a second time.

   **Bottom-chrome geometry contract.** "The UIKit inset" is ambiguous — there are two
   sampling points with different semantics, and conflating them is the recurring bug class
   behind #3967/#3973/#4089 and the Start-capsule regression:
   - The **root** `SafeAreaProvider` (what `BottomChromeMetricsProvider` in `app/_layout.tsx`
     samples) reports the _window_ inset: home indicator only. UIKit tab-bar chrome never
     reaches it.
   - Each tab's content sits inside a **nested per-tab `SafeAreaProvider`** (expo-router's
     `NativeTabsView` wraps every tab in one); _that_ inset folds in the tab bar, the
     BottomAccessory, and the live minimize state. `NativeTabContentInsetProbe` (mounted in
     every phone tab `_layout`, focus-gated) publishes it through
     `src/lib/native-tab-content-inset-store.ts` so root-level consumers position with the
     measurement instead of a reconstruction.

   Rules: position against the inset measured at the surface you're positioning in, or consume
   the published measurement via `useBottomChromeMetrics()` — `scrollBottomPadding` for
   list/scroll content, `floatingControlBottom` for absolute overlays, `fixedFooterBottom` for
   docked footers, `preSessionFooterBottom` / `inSessionListBottom` for the session surfaces.

   **Bottom-docked native sheets are the inverse case**: a sheet presents over the tab bar, so
   the only chrome its content must clear is the **window's** bottom inset (home indicator /
   gesture bar) — never its mount point's. A sheet mounted inside a tab inherits the per-tab
   provider, whose 139pt inset floated the filter sheet's Apply button ~105pt up into the sheet
   (#3776's "dead gap"). Every sheet footer/body bottom pad goes through
   `useWindowBottomInset()` (`src/hooks/use-window-bottom-inset.ts`, fed by
   `WindowInsetPublisher` in the root layout); the shared `Sheet` / `ModalSheet` wrappers
   already do. Sheets mounted at the app root get the same value either way — the hook makes
   the mount point irrelevant.
   Never hardcode what UIKit "must" have folded into an inset; constants are fallbacks for the
   pre-measurement frames only, and test fixtures carry DEVICE_VERIFIED / INFERRED provenance
   labels (`src/hooks/__tests__/bottom-chrome-metrics.test.ts` — extend its matrix when adding
   a chrome state). On-device verification without a rebuild: More → Diagnostics → "Bottom
   chrome diagnostics" overlays the live values (dev, preview builds, and `pr-<N>` OTA
   channels).

3. **Board gestures and modal/sheet pan don't mix.** A full-screen board you pan/pinch (the
   `holds` and `zone` filters) is a **pushed** route, not a modal — a modal/sheet's own pan
   gesture competes with the board's.

4. **`ModalSheet` (imperative) vs `Sheet` (declarative) is about _how it opens_**, not how it
   looks: a ref you `.present()` (or its controlled `visible` prop) vs a component whose presence
   in the tree shows it. Pick `ModalSheet` for on-demand surfaces (the common case); `Sheet` when
   the sheet's lifetime is bound to parent state.

5. **Sheet content must clear the bottom safe area itself — the native `@expo/ui` sheet does
   not.** The sheet draws under the system bottom inset on **both** platforms — the Android
   edge-to-edge nav bar (~48dp 3-button bar / gesture pill) _and_ the iOS home indicator (~34pt) —
   so a control at the bottom of a sheet needs `insets.bottom` added to its padding, or it sits
   under the bar (Kilter/Tension users on Android 3-button nav hit this on the board sheet). The
   shared `Sheet`/`ModalSheet` wrappers add it to their pinned `footer` and, for a **footerless**
   body, automatically via `withSheetBottomInset` (composed on top of your `contentContainerStyle`).
   A sheet built on the raw native primitive (its own `BottomSheetModal` + `BottomSheetFlatList`,
   e.g. the board sheet / queue list) owns this itself: add `insets.bottom + spacing[N]`. Apply on
   both platforms — `insets.bottom` is 0 when there's nothing to clear, so there's no double-inset.

## Pushing a route from INSIDE a modal route (the cross-navigator trap)

The in-tree-opener rule above is about sheets. Routes have their own version of it, and it
bites the other way round.

`/play` is a `transparentModal` in the **root** stack. `/(tabs)/climbs/create` is also a
`transparentModal`, but it lives in the **climbs-tab** stack — a different navigator, mounted
_beneath_ the root modal. So a `router.push('/(tabs)/climbs/create')` fired from inside the
player pushes create into a navigator that is already covered: create stacks **under** the
still-live player (two drawers visible at once), and `CreateDrawer`'s root-window
`BottomSheet` strands a scrim over the search list once you navigate away.

**The fix: finish each live surface in order, then push.** An edit/remix action claims a
one-action guard synchronously, before closing its custom overlay. It then awaits the source
managed sheet (Board or Queue), awaits the player route's close transition when the player is a
modal, and only then pushes create:

```text
claim action → dismiss source sheet → settle → dismiss /play → closing transitionEnd → push create
```

`dismissAndWait()` can return `aborted` when its source-sheet owner unmounts; that aborts the
rest of the handoff. The `/play` route has one deliberate exception: after its own callback has
called `router.dismiss()`, route teardown is the expected close path, so its bounded native-stack
ceiling remains alive when `transitionEnd` cannot arrive from the unmounted screen. A stale player
callback invoked _after_ the player already disappeared still returns `aborted` without calling
`router.dismiss()` again. Repeated taps join neither a second dismiss nor a second push because
the action guard is set before the first asynchronous boundary.

`handleSwitchBoardFromDrawer` in `drawer-host-provider.tsx` does the same
`router.dismiss()` → `router.push('/boards')` when the play drawer's board-mismatch overlay
routes to the board picker — but copy the shape, not the code: it is **ungated**, so on an
iPad pane (where there is no `/play` route) it pops whatever is focused instead. The gated
version is `useCreateClimbNavigation`
(`src/components/create-climb/use-create-climb-navigation.ts`), and both remix/edit entry
points (the reaction menu's `useClimbActions`, the in-player `ClimbActionsSheet`) go through
it.

Two things that are easy to get wrong:

- **Let the route own its close waiter.** The actual `/play` route subscribes to its native
  stack's `transitionEnd` before calling `router.dismiss()`, ignores events where `closing` is
  false, and uses its bounded ceiling if that dismissal unmounts the route before the native event
  can reach JS. If the route was already gone before the callback starts, it returns `aborted`
  instead of popping the now-visible route underneath. On web there is no native transition to
  await, so dismissal completes immediately. Thread this callback down through the in-tree opener;
  a hook mounted in a sibling root provider cannot safely subscribe to the `/play` navigator.
- **Omit the player callback when there is no player route.** The same menu opens from the
  climbs list and BoardSheet, and on an **iPad regular-width layout the player is an inline
  detail pane**. Those entry points must not call `router.dismiss()` or they can pop an unrelated
  route. The callback's presence is the gate; do not infer it from root-level segments.

The rule of thumb: **before pushing a route, ask which navigator it lands in.** Same navigator
is fine. A navigator _below_ the modal you're standing in needs the dismiss first.

## A latency footgun (any route)

A modal route's present animation can't START until React commits the route's first frame. If
that first render is heavy (the player mounts board geometry + a stack of hooks), the slide
visibly lags the tap. Paint only a cheap first frame (a solid/`GlassSurface` background) and
defer the heavy content one `requestAnimationFrame` — the present runs natively while the
content fills in mid-slide. See `app/play.tsx`. Don't use `InteractionManager` for this: it
waits out the whole transition and is disabled in screenshot mode.

## Worked examples

- **Queue / Board / LogAscent / Angle / ClimbActions / AddBetaVideo** — secondary, opened on
  demand → `ModalSheet`. The bread and butter.
- **Create-climb** — a drawer that shows the dimmed climbs list behind it, with one sibling
  sub-sheet (`HoldRoleSheet`, which stacks via its own SwiftUI host) → `transparentModal` route
  hosting a `Sheet` (`CreateDrawer`). Correctly _not_ a full-screen cover.
- **Player (now-playing)** — immersive full-screen, hosts 5–6 sub-sheets that must stack above
  it → `transparentModal` + opaque backing route. The exception that proves rule 1.
- **Boards picker / share-beta / join** — self-contained flows from a tab → `modal` card.
- **Setters / hold / zone filters** — opened from the climb filter sheet, which suspends and
  pushes them (rule 1, the suspend→push→re-present pattern). Hold/zone are full-screen interactive
  boards → pushed routes (rule 3); setters is a searchable list route.
- **Onboarding** — immersive cover, not over the live tab bar → `fullScreenModal`.
- **Crowdsourced-QA verdict sheet** (`QaVerdictSheet`) — opened from a user-drawer row, so it
  follows the same root-hosting rule as `FeedbackSheet`: mounted at the `UserDrawerProvider` root,
  **never** inside the `user-drawer` transparentModal route, and presented only through the route's
  `close(after)` once that route's view controller is gone (#3211). Its two QA screens
  (`app/qa/pick`, `app/qa/brief`) are plain `modal` cards — self-contained flows, so rule 1 applies
  unchanged.
- **Board look** (`app/(tabs)/profile/board-look/{index,custom,accessibility}`) — a settings parent
  and two leaves, all **pushed routes registered flat in the profile stack**, with no nested
  `_layout` of their own. The parent asks one question (which look?) over a rail of renders of your
  own board; each leaf holds what you can tune about the answer. Flat rather than nested because a
  nested navigator inside a tab stack costs you the back-swipe, the inherited header and the native
  tab bar's own behaviour for nothing — the depth is already expressed by the route names. Reach for
  the same shape for any settings screen that grows sub-pages.
- **Canonical climb URLs** (`app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/{list,view,play}`
  and `app/b/[board_slug]/...`) — a third category the decision tree above doesn't cover:
  **redirectors**, not surfaces. They exist so the browser build serves the same URLs the Next.js
  app does; each one resolves the URL to a board, adopts it as active, hands off to the Climbs tab
  or the play drawer, and replaces itself. They render only a spinner or a not-found, own no sheet
  of their own, and are the one case where a route is _not_ a destination. Don't hang new UI off
  them — put it on the surface they hand off to.

## iPad-only tab destinations (sidebar rail, never a phone tab)

To add a `(tabs)` destination that appears only on the iPad sidebar rail and NEVER as a phone
bottom tab (e.g. `/wall`, the "On the Wall" tab — `app/(tabs)/wall/`):

- Register it as a keyed `<Tabs.Screen name="wall" options={{ href: null }} />` in the shared
  `tabScreens` array (`app/(tabs)/_layout.tsx`). It **must** be a `(tabs)` route so it renders in
  the iPad shell's content pane (keeping the sidebar + play/wall panes); a root route would cover
  them.
- `href: null` is meant to hide it from the bar — but expo-router turns it into
  `tabBarItemStyle: { display: 'none' }` and **strips the `href` key**, so a _custom_ tab bar still
  renders it unless it filters. `MaterialTabBar` skips
  `StyleSheet.flatten(options.tabBarItemStyle)?.display === 'none'`.
- Add `<NativeTabs.Trigger name="wall" hidden />` (the `hidden` prop) so the iOS-26 glass bar
  declares the route but shows no 6th tab (a 6th would spill into "More" and clash with the
  `role="search"` slot).
- Add a `SidebarDestination` in `IpadSidebar.tsx`; `tabsActiveSegment` (route-segments.ts) already
  highlights it. Suppress any ambient duplicate of the same content (e.g. the wall column) while
  the destination is the focused segment.

## Bumping `react-native-screens` (the bottom-accessory patch)

`patches/react-native-screens@4.26.2.patch` carries the iOS 26 bottom-accessory fix: UIKit lays
an accessory in for free when it's set during the tab controller's initial setup, but not when
it's attached after the tab bar has appeared — which is exactly our case, since the accessory
only mounts once a current climb exists. The patch nudges a layout pass on that attach.

**The nudge must never run synchronously.** `applyBottomAccessoryVisibility` is called from
`updateContainer`, inside a React Native mounting transaction. The first version of the patch
called `-layoutIfNeeded` right there, and that layout got pulled into a feedback loop between a
presenting/dismissing `UISheetPresentationController` and the tab bar's minimize machinery
(our layout → `-[UITabBar layoutSubviews]` → `_minimizeBehavior` → a sheet alongside-animation
property set → `_sheetLayoutInfoLayout` → tab bar again). On iOS 27 that trips an AnimationKit
assertion (`Missing animationAndComposerGetter`): 42 events across 6 users, every one of them on
iOS 27.0 and on a pre-fix release (Sentry BOARDSESH-9K, fixed in #4198 / 2.3.1). The shipped shape hops out of the transaction with one
coalesced `dispatch_async`, and hands the work to the transition coordinator's completion block
if a transition is in flight.

pnpm keys patches by exact version, so a bump means re-keying. The runbook:

1. `vp exec pnpm patch react-native-screens@<version>` against the new version, re-apply the hunks, run
   `vp exec pnpm patch-commit <patch-directory>`, and check that
   upstream still hasn't added its own relayout to `applyBottomAccessoryVisibility` (4.27.0 has
   none — the patch is still required).
2. Confirm `patchedDependencies` in `pnpm-workspace.yaml` points to the re-keyed file under
   `patches/`, and **delete the old file** — pnpm ignores unreferenced patches without a word.
3. Update `patchedKey` on both `react-native-screens` rules in `scripts/mobile-patches-check.ts`,
   and the `overrides` pin in `pnpm-workspace.yaml`.
4. `vp run check:mobile-patches`.

That check is the backstop, and it asserts shape, not just symbols: the deferral sentinels
(`rnscreens_layoutBottomAccessoryOutsideTransition`, `_rnscreens_bottomAccessoryRelayoutScheduled`,
`animateAlongsideTransition`) plus a negative assertion that no synchronous layout sits inside
`applyBottomAccessoryVisibility`. A re-keyed patch that kept the entry-point symbol but restored
the crashing line would otherwise pass green. If it reports it can't locate the anchor method,
upstream reshaped it — re-verify the patch by hand and update the rule. Don't delete the
assertion to get green.

A `react-native-screens` bump is a native-fingerprint change: it goes through a `[native-train]`
draft, not straight to `main` (see `docs/mobile-ota-updates.md`).

## See also

- `docs/react-native-performance.md` — list/provider/gesture performance rules.
- `docs/mobile-ota-updates.md` — JS-only vs native-change distribution (a presentation change is
  JS-only and rides OTA; a new native module needs a build).
