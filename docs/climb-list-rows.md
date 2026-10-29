# Climb list rows

Settings → Climbs & grades → Climb list, above the Climb view row, opens `/settings/climb-list`. The Climbs tab has no shortcut to it: the filter chips keep the whole row (#6397). The screen uses the same row visual as the lists, with staged personal leaves so the example works without signing in or loading a logbook.

## Fields and presets

`packages/mobile/src/lib/climb-row-display.ts` is the switch registry. Name, prominent grade, rule badges, warnings and interactions stay fixed. Thumbnail, community grade, sends, rating, setter, sent mark, My progress, playlist tags and quick actions are individual choices. My progress is off by default.

| Preset | Picture | Detail tokens | Sent mark | My progress | Playlist tags |
| --- | --- | --- | --- | --- | --- |
| Names only | Off | Off | On | Off | Off |
| Text only | Off | On | On | Off | Off |
| Default | On | On | On | Off | Off |
| Everything | On | On | On | On | On |

Quick actions is outside presets. Active preset is derived by comparing content fields. A manual mix reads Custom; applying a preset remembers that mix, and the Custom chip restores it. Default clears content overrides so shipped defaults can continue to apply.

The prominent grade still follows Settings → Climbs & grades. When the personal or Boardsesh grade differs, Community grade shows the crowd's grade in the detail line. With sends, rating and setter all hidden, that token docks beside the name.

## Persistence and geometry

`climb-row-display-preference.ts` owns the synchronous MMKV snapshot. Leaves subscribe to this store directly, so unrelated Settings writes do not redraw list rows. The legacy playlist-tags and quick-actions keys are reconciled and mirrored for OTA rollback compatibility; failed writes stay pending until retried.

`climb-row-layout.ts` decides which lines exist, the estimated height, and the separator inset. Thumbnail-off rows do not mount the native thumbnail renderer. Reserve late-loading tags, progress and mirror status lines before those reads settle, including signed-out rows. The two reorder hosts keep one-line names and suppress personal progress; ordinary lists allow names to wrap from font scale 1.3.

Queue and playlist edit lists give every indexed drag row the same minimum height, computed from all their row shapes and current typography. Mixed-board direction lines, unavailable-climb warnings and set-angle grade captions count toward that floor. Direction labels stay on one line in drag hosts, and unresolved climbs reserve the grade's text height. This keeps drop indices and sibling shifts consistent as pictures are hidden or grades arrive.

The preview window reserves the tallest supported row at the current font scale and theme, with a 117 pt minimum, so switches stay in place and large-text tags stay visible. It uses the list's full width and action gutter, including in the browser form. It uses the active board's most-climbed row and stages a favorite, direction statuses, two playlists and a differing personal grade. Without board geometry its picture is a neutral block. A second, unmarked row appears when both fit.

## One or two columns

The Climbs tab draws two climbs side by side when its list is at least 900pt wide (`climbListColumns` in `packages/mobile/src/components/climb-list-thumbnail-metrics.ts`). The width is the list's own frame, measured with `onLayout`, so the iPad sidebar (280pt in landscape) and the iPhone Duo's player pane and tab rail are already left out. That gives two columns on an 11" iPad in landscape (914pt) and a 13" iPad either way up (1032pt and 1086pt). An 11" iPad in portrait (834pt), an iPad mini with its sidebar open (853pt), a ⅓ split, every iPhone and the iPhone Duo stay on one column. On the open Duo the player takes half the window, so the list measures about 391pt, or 475pt with the rail collapsed. The closed Duo is 466pt wide.

The first render guesses the width from the window, less the side safe area and, on a regular-width iPad in landscape, the sidebar (`estimateClimbListWidth`). The screen keeps only whether the list fits two columns, so a measurement that agrees with the guess (every phone) re-renders nothing. A wrong guess changes the column count once, after the first layout.

A column change remounts the FlashList (`key`). FlashList keeps its measured layouts when it swaps its grid layout manager for the linear one, and the grid's row-height floor (`minHeight`, 128pt in two columns) survived into one column: after a rotation to portrait every other row stood 16pt too tall. The remounted list scrolls back to the climb that was first on screen (`onLoad` then `scrollToIndex`).

In a grid row, FlashList gives the shorter cell the taller one's height. `ClimbListRow`'s `fillCell` makes the row grow into it, so the highlight and the touch area reach the bottom and the separator sits on it, level with its neighbour's.

Two columns use an 88×112 thumbnail; one column keeps 76×96. The list provides the size through `ClimbListThumbnailSizeContext`, and every row, placeholder, separator and height estimate reads it from there (`useClimbListThumbnailSize`, the `thumbnailSize` input of `climbRowLayout`, `climbRowSeparatorInsetStyle`). Every other host, including the queue, playlists, sheets and the Settings preview, sits outside the provider and keeps 76×96. Playlist detail, smart lists, profile climbs and setter pages stay on one column.

List cells render their overlay at `max(400, ceil(width × pixel ratio × 1.25))` (`climbListThumbnailRenderWidth`). On a phone and on an iPad this is 400 for both cell sizes, so the list and the MiniPlayer share the `_w400_` cache entry. Callers that pass their own `size` (feed cards, notifications, the session hero) keep the older `max(400, 5 × width)`.

Pagination and thumbnail prewarming count climbs, not rows. In two columns the next-page lookahead and the prewarm window both double in climbs, so they reach as far down the screen as in one column.

Settings → Climb list → Columns offers One column or Two columns, with Two columns as the default. The choice shows only on a tablet whose screen is at least 900pt on its long side, so on every iPad and on no iPhone, the Duo included. It is stored as `climbListLayout` in the synchronous settings store and read on the list's first render.

## Frame counts and personal progress

Climbs with multiple frames show a stack-and-count pip over the picture. With the picture hidden, it joins the name badges. Single-frame climbs keep the same row.

My progress is supported by the main Climbs list, playlist detail and profile climbs, plus the staged Settings preview. Reorder rows never mount it or request its data. It shares one personal line with each direction's independent flash/send/attempt mark; an original send does not erase a mirror attempt. Enabling it removes the extra sent glyph beside the grade. Repeated sends display their count even when the first send was a flash.

Each supported list groups UUIDs by board and calls `useLogbook` once per board batch whenever Sent mark or My progress is on. Sent marks and progress read the same board/climb/angle index, so a playlist shows personal marks before its climbs have been opened, including when My progress is off. Memoized leaves use keyed `useSyncExternalStore` subscriptions, so logbook changes do not repaint board art. Toggling progress preserves the list instance; disabled hosts and lists with both fields off mount no auth/query loaders. Holds-revision filtering happens before marks or progress are derived. A passive ownership guard starts with the root query client. Credential changes withdraw copied ticks synchronously and old shared-cache query identities stay fenced until auth cleanup removes them. Empty anonymous accumulators can carry into login only when no authenticated batch or fetched-climb marker exists; a pending previous-account fetch remains fenced.

Recency reads the clock inside a memo. It refreshes when the progress, locale or font scale changes, or when the row remounts; a row left mounted through midnight has no timer. The progress text caps at font scale 1.3, and recency drops before the outcome as space gets tighter. Direction statuses remain in the spoken label.

## Adding a switch

1. Add its field and default to `climb-row-display.ts`; spell it out in every preset.
2. Add its control and translated labels to the settings model and all common catalogs.
3. Apply it in the shared row visual; preserve each host's capability gates.
4. Update layout, skeleton and preview leaves if it adds geometry or data.
5. Check persistence, preset matching, visibility and reserved-line behavior in nearby tests.

Analytics emit `Climb Row Display Changed` from controller interactions only, with `kind`, and either `field`/`value` or `preset`.

Device QA covers each switch, Custom restoration, relaunch, legacy migration, small screens, large text, both themes, mirror boards and reorder rows. In particular inspect the current-climb pill at 375 pt and check reserved empty lines on mirror boards.

Contributing a change: [contributing-to-screens.md](./contributing-to-screens.md).
