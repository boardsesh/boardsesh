# Mobile large-screen layout

How the mobile app adapts on iPad, Android tablets and web desktop. It moved here from [ai-design-guidelines.md](ai-design-guidelines.md), which keeps the system itself (colour, type, spacing, accessibility). Phone chrome metrics are in [mobile-chrome.md](mobile-chrome.md).

## Large-screen adaptive layout (iPad + Android tablet + web desktop)

**iPad on Liquid Glass follows Apple Music.** It uses the native `NativeTabs` sidebar
(`sidebarAdaptable`): a sidebar in landscape, a tab bar at the top in portrait. Every tab is **one
content column**; there is no player pane, wall column or wall strip beside it. The current climb rides
the bottom accessory, Music's MiniPlayer (HIG Tab bars: "tab bars with an attached accessory, like the
MiniPlayer in Music"), and tapping it, or any climb, opens the full-screen `/play` player, as on iPhone
(HIG: "Don't change your app's functionality based on the space it occupies"). The accessory opens
the player with the same slide as a climb row (#8126). The accessory shows the bar's climb, the last one you opened, not always the
current one (see `nativeAccessory` in [mobile-chrome.md](mobile-chrome.md#aesthetic-vs-capability)). `resolveCurrentClimbSurface` (`src/hooks/current-climb-surface.ts`) is the one answer
to "who shows the current climb": the floating JS bar, the bottom-chrome reserve, the rest pill and the
drawer host's tap routing all read it, so the climb never shows twice. Tab content clears the
accessory through the measured in-tab inset (`tabBarAtBottom: false`, the same path as the iPhone
Duo's side rail).

**Desktop browsers keep a MiniPlayer beside their panes.** On the browser sidebar shell,
the shared floating card stays across the bottom of every tab root, Profile included. Its
three-dot menu opens the queue; the optional Queue button uses the same action. The card
shows the last pick or queue current, using the existing MiniPlayer preferences, on either
appearance variant. Tapping its climb selects that climb in the detail pane when it fits.
The native iPad and Android tablet layouts keep their existing player hosts.

The card starts 8px after the 96px rail and ends 8px before the window edge. With the
rail up it docks to the window inset, ignoring a bottom-tab height cached before resize.
Lists reserve its 48px height; the selected-climb and wall panes clear the same space.
Below 700px the existing compact browser chrome takes over. A pushed route, Wall display,
or a tab with no climb does not reserve a floating card. The pane owns playlist paging
while it is present, so the accompanying MiniPlayer never starts a second background pager.

**The landscape iPad player is Music's Now Playing.** `resolvePlayerArrangement`
(`src/components/play-drawer/play-drawer-layout.ts`) returns `sideBySide` when a native iPad window is
wider than tall and leaves a 600 pt board column beside the 400 pt panel; everything else, iPad portrait
and every phone included, is `stacked`, the board on top as before. Side by side, the board fits the
column's full height with the title and the tick row under it, and `PlayerSidePanel` sits on the right:
a segmented control for Up next (the queue sheet's own `QueueListBody`), Logbook (`LogbookSection`) and
Beta (`BetaVideosSection`), opening on Up next, with Switch board at its foot where Music keeps AirPlay.
The queue button then selects Up next instead of stacking the queue sheet over the player.

## Secondary surfaces on web and tablets

Sheet presentation follows the platform and the current available window. On the browser only,
the input that opens a surface also matters:

| Surface when opened | Presentation | Width |
| --- | --- | --- |
| Browser below 700 CSS px | Compact bottom sheet | Available width |
| Browser at least 700 CSS px, mouse or keyboard opener | Centered dialog | Forms up to 560px; lists up to 672px |
| Browser at least 700 CSS px, touch or pen opener | Bottom sheet | Up to 640px |
| Native iPad | System page/form sheet or the existing anchored picker | System-controlled |
| Native Android tablet | Material bottom sheet | System-controlled, bounded by Material's 640dp default |

The 700px browser opening rule is a Boardsesh presentation threshold. It is independent of the
physical-screen tablet qualifier, shell panes, and Material's window size classes. Opening a native
sheet with a trackpad or keyboard keeps its native treatment. Apple recommends centered page/form
presentations on iPad in [HIG: Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets).
Android's [Compose bottom sheets](https://developer.android.com/develop/ui/compose/components/bottom-sheets),
[default sheet width](https://developer.android.com/reference/kotlin/androidx/compose/material3/BottomSheetDefaults#SheetMaxWidth()),
and [adaptive window size classes](https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes)
provide the native sizing model. The native facade forwards children directly to Expo without a
new width cap or layout wrapper. Keep content within its actual sheet host rather than assuming
that a native sheet occupies the full window width.

Wide browser overlays leave at least 24px horizontal gutters; dialogs also keep 24px above and
below the surface. Bottom sheets stay anchored to the bottom. A dialog has one bounded scroll body,
a fixed header and actions, and no detents or drag-to-resize requirement. Its height is the smaller
of 720px and the visible viewport height minus 48px, floored at zero. Touch sheets retain their
existing detents and keyboard interaction. The full-screen player, board editor, wall display,
and existing persistent panes keep their own layout contracts.

Choose and latch the presentation for each opening. Dialogs follow the visible viewport's size and
position through resize, zoom, and keyboard changes. Touch sheets update their horizontal width and
position while retaining Gorhom's existing vertical detents and keyboard behavior. These updates do
not change the host or discard edits, focus, or scroll position. A dialog opened wide stays a dialog if the window becomes narrow; a sheet opened
compact stays a sheet if the window grows. Closing and reopening chooses again from the new width
and initiating input. `src/lib/sheet-presentation-policy.ts` and `src/lib/opening-input.web.ts` own
these decisions. Screens supply semantic size, a label, and their close request through the
`src/components/sheet-presentation.tsx` facade (`.web.tsx` on the browser).
`sheet-presentation-context.tsx` exposes presentation capabilities to shared content.

## JS tablet shell

The rest of this section describes the **JS tablet shell**, which Android tablets, Expo web and an iPad
on the Material variant still use.

A **tablet-sized surface** on the JS shell — an Android tablet, a qualifying web screen, or an iPad on
Material — gets a multi-column shell; every phone, and a tablet-sized surface in a narrow window, falls
through to the phone UI **verbatim**. The shell is drawn in each platform's own chrome through
`TabletSidebar` (`createVariantComponent`): **Material 3** (`MaterialNavigationRail`) on Android
tablets and web, and the glass `IpadSidebar` rail where the Liquid Glass look applies.
The size class is pure and unit-tested in `theme/size-class.ts` (`resolveDeviceLayout`), fed window
width by `hooks/use-device-layout.ts`:

- **`compact`** — every phone, plus a tablet window narrower than `REGULAR_WIDTH_BREAKPOINT` (700dp:
  iPad Slide Over / a narrow Split View, Android split-screen / freeform / DeX). Renders today's phone
  UI; no phase may regress it.
- **`regular`** — a tablet window wide enough for the sidebar rail (replacing the bottom tab bar) and a
  content column. The detail pane needs its own width budget; `expanded` (≥1024dp) is a separate flag.

**Eligibility, not idiom.** The shell admits iPad (`Platform.isPad`) plus Android and web screens whose
smallest physical-screen width clears **600dp/CSS px** (`resolveIsTablet`, matching Android's
`sw600dp` tablet qualifier), fed to the same `resolveDeviceLayout`. The signal is launch-fixed (the
physical screen, not the window), so an eligible device in a small multi-window/DeX/browser window is
still a tablet surface but reads `compact` from the live width. The live breakpoints are shared across
variants: below 700 uses the phone chrome, 700–815 adds the rail, 816–1175 also mounts the persistent
detail pane, and 1176+ has room for the wall column when a board is bound. The `expanded` flag remains
1024+, independently of those width-budgeted pane decisions.

**The rail is variant-skinned, IA-identical.** The Material `MaterialNavigationRail` mirrors
`MaterialTabBar`'s M3 roles laid out vertically — a `secondaryContainer` active-indicator pill
(`material.navRail`, 56×32), `onSecondaryContainer` glyph, `onSurface` active label, `onSurfaceVariant`
inactive, active/inactive glyph pairs matching the bottom bar — on an `m3SurfaceContainers.low` surface
(depth by tone, flat, no cast). It shares the **96dp** `SIDEBAR_WIDTH` with the glass rail (96 ≥ M3's
80dp minimum), because that width is injected into every master-detail width-budget resolver and a
per-variant width would fork the budget. Same destinations, same top-tablist / bottom-pinned-Profile
structure. **No rail FAB / no header** — an IA-parity guardrail: the glass rail has neither, so a
Material-only rail FAB would fork information architecture between the two tablet variants; if ever
wanted, add it to both together.

**Panes read M3 depth by tone, not iOS hairlines.** On the Material variant the shell column
separators come from `m3.outlineVariant` (the M3 faint-divider role), and the panes' `GlassSurface`
degrades to an opaque M3 tonal surface (`useEffectiveSurfaceMode` → `material` on Android). Frame the
detail (play) pane as an M3 **List-Detail** detail pane and the wall column as an M3 **Supporting
pane**.

**The live wall reaches Android tablets and web desktops too.** `resolveWallDeviceClass` marks either
surface `panel-capable` — there is **no** dp/CSS-pixel physical-size floor there (the iPad points floor
`WALL_PANEL_MIN_DEVICE_LONG_SIDE` exists only because iPad points can't separate a mini from a Pro at
the same size class; density-bucketed Android dp isn't comparable to it, and the live width budget in
`resolveWallSurface` already decides column/strip/none). So a 10" Android tablet in landscape gets the
dedicated wall column, a narrower one gets the strip. The kiosk hero-type distance scale skips the
iPad points-per-inch estimate on Android (no reliable ppi from RN JS) and falls back to the pane short
side. True Android distance-DPI calibration (native `DisplayMetrics.xdpi`) and Material You dynamic
color are follow-ups.

**Android tablets must rotate.** The app is portrait-locked app-wide; the `with-android-tablet-orientation`
config plugin lets `sw600dp` tablets rotate to landscape (the shell's whole point) while phones stay
portrait — the Android counterpart to the iOS `~ipad` orientation override. It's a native change, so it
ships in a native build, not an OTA.

**The right column is master-detail, not status.** At `regular` width the shell is
`sidebar · active-tab content · detail pane` (`(tabs)/_layout.tsx`). The detail pane (`IpadPlayPane` →
`PlayDrawer presentation="pane"`) follows the user's **selection** — tapping a list row updates it —
mirroring Mail/Notes/Files. It is the SELECTION surface; do not repoint it at shared/live status (that
was the original bug). A `setAsCurrent:false` open (feed / beta / climb view) previews in the pane
without committing to the queue (`openPlayDrawer(..., { previewQueueItem })`, carried on
`playDrawerPaneProps.openTarget.options`), so every climb-open entry point populates the pane.

**The live wall is STATUS, with its own width-adaptive home** (`resolveWallSurface({ width, widthClass,
sidebarWidth })` → `'none' | 'strip' | 'column'`):

- Ambient `SidebarWallCell` in the rail footer (always, `regular`) — the glanceable cross-tab anchor.
- A dedicated **`column`** on the trailing edge when the 96pt sidebar and 300pt wall column leave
  at least `WALL_COLUMN_BALANCED_CONTENT_FLOOR` (390pt) each for browse content and the detail pane.
  The balanced budget is 96 + 300 + 390 + 390 = **1176pt**; width, rather than orientation, decides.
- A compact **`strip`** docked atop the detail pane in portrait, where a 4th column would crush the
  list (11" 834pt / 13" 1032pt).

All three reuse `NowOnTheWallPanel` (extracted from `BoardSheet`, `variant: 'sheet' | 'column'`) and tap
through to the full `BoardSheet`. Rules when adding layout-sensitive iPad components:

- Decide column-vs-strip from the **computed width budget**, never a raw breakpoint — it stays correct
  across rotation / Split View / Stage Manager.
- Exactly **one wall surface per layout**: the shell passes `showWallCell={!showWallColumn}` to the
  sidebar so the rail cell and the column never both show.
- Inline columns/strips **own their safe-area insets** (`insets.top` for a top-of-shell column header,
  `insets.bottom` for a full-height column footer). A native `@expo/ui` sheet does not handle its
  own: the `Sheet` / `ModalSheet` wrappers add `useWindowBottomInset()` for it (see
  `docs/mobile/mobile-sheets-vs-routes.md`, rule 5). When a strip is
  docked above the pane, the shell sets `PlayDrawer paneTopInset={false}` so the inset isn't doubled.
- Status may **annotate** selection (the wall button says whether the selected climb is lit; the header's
  back chip, arrow + face, goes back to the wall's climb) — but never replace it.

**The detail pane is width-budgeted, like the wall column** — not gated on a raw breakpoint. The
persistent detail (play) pane mounts only when, after the sidebar and a minimum pane width, the browse
list still clears the readable content floor (`WALL_COLUMN_CONTENT_FLOOR` 400pt) — via
`resolveDetailPaneSurface` in `theme/size-class.ts`, mirroring `resolveWallSurface`. On the narrowest
regular widths (iPad mini and 9.7–10.2" portrait, ~744–810pt) the pane would squeeze the list below the
floor, so there it falls back to the compact bottom-sheet `PlayDrawer` and the list keeps the full
content column. This applies the "compute from the width budget, never a raw breakpoint" rule above to
the detail pane, closing the one place it wasn't followed.

**The active sidebar row uses neutral system glyphs**, matching the bottom tab bars. The sidebar is the
tab-bar analogue, so its active row follows the same chrome-glyph rule as `NativeTabs` and
`MaterialTabBar`: `systemColors.label` selected / `secondaryLabel` inactive, with the `systemColors.fill`
pill as the active affordance — not a brand-violet tint. Brand colour stays for genuine accents, per the
chrome-glyph rule documented under Iconography in [ai-design-guidelines.md](ai-design-guidelines.md#iconography).

**The shell is width-adaptive, not idiom-adaptive.** Size class is driven by the launch-fixed tablet
flag (`Platform.isPad`, Android `sw600dp`, or web physical short side ≥600px) plus the live window
width; only width is live. The guarantee is "the right layout for the current window width on a
tablet-sized surface," not a layout that re-derives the device idiom across Stage Manager, DeX, a
browser resize, or an external display. Note also the deliberate choice of a
bespoke 96dp icon-over-label rail instead of a `UISplitViewController` sidebar (iOS) / a full Material
navigation **drawer** (Android, `expanded` width): a Phase-1 call that keeps the rail simple but means
it won't inherit system sidebar behaviours (collapse control, pointer magnetism). Revisit in Phase 2+
whether to adopt a true wide text sidebar / the iPadOS 18 floating-tab-bar-to-sidebar pattern, and the
M3 navigation drawer at expanded width.

---
