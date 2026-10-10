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
background natively, plus JS-side keyboard avoidance for the `header` / `footer` column — neither
native sheet window resizes for the keyboard, so the wrappers pad on both platforms):

**Background rule.** On iOS with the Apple variant, leave the sheet's native
`backgroundStyle` unset, even when `surface="solid"` is requested. The system
then draws the appropriate sheet appearance for the OS. Explicit Material 3 and
Reduce Transparency use an opaque `theme.sheetSurface` instead. Apply this rule
to raw `BottomSheet`/`BottomSheetModal` users too, through the shared sheet
background resolver. Android and web retain their current behavior. For a
`modal` page route, leave presentation chrome native and use semantic backgrounds
on content such as a form or list when needed for readability.

| Wrapper                                            | Backing            | Opened by                                                                          | Use when                                                                                                                          |
| -------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **`ModalSheet`** (`src/components/ModalSheet.tsx`) | `BottomSheetModal` | imperatively via ref — `present()` / `dismiss()`, or the controlled `visible` prop | A button/handler opens it. Presents **above root chrome** (the queue bar / tab bar) for free. The default for an on-demand sheet. |
| **`Sheet`** (`src/components/Sheet.tsx`)           | `BottomSheet`      | declaratively — its presence in the tree shows it                                  | Its lifetime is tied to parent state.                                                                                             |

Examples: `QueueSheet`, `BoardSheet`, `LogAscentSheet`, `AngleSelectorSheet`,
`ClimbActionsSheet`, `AddBetaVideoSheet` (sheet surfaces), `HoldRoleSheet` (a declarative `Sheet`).

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
wrapping a sheet in one pushes it _under_ the overlay window, not above. A native sheet mounted
inside a modal route presents above that route instead — that's how `HoldRoleSheet` shows over
the New climb editor. There is **no**
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
`ClimbFilterSheet`). `LogAscentSheet` used to be one of these; it is a `ModalSheet` now. The coordinator serializes transitions per **presenter group**
(default `'root'`) and auto-sequences a sheet-over-sheet open as
dismiss(A) → settle → present(B). **A displaced sheet is closed, not suspended**:
the coordinator clears its desired-open flag and fires `onDisplaced`, which
`useManagedSheet` delivers as the sheet's `onClose` (same contract as a user
pan-down), so the parent clears the state that drove `open`. Never design a flow
that expects a displaced sheet to come back by itself when the displacer closes —
that implicit resume was the phantom-tick-sheet bug (PR #3595). One exception: the
`FullWindowOverlay` menus (e.g. `ClimbReactionMenu`), which are custom overlays in a higher
window, not native sheets. (`CreateDrawer` used to be a second one, a raw `BottomSheet` as the
create-climb route's primary sheet; New climb is a modal route now, so it has no sheet to
coordinate.)

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
Android bounds it natively and keeps `flex: 1`. A raw-`BottomSheet` surface with a scroll body
(`ClimbFilterSheet`) must apply the same hook itself. Anything else hands the native sheet its
single flex child by going through `Sheet` / `ModalSheet` (the picker sheets do). `LogAscentSheet` is a `ModalSheet` now
and gets it from the wrapper.

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

- The single flex child (the chrome column) takes a **`maxHeight`** of
  `window − topInset − chrome`, not `flex: 1` — under a `matchContents` host a `flex: 1` child
  resolves to zero. At rest it measures to the form; a keyboard-up long note pushes it into the
  ceiling.
- The scroll body takes **`flexShrink: 1`**, not `flex: 1` — content height at rest (this is what
  closes the void), and it shrinks-and-scrolls once the column hits its ceiling so the footer
  stays pinned above the keyboard instead of the note clipping.

**Keyboard: pad the column, never a `KeyboardAvoidingView`.** RN 0.86's KAV computes its overlap
from its own `onLayout` frame, which inside a native sheet is relative to the sheet's content
view, not the window. It under-pads by the sheet's distance from the top of the screen, which left
the log-ascent Attempt / Save bar half under the keyboard. The wrappers instead pad the chrome
column by `useSheetKeyboardInset` (`src/components/sheet-keyboard-inset.ts`):

- iOS measures it: the column's bottom in window coordinates (`measureInWindow`, re-measured on
  every keyboard event) minus the keyboard's top. On iPhone that is the keyboard height; an iPad
  sheet UIKit lifts clear gets 0, and an undocked or split keyboard (narrower than the window) is
  ignored. iPad reads only the did-event (at the will-event the sheet is not lifted yet, so the pad
  would flash in and back out), and a detent change with the keyboard up re-measures once more
  300 ms after the native `onChange`.
