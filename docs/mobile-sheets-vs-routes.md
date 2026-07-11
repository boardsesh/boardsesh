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
signal: our `@expo/ui` patch (`patches/@expo%2Fui@57.0.3.patch`) forwards SwiftUI's
post-animation `.sheet(onDismiss:)` out of the community wrapper as `onFullyDismissed`, which
`useManagedSheet` routes into `coordinator.notifyFullyDismissed`. So a surface that renders the
raw `BottomSheetModal`/`BottomSheet` must pass `onFullyDismissed={managed.onFullyDismissed}` (the
`Sheet`/`ModalSheet` wrappers already do) — otherwise its handoffs fall back to the ceiling timer
and wait the full delay. A fixed per-platform timer (`IOS_SHEET_SETTLE_MS` / `ANDROID_SHEET_SETTLE_MS`)
is the fallback: it's the only settle signal on **Android** (Compose has no post-animation event),
and on iOS it's the ceiling for the rare case the native event never arrives (a Host torn down
mid-animation). A `__DEV__` warning fires only when the ceiling beats a native signal that was
expected (an iOS dismiss of a still-registered sheet).

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
(e.g. `ClimbFilterSheet`) must apply the same hook itself.

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

3. **Board gestures and modal/sheet pan don't mix.** A full-screen board you pan/pinch (the
   `holds` and `zone` filters) is a **pushed** route, not a modal — a modal/sheet's own pan
   gesture competes with the board's.

4. **`ModalSheet` (imperative) vs `Sheet` (declarative) is about _how it opens_**, not how it
   looks: a ref you `.present()` (or its controlled `visible` prop) vs a component whose presence
   in the tree shows it. Pick `ModalSheet` for on-demand surfaces (the common case); `Sheet` when
   the sheet's lifetime is bound to parent state.

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

## See also

- `docs/react-native-performance.md` — list/provider/gesture performance rules.
- `docs/mobile-ota-updates.md` — JS-only vs native-change distribution (a presentation change is
  JS-only and rides OTA; a new native module needs a build).
