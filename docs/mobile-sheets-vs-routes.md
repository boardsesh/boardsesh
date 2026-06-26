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

Wrapped by two helpers so they don't drift (both supply the scrim, drag handle, iOS 26 glass
background, and keyboard avoidance natively):

| Wrapper                                            | Backing            | Opened by                                         | Use when                                                                                                                          |
| -------------------------------------------------- | ------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **`ModalSheet`** (`src/components/ModalSheet.tsx`) | `BottomSheetModal` | imperatively via ref — `present()` / `dismiss()`  | A button/handler opens it. Presents **above root chrome** (the queue bar / tab bar) for free. The default for an on-demand sheet. |
| **`Sheet`** (`src/components/Sheet.tsx`)           | `BottomSheet`      | declaratively — its presence in the tree shows it | Its lifetime is tied to parent state. Has a **`fullWindowOverlay`** prop to float above other sheets.                             |

Examples: `QueueSheet`, `BoardSheet`, `LogAscentSheet`, `AngleSelectorSheet`,
`ClimbActionsSheet`, `AddBetaVideoSheet` (sheet surfaces), `CreateDrawer` + `HoldRoleSheet`
(declarative `Sheet`s).

**Stacking a sheet above another sheet / above everything:** add `fullWindowOverlay` to a
`Sheet` (renders it in a higher window), or use a `FullWindowOverlay` directly. This is how
`HoldRoleSheet` floats above the create drawer and how `ClimbReactionMenu` (the long-press
context menu) floats above whatever's underneath.

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
dismiss(A) → settle → present(B). Two exceptions, both documented in-file:
`CreateDrawer` (a route-primary drawer that opens once and whose only sub-sheet is
a `fullWindowOverlay`, so it never overlaps a coordinated transition) and the
`fullWindowOverlay` menus, which live in a higher window.

### Routes (`expo-router` `Stack.Screen`)

| `presentation`         | Looks like                                           | Use when                                                                                                                                 | Examples                                                                                                       |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| _(none — pushed)_      | Full-screen, slides in from the side, back-navigable | A deep destination, **or** a full-screen interactive board (pan/pinch) where a modal's pan would fight the gestures                      | session detail; `holds` / `zone` filters                                                                       |
| **`modal`**            | pageSheet card with a top gap, dimmed parent behind  | A self-contained flow launched from a tab; a card is fine                                                                                | `boards`, `share-beta`, `join`                                                                                 |
| **`transparentModal`** | Transparent — the live screen behind stays visible   | A drawer-as-route that should show the screen behind it, **or** a full-screen cover that must NOT disturb the screen behind (see rule 2) | `create-climb` (shows the climbs list, dimmed); the **player** (with an opaque backing to read as full-screen) |
| **`fullScreenModal`**  | Opaque full-screen cover                             | An immersive full-screen flow that is **not** presented over the iOS 26 native tab bar                                                   | `onboarding`                                                                                                   |

## The decision tree

```
Is it a secondary surface OVER the current screen, or its own full surface?

├─ Secondary surface ─────────────────────────► BOTTOM SHEET
│    ├─ Opened imperatively (button → present)?  → ModalSheet
│    ├─ Tied to parent state (declarative)?      → Sheet
│    └─ Must stack above an open sheet?           → Sheet + fullWindowOverlay
│                                                   (or FullWindowOverlay)
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
   a route and not a sheet.

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
   looks: a ref you `.present()` vs a component whose presence in the tree shows it. Pick
   `ModalSheet` for on-demand surfaces (the common case); `Sheet` when the sheet's lifetime is
   bound to parent state and especially when you need `fullWindowOverlay`.

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
- **Create-climb** — a drawer that shows the dimmed climbs list behind it, with one sub-sheet
  (`HoldRoleSheet`, via `fullWindowOverlay`) → `transparentModal` route hosting a `Sheet`
  (`CreateDrawer`). Correctly _not_ a full-screen cover.
- **Player (now-playing)** — immersive full-screen, hosts 5–6 sub-sheets that must stack above
  it → `transparentModal` + opaque backing route. The exception that proves rule 1.
- **Boards picker / share-beta / join** — self-contained flows from a tab → `modal` card.
- **Hold / zone filters** — full-screen interactive board → pushed route (rule 3).
- **Onboarding** — immersive cover, not over the live tab bar → `fullScreenModal`.

## See also

- `docs/react-native-performance.md` — list/provider/gesture performance rules.
- `docs/mobile-ota-updates.md` — JS-only vs native-change distribution (a presentation change is
  JS-only and rides OTA; a new native module needs a build).