- Android pads by keyboard + window inset (RN reports the IME without the nav bar).
- While the keyboard covers the sheet the footer's resting window inset is swapped out, not added,
  so the bar rests `spacing[3]` above the keyboard. On iOS the change rides the keyboard's animation.
- When the keyboard comes up the sheet rises to its last (keyboard) detent without the drag
  haptic: at a short detent such as FeedbackSheet's 44% the keyboard leaves the body no room.
- It listens only while the sheet has a header or footer and is open, and seeds from
  `Keyboard.metrics()` when a sheet opens over a keyboard that is already up.

A raw-sheet surface with a text field (`ClimbFilterSheet`) uses the same hook.

`skipPartiallyExpanded` still comes for free (the shim sets it whenever `fitToContents` or a
single detent), so the ~50% partial trap of #4723 stays closed — the sheet can only rest at its
one content-fitted state or Hidden, no imperative re-snap in the mix.

The bound isn't optional the moment a surface gains a scroll body: without it the scroll view
never gains an overflow, so nothing scrolls **and** the footer is off-screen. `LogAscentSheet`
went years on a plain `flex: 1` column safely — it had no scroll body and no pinned footer, so
neither failure mode had anything to bite. Adding either one makes the hook load-bearing. A sheet
with more than one detent should also pass `activeIndex` from the native `onChange`, so the bound
tracks the resting detent instead of leaving dead space under the footer at the taller one.

**Android gesture roots inside native dialogs.** Expo's Material 3 sheet hosts React Native
content in a separate dialog window. The app-level `GestureHandlerRootView` does not cover
that window. A sheet containing RNGH gestures must put a local `GestureHandlerRootView`
**inside** the native sheet, around its content, with `flex: 1` for bounded sheet content.
`QueueSheet` does this on Android only (#5923); iOS and web retain their existing hierarchy.
Keep row gesture composition and refs intact rather than changing tap/hold arbitration.

For #5923, native pointer traces on Android API 36 showed holds entering the Expo dialog
without reaching the row recognizers. With the local root, the tap failed after 300 ms and
the 400 ms long press opened actions exactly once for upcoming and history rows. Native QA
also covered ordinary taps, horizontal swipe actions, edit selection, scrolling and history
ticks. The focused Maestro regression can run against each queue entry point.

**Existing Android reorder limitation.** Expo's community wrapper accepts
`enableContentPanningGesture` and `enableHandlePanningGesture` but does not implement them on
Android. The Material sheet may therefore pan instead of handing drag-handle movement to
the queue. On the same API 36 cached development binary, native drag attempts failed both
before and after the local-root correction. The local root restores row recognition; it does
not implement the native sheet's missing gesture-lock contract. Reorder needs separate host
work and native QA before claiming that contract works on Android.

### Routes (`expo-router` `Stack.Screen`)

| `presentation`         | Looks like                                           | Use when                                                                                                                                 | Examples                                                                                                       |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| _(none — pushed)_      | Full-screen, slides in from the side, back-navigable | A deep destination, **or** a full-screen interactive board (pan/pinch) where a modal's pan would fight the gestures                      | session detail; `holds` / `zone` / `setters` filters                                                           |
| **`modal`**            | pageSheet card with a top gap, dimmed parent behind  | A self-contained flow launched from a tab; a card is fine                                                                                | `boards`, `share-beta`, `join`; **New climb** (`climbs/create`, swipe-down off — see the worked example) |
| **`transparentModal`** | Transparent — the live screen behind stays visible   | A drawer-as-route that should show the screen behind it, **or** a full-screen cover that must NOT disturb the screen behind (see rule 2) | the **player** and **`onboarding`** (each with an opaque backing to read as full-screen) |
| **`fullScreenModal`**  | Opaque full-screen cover                             | An immersive full-screen flow that is **not** presented over the iOS 26 native tab bar                                                   | no tab-root editing flow; nothing on a phone (`onboarding` moved to `transparentModal` in #5654) |

### Play drawer section controls

Settings → Climb view and the eye button beside the player's ellipsis use the same seven visibility
switches. The eye opens the **View options** sheet (`PlayDrawerSectionsSheet`)
as a managed `ModalSheet` mounted inside the player, above `/play`. Its bulk actions
remain outside the list scroll. On iOS with the Apple variant, the header controls and
list leave their backgrounds unset so the native sheet material stays visible around
the inset switch group. Only the grouped rows use an opaque semantic content surface;
Material, Reduce Transparency, Android and web keep their grouped content background.
Show all and Hide all
stay together above the grouped switches, with 44-point targets and disabled states
when every section already matches the action. Choices apply immediately; the close
button dismisses the sheet without a save step. It remains reachable
when every section is hidden. These device-local choices use AsyncStorage (IndexedDB
in the browser) and keep each section's existing expansion preference and order.

The first eligible visible section supplies the header preview at the fold; its header
mounts before deferred content so hiding Logbook never strands the remaining sections.
With no eligible sections, the board and controls fill the viewport including safe-area
clearance, and vertical scrolling is disabled. Native scrolling uses its normal
activation distance, with iOS directional locking to reduce diagonal drift.
The carousel and scroll-intent observer run simultaneously with the scroll;
neither makes the native scroll wait for a gesture to fail. Scroll intent and
the start of a drag request deferred content when the header alone cannot scroll.
Pinch, zoomed panning, and downward dismissal retain their own gesture handling.
Browser touch, wheel, trackpad, and keyboard scrolling retain native browser behavior.
While a visible section awaits content, the drawer gets one pixel of initial
overflow so those inputs can open the content gate. Hide all removes that overflow.

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
     │    (a modal TASK with a board, like New climb → modal, gestureEnabled: false)
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
   `useFocusEffect` when the screen re-focuses (covers the back chevron _and_ swipe-back). The
   sub-route hands its result back through a tiny pub/sub handoff. This is how `ClimbFilterSheet`
   opens the `setters` / `holds` / `zone` filters. The sheet's own Apply commits in its close
   callback, which fires after the native slide-down, so the parent never unmounts the sheet
   mid-animation. A sub-route can also commit directly: the setters route's "Show N climbs" button
   sends its handoff with `apply: true`, and the sheet calls `onApply` then `onDismiss` itself,
   because a suspended sheet has no native close to wait for.

2. **Never `fullScreenModal` over the iOS 26 `NativeTabs`.** A `fullScreenModal` snapshots the
   presenting tab view controller for its transition; the native bottom-accessory glass platter
   then lingers stacked under the live one (doubled climb name), and the alternative —
   unmounting the accessory — churns the native tab-bar height and shoves the docked Climbs
   search field. Use **`transparentModal` + an opaque backing** instead: the tabs screen stays
   live behind it (never snapshotted), so the accessory stays mounted and stable. The player
   paints its own opaque `View` under its `GlassSurface` so the live tabs screen doesn't show
   through. See `isTabsChromeRoute` in `src/lib/route-segments.ts`.

   The rule also reaches iPad: `NativeTabs.sidebarAdaptable` owns the adaptive
   tab sidebar at every window size. Editing routes use native cards, and board
   editors fit their measured card host rather than the full window. Never
   switch to `fullScreenModal` based solely on `Platform.isPad`.

   A **pushed route** under `NativeTabs` keeps the native tab bar — and therefore keeps the
   `NativeTabs.BottomAccessory` **host mounted**. The accessory is a child of the bar, so a
   detach re-lays-out the bar; on iOS 26 that leaves the docked `role="search"` Climbs item on
   a stale frame, drawn wrong and hit-testing to nowhere until the app is force-quit (#5055 —
   the same failure `126538345` hit on the player route). The invariant: **the host mounts
   exactly when the bar is up** (`isAccessoryHostRoute`, which is `isTabsChromeRoute` under
   another name), and unmounts only on a root push/modal where the whole tab VC leaves and the
   accessory co-detaches with the bar. **Mounted is not presented**: UIKit still stops drawing
   the platter once you push (device-checked on the playlist route), so keeping the host open
   changes nothing the climber sees — it only stops *us* calling `setBottomAccessory:nil`
   under a live bar. Everything about visible chrome — the bottom-chrome reserve, the JS
   queue toolbar (Android / iOS < 26) — therefore keeps using the narrower
   `isAccessorySurfaceRoute` (#3253), which is now a presentation gate only. Keying the
   reserve on the mount gate instead reserves accessory height for a platter that is not on
   screen, which is #3776's dead gap.

   A pushed route's bottom layout must trust the UIKit safe-area inset for the chrome that is
   actually present — `NativeTabContentInsetProbe` stays mounted across the push and republishes
   it — and must not add the tab-bar height a second time.

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
   gesture competes with the board's. The one way to put a board in a modal is to switch that
   pan off: `gestureEnabled: false`, with an X as the way out. New climb does this, because it
   is a modal task (a draft you finish or leave), not a destination to push.

4. **`ModalSheet` (imperative) vs `Sheet` (declarative) is about _how it opens_**, not how it
   looks: a ref you `.present()` (or its controlled `visible` prop) vs a component whose presence
   in the tree shows it. Pick `ModalSheet` for on-demand surfaces (the common case); `Sheet` when
   the sheet's lifetime is bound to parent state.

5. **Sheet content must clear the bottom safe area itself — the native `@expo/ui` sheet does
   not.** The sheet draws under the system bottom inset on **both** platforms: the Android
   edge-to-edge nav bar (~48dp 3-button bar / gesture pill) and the iOS home indicator (~34pt).
   A control at the bottom of a sheet needs the **window** bottom inset added to its padding, or
   it sits under the bar (Kilter/Tension users on Android 3-button nav hit this on the board
   sheet). Read it from `useWindowBottomInset()`, never `useSafeAreaInsets().bottom`: inside a
   tab, the local inset includes the tab bar (up to 139pt) that the sheet covers, which is the
   dead gap in rule 2. The shared `Sheet`/`ModalSheet` wrappers add it to their pinned `footer`
   and, for a **footerless** body, automatically via `withSheetBottomInset` (composed on top of
   your `contentContainerStyle`). A sheet built on the raw native primitive (its own
   `BottomSheetModal` + `BottomSheetFlatList`, e.g. the board sheet / queue list) owns this
   itself: add `useWindowBottomInset() + spacing[N]`. Apply on both platforms. The inset is 0
   when there's nothing to clear, so there's no double inset.

6. **Actions go in the top bar.** See "Where actions go" below.

## Where actions go

Sheet and screen actions sit at the top, Apple HIG style: leading Cancel / close / back, a
centred title, a trailing confirm. A top bar never moves with the keyboard, the bottom inset or
error text, so this removes the bottom-button yank (buttons jumping after a sheet opens, or when
the keyboard opens or closes). `no-bottom-footers.test.ts` fails if a new sheet footer appears.

- **Sheets.** Pass `<SheetTopBar>` (`src/components/SheetTopBar.tsx`) through the `header` prop of
  `ModalSheet` / `Sheet`. The header sits above the body and outside its scroll. Trailing is the
  confirm. Mark it `prominent` for the sheet's main action, `disabled` until the form is valid,
  and `loading` while it saves. The spinner takes the label's place without changing the width.
  `trailingAccessory` (a "?" help button, say) sits before it. The title yields when room runs
  short: it goes off-centre, then truncates. The actions never truncate.
- **Leading: xmark or Cancel.** Use `close` (an xmark, as the iOS 26 system sheets do) when leaving
  loses nothing: pickers, detail and filter sheets. Use `cancel` (the word) when leaving would
  throw away an edit: forms and reports. Use `back` for step two onward of a multi-step sheet.
- **How the confirm looks.** One spec, in `docs/ai-design-guidelines.md`, "Top-bar buttons". Name the
  trailing action's `kind`: `confirm` when it saves or commits the climber's own edit (Save, Add, a Done
  that commits a value), `send` when it sends or reports to someone else (Submit, Report, Claim),
  `forward` when it moves on, applies, or closes a confirmation (Next, Apply, a post-submit Done). On
  iOS 26 a confirm is a ✓ in a brand circle the size of the leading X; its label is the spoken name. A
  destructive commit is red text, never a red ✓. Send and prominent forward actions are a brand capsule
  in a sheet. On Material all of them are brand text with no fill. A Done with nothing to commit is no
  trailing action: give the surface a leading X instead. In a native header on iOS 26,
  `useHeaderActions` renders the trailing side as native bar items (see the guidelines for the loading
  and accessory cases). A screen that sets `headerRight` itself with `setOptions` wraps it in
  `ownHeaderRight()` so a native item never hides it. A leading action takes `disabled` too, with the
  same dimmed look.
- **Pushed or modal screens.** Call `useHeaderActions({ leading, trailing })`
  (`src/hooks/use-header-actions.ts`). It takes the same shape and sets the native stack's
  `headerLeft` / `headerRight`. On iOS 26 those render as Liquid Glass bar items, and on Material
  as top app bar actions. The hook only writes the slots you pass and never clears one (a form
  that can be swapped for a not-found state while the route stays passes `clearOnUnmount`), so leave
  out `leading` (or pass `null`) to keep what the layout sets, such as the spray flow's
  leave-guarded X. Don't pass `leading: back` on a pushed stack screen: the native back chevron
  keeps its long-press history menu, and ours would not.
- **Multi-step flows** (the spray wizard). Step 1 shows an X as leading. From step 2 on, show a
  back chevron instead (disabled while a request runs), and blank the title: the body's step
  counter says where you are, and a German forward label plus the X would not fit at 375 pt.
  Leaving from there is a swipe down through the leave guard, or back to step 1's X; Android Back
  steps back like the chevron. Trailing is the step's forward action: "Next", "Skip" while untouched, "Done". Pass a
  leading action on every step: the hook never clears, so a step that leaves it out keeps the
  last step's chevron.
- **Secondary content actions** ("Reset", "Start the corners again", "Take a photo") sit inline
  next to the content they act on, the way Photos puts Reset over the crop. Never stack them under
  a primary button.
- **Errors** go in a slot that is already there: `SheetTopBar`'s `error` with `reserveErrorSlot`,
  or a reserved line under the field. Showing an error never moves a control.
- **What stays at the bottom.** Composers (`CommentSheet`'s input and Send, Messages style), bottom
  tool palettes (`SprayEditorBottomBar`) and FABs. They are tools, not form actions. Buttons that
  belong to a form's body and are not pinned (auth screens, Delete account) stay inline.
- **The one form-footer exception** is `LogAscentSheet`. Its `TickActionBar` (Attempt / Save) stays at
  the bottom for thumb reach while logging an ascent.

## Pushing a route from INSIDE a modal route (the cross-navigator trap)

The in-tree-opener rule above is about sheets. Routes have their own version of it, and it
bites the other way round.

`/play` is a `transparentModal` in the **root** stack. `/(tabs)/climbs/create` is a `modal`,
but it lives in the **climbs-tab** stack — a different navigator, mounted _beneath_ the root
modal. So a `router.push('/(tabs)/climbs/create')` fired from inside the player pushes create
into a navigator that is already covered: create stacks **under** the still-live player. (When
create was a bottom-sheet drawer, it also stranded a scrim over the search list once you
navigated away.)

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

### Player swipe dismissal

The player keeps its native opening and chevron-close transitions. A downward
swipe instead owns one Reanimated translation for the entire route surface,
including its opaque backing and glass. `use-drawer-dismiss-gesture` continues
that transform on release with the downward velocity and a clamped spring. It
does not wait for JavaScript to start a second native animation from the dragged
position: that handoff caused a visible pause just after release.

`use-play-swipe-dismiss` removes the route only after the spring finishes. It
sets `animation: 'none'`, then yields two animation frames before dismissal so
the option update and removal are separate native mounting transactions. Those
frames happen with the player already offscreen. The closing latch survives
gesture finalization, blocks repeat touches and chevron taps, and releases on
animation cancellation. A completion after unmount is ignored; if another modal
has taken focus, the player restores itself underneath it instead of dismissing
the newer modal. The route's existing programmatic close waiter stays native.

The iPad pane does not receive this route-owned animation. Keep the modal's
live-behind presentation and accessory-host mount rules above when changing it.

### Opening a heavy route

A modal route's present animation can't START until React commits the route's first frame. If
that first render is heavy (the player mounts board geometry + a stack of hooks), the slide
visibly lags the tap. Paint only a cheap first frame (a solid/`GlassSurface` background) and
defer the heavy content one `requestAnimationFrame` — the present runs natively while the
content fills in mid-slide. See `app/play.tsx`. Don't use `InteractionManager` for this: it
waits out the whole transition and is disabled in screenshot mode.

The player board also waits for the scroll viewport, title header, and Logbook header
measurements before its one-frame defer starts. The carousel keeps its flex container
mounted for measurement, but mounts images and prefetch only after it can contain-fit the
board. Give both the image and zoom wrapper explicit dimensions: a cached image painted
at an implicit size can visibly grow when layout corrects it during the native slide.
Keep this measurement gate in screenshot mode too. Once mounted, ordinary resizing and
climb changes reuse the carousel without restarting the opening placeholder.

## Worked examples

- **Queue / Board / LogAscent / Angle / ClimbActions / AddBetaVideo** — secondary, opened on
  demand → `ModalSheet`. The bread and butter.
- **Report climb** — `ReportClimbSheet`, a `ModalSheet` opened from the climb actions menu; from
  the player it runs through the in-tree opener override (`onReportClimb`, same shape as
  `onAddBetaVideo`), so `PlayDrawer` mounts its own copy and the root `DrawerHostProvider` mounts
  the other.
- **Moderation feed** (`app/moderation.tsx`) — root-stack `modal` card, so it presents above the
  player as well as from Settings and from a proposal notification in either tab. It lived in
  both tab stacks first, and that was wrong: the play drawer's Community section links into it, and
  `/play` is itself a root `transparentModal`, so a tab-stack push landed *beneath* the player (the
  rule-1 trap above). The deep-link param is `proposalUuid`, plus `climbUuid` / `boardType` when the
  caller has them.
- **New climb** (`/(tabs)/climbs/create`) — a focused modal task, like Mail's compose or a new
  reminder (HIG "Modality"), so a **`modal`** route: on iPhone a pageSheet that covers the
  screen with the climbs list scaled behind it, on Android an M3 full-screen dialog that slides
  up (`animation: 'slide_from_bottom'`, Android only, so iOS keeps its own). iPad
  also uses a native editing card. `CreateDrawer` measures its root's width and
  height and fits the board to that card, with no status-bar inset inside it.
  It used to be a
  `transparentModal` hosting a two-detent `@expo/ui` bottom sheet (`CreateDrawer`) with a
  collapse chevron, which read like a music player's mini-player; that sheet is gone, and
  `CreateDrawer` is now just the editor body. Four decisions carry it:
  - **Swipe-down is off** (`gestureEnabled: false`). Painting and pinching the board are drags,
    and a pageSheet's dismiss pan would fight them (rule 3). HIG allows switching interactive
    dismissal off when it conflicts with the content's own gestures.
  - **An X leads the top bar** (`SheetTopBarLeadingButton kind="close"`), not Cancel: leaving
    loses nothing, because the autosave flushes the draft on unmount and the next open restores
    it. Its accessibility hint says so. Android's back does the same close (a focus-gated
    `BackHandler`), and both show the "draft kept" toast after the pop. Save is the trailing
    confirm; the ⋯ menu sits before it. While the hold-role sheet is up, back closes that sheet
    (it is a native dialog that takes back itself; the editor's handler also checks).
  - **The top bar is pinned above the scroll**, so the X and Save never move. The keyboard is
    handled by the scroll: `automaticallyAdjustKeyboardInsets` on iOS, and on Android padding by
    `useKeyboardHeight()`. On Android a `modal` route is an ordinary fragment in the activity
    window (react-native-screens `ScreenStack.adapt`), not a dialog, but the app is edge-to-edge
    (`decorFitsSystemWindows(false)`), so `adjustResize` resizes nothing on any route and the
    keyboard draws over the scroll. RN reports the IME inset minus the nav bar, and the scroll's
    pad already carries the window inset, so the two add up to the keyboard's full height.
  - **Loading a draft or starting a new climb calls `router.setParams`**, never
    `router.replace`: a replace drops the modal and presents a new one, so the sheet would slide
    away and back. The editor is keyed on those params, so it still remounts cleanly.

  `HoldRoleSheet` presents above the modal, like the player's sub-sheets, and the BLE device
  picker is hosted inside the route (`DevicePickerSheetHost registerExternal`). Not
  `fullScreenModal` (rule 2): the route is under `NativeTabs` on iPhone.
- **Player (now-playing)** — immersive full-screen, hosts 5–6 sub-sheets that must stack above
  it → `transparentModal` + opaque backing route. The exception that proves rule 1.
- **Boards picker / share-beta / join** — self-contained flows from a tab → `modal` card.
- **Setters / hold / zone filters** — opened from the climb filter sheet, which suspends and
  pushes them (rule 1, the suspend→push→re-present pattern). Hold/zone are full-screen interactive
  boards → pushed routes (rule 3); setters is a searchable list route.
- **Onboarding** (the walkthrough, replayed from Settings) — an immersive cover presented
  over the live tabs, so `transparentModal` + an opaque backing, like the player (rule 2). It was a
  `fullScreenModal` until #5654. Like the player it counts as a tabs-chrome route
  (`isTabsChromeRoute`), so the bottom accessory stays mounted under it rather than detaching
  while the bar is still up.
- **First-board picker** (#5654) — what the launch gate opens for a new account with no board. Not
  a new surface: the existing `boards` `modal` card with `?source=onboarding&firstBoard=1`, which
  swaps the discovery tiles for "Where do you climb?". A card over the tabs, so rule 2 is not in
  play.
- **Crowdsourced-QA verdict sheet** (`QaVerdictSheet`) — opened from a user-drawer row, so it
  follows the same root-hosting rule as `FeedbackSheet`: mounted at the `UserDrawerProvider` root,
  **never** inside the `user-drawer` transparentModal route, and presented only through the route's
  `close(after)` once that route's view controller is gone (#3211). Its two QA screens
  (`app/qa/pick`, `app/qa/brief`) are plain `modal` cards — self-contained flows, so rule 1 applies
  unchanged.
- **Settings** (`app/settings/`) — a pushed ROOT destination with its own `_layout`, covering the
  tab bar like `about` / `changelog`. It lived at `(tabs)/profile/more`, and that was
  the bug: opening it from the user drawer switched to the You tab and left `more` on that tab's
  stack, so the next tap on You reopened Settings instead of the profile. A tab's stack is the
  tab's own history — put a surface there only if it is genuinely part of that tab. Two
  consequences worth knowing before you add a row: the first screen of a root group still shows a
  back chevron (the root stack hands its `HeaderBackContext` down), and a `router.push` aimed at a
  TAB route from inside Settings stacks a SECOND `(tabs)` instance over it — use `router.dismissTo`
  for those (the "Notifications" and "Playlists" rows both do), which pops back to the tabs already
  below and drops Settings on the way. Same rule for a root route Settings pushes that exits to a
  tab: `onboarding`'s replay exits `dismissTo` rather than `replace` for exactly this reason, and
  `dismissTo` is the verb to reach for because it also behaves on a cold deep link — it replaces
  the current screen when the route it names isn't in the stack to pop back to.
- **Board look** (`app/settings/board-look/{index,custom,accessibility}`) — a settings parent
  and two leaves, all **pushed routes registered flat in the settings stack**, with no nested
  `_layout` of their own. The parent asks one question (which look?) over a rail of renders of your
  own board; each leaf holds what you can tune about the answer. Flat rather than nested because a
  nested navigator costs you the back-swipe and the inherited header for nothing — the depth is
  already expressed by the route names. Reach for the same shape for any settings screen that grows
  sub-pages.
- **Spray-wall flows on iPad** (`/boards/spray/new`, `/holds`) stay native modal
  cards over the adaptive tab sidebar. The hold editor and scan step measure the
  card area to choose their phone/tablet layout and fit the photo. iPad maintenance
  screens retain an X through the leave guard and can hide the home indicator.
  `fullScreenModal` would snapshot the native tab container (rule 2).
- **Account** (`/account`) is the native iOS avatar sheet. Settings and Edit profile
  push inside its own stack; Back returns to the account menu. Android and the
  browser retain the side drawer. User search, connections, profiles and Settings
  opened directly from a tab resolve into that tab's stack, preserving the tab bar.
- **Native iPad pickers** use an anchored `AnchoredPopover` at regular width; compact
  windows retain the phone sheet. `AppMenu` already anchors native UIKit menus.
  The angle toolbar picker keeps its diagram and slider in the popover.
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
only mounts once a current climb exists. The patch nudges a layout pass on that attach, **and on
the detach**: `[_controller.tabBar setNeedsLayout]` before the pass, because a docked
`role="search"` item's frame comes out of `-[UITabBar layoutSubviews]` and nothing else
invalidates it — that asymmetry left the Climbs search item shoved and unhittable until a
force-quit (#5055). The nudge fires on the accessory-**identity** edge (so attach→attach with a
new wrapper counts), and an edge arriving while a pass is in flight is queued in
`_rnscreens_bottomAccessoryRelayoutNeedsRepeat` rather than dropped. Only
`applyBottomAccessoryVisibility` may set that flag and it is cleared before re-arming, so the
layout pass can never schedule itself — that termination property is what BOARDSESH-9K lacked.

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

That check is the backstop, and it asserts shape, not just symbols. Guarding both directions:
back into the crash — the deferral sentinels (`rnscreens_layoutBottomAccessoryOutsideTransition`,
`_rnscreens_bottomAccessoryRelayoutScheduled`, `animateAlongsideTransition`) plus a negative
assertion that no synchronous layout sits inside `applyBottomAccessoryVisibility`; and back into
#5055 — the `[_controller.tabBar setNeedsLayout];` line, the repeat/identity ivars, an
`orderedSentinels` triple proving the schedule call sits AFTER both branches rather than nested in
the attach one, plus negative assertions on the old attach-only method name and on the layout pass
arming its own repeat. A re-keyed patch that kept the entry-point symbol but restored either
regression would otherwise pass green. If it reports it can't locate the anchor method,
upstream reshaped it — re-verify the patch by hand and update the rule. Don't delete the
assertion to get green.

A `react-native-screens` bump is a native-fingerprint change. It lands on `main` and triggers new
store builds, temporarily pausing OTA delivery to older binaries until users install the release
(see `docs/mobile-ota-updates.md`).

## Player zoom from the tab accessory

On iPhone with the native tab accessory, tapping the current climb uses Router's native
`Link.AppleZoom` source and `/play`'s `Link.AppleZoomTarget`. The tap stages the
current queue head with `openPlayDrawer(climb, { navigate: false })` before Link
navigates. This preserves the board override and existing play-target reset rules
without a second navigation. Keep the source mounted in the tab accessory while
the transparent player is open so closing it can zoom back to the same climb.

Reduce Motion, floating toolbar hosts, Android, web and iPad use the existing opener. iPad opens
its persistent detail pane. The player's native interactive dismissal stays
disabled; its existing vertical swipe owns dismissal, so two gestures cannot
compete. Keep the lightbulb and tick controls outside the zoom source.

## See also

- `docs/react-native-performance.md` — list/provider/gesture performance rules.
- `docs/mobile-ota-updates.md` — JS-only vs native-change distribution (a presentation change is
  JS-only and rides OTA; a new native module needs a build).

**Unsaved form dismissal:** playlist, feedback, climb/wall reports, and beta links use
`useUnsavedSheetGuard`. The native wrapper cannot veto a gesture after UIKit starts
dismissing, so dirty or submitting forms disable pan/backdrop dismissal. Cancel
asks Discard changes / Keep editing while preserving the visible form; submissions
bypass that guard after success. A late confirmation cannot dismiss a reopened
form or a different record. Coordinator displacement remains a separate host
notification, so it never attempts to reopen a sheet during native handoff.

**Submit failures stay in their sheet:** use an uncapped, wrapping error row inside the
scroll body, or beside a composer. Preserve typed text and attachments on failure, and clear
the error on retry. Root toasts appear behind native sheets and cannot explain
why a form remains open. Logbook editing already follows this contract.


**Row swipe actions:** climb, queue, and logbook rows share an 88-point reveal,
a 44-point reveal threshold, and a 192-point full-swipe release threshold. A short
swipe reveals a labelled button; a full swipe commits once and closes, including
when Reduce Motion settles the opening animation before the JS release callback.
Keep reaction-menu long-press and screen-reader actions available.

Queue removal uses the queue's scoped live-merge Undo. Logbook deletion keeps its
confirmation, then hides the entry and offers eight seconds to Undo before sending
DELETE_TICK. The root LogbookDeleteProvider owns that deadline across route changes.
An account, board, or session change cancels unsent deletions with visible feedback.
Capture that scope before awaiting confirmation; a delayed answer cannot delete
an old entry under a new identity. Never recreate a deleted Aurora tick for Undo.


**Standard detents:** percentage-based sheets use the shared 50% medium and 90%
large presets. QR share sheets and forms scroll at medium; large retains the
keyboard expansion path and pinned footers. Tick sheets keep Android's measured
content-fitting path. Create's full-height 90%/100% editor and genuinely measured
content are separate layout contracts. The production source guard follows multiline JSX
`snapPoints` expressions and aliases; no legacy percentage allowlist remains.
