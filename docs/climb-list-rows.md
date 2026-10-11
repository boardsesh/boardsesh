# Climb list rows

Climbs → eye beside the filter chips opens `/settings/climb-list` in the current tab. Settings also links to it immediately above Climb view. The screen uses the same row visual as the lists, with staged personal leaves so the example works without signing in or loading a logbook.

## Fields and presets

`packages/mobile/src/lib/climb-row-display.ts` is the switch registry. Name, prominent grade, rule badges, warnings and interactions stay fixed. Thumbnail, community grade, sends, rating, setter, sent mark, My progress, playlist tags and quick actions are individual choices. My progress is off by default.

| Preset | Picture | Detail tokens | Sent mark | My progress | Playlist tags |
| --- | --- | --- | --- | --- | --- |
| Names only | Off | Off | On | Off | Off |
| Text only | Off | On | On | Off | Off |
| Default | On | On | On | Off | Off |
| Everything | On | On | On | On | On |

Quick actions is outside presets. Active preset is derived by comparing content fields. A manual mix reads Custom; applying a preset remembers that mix, and the Custom chip restores it. Default clears content overrides so shipped defaults can continue to apply.

The prominent grade still follows Settings → Grades. When the personal or Boardsesh grade differs, Community grade shows the crowd's grade in the detail line. With sends, rating and setter all hidden, that token docks beside the name.

## Persistence and geometry

`climb-row-display-preference.ts` owns the synchronous MMKV snapshot. Leaves subscribe to this store directly, so unrelated Settings writes do not redraw list rows. The legacy playlist-tags and quick-actions keys are reconciled and mirrored for OTA rollback compatibility; failed writes stay pending until retried.

`climb-row-layout.ts` decides which lines exist, the estimated height, and the separator inset. Thumbnail-off rows do not mount the native thumbnail renderer. Reserve late-loading tags, progress and mirror status lines before those reads settle, including signed-out rows. The two reorder hosts keep one-line names and suppress personal progress; ordinary lists allow names to wrap from font scale 1.3.

Queue and playlist edit lists give every indexed drag row the same minimum height, computed from all their row shapes and current typography. Mixed-board direction lines, unavailable-climb warnings and set-angle grade captions count toward that floor. Direction labels stay on one line in drag hosts, and unresolved climbs reserve the grade's text height. This keeps drop indices and sibling shifts consistent as pictures are hidden or grades arrive.

The preview window reserves the tallest supported row at the current font scale and theme, with a 117 pt minimum, so switches stay in place and large-text tags stay visible. It uses the list's full width and action gutter, including in the browser form. It uses the active board's most-climbed row and stages a favorite, direction statuses, two playlists and a differing personal grade. Without board geometry its picture is a neutral block. A second, unmarked row appears when both fit.

## Frame counts and personal progress

Climbs with multiple frames show a stack-and-count pip over the picture. With the picture hidden, it joins the name badges. Single-frame climbs keep the same row.

My progress is supported by the main Climbs list, playlist detail and profile climbs, plus the staged Settings preview. Reorder rows never mount it or request its data. It shares one personal line with each direction's independent flash/send/attempt mark; an original send does not erase a mirror attempt. Enabling it removes the extra sent glyph beside the grade. Repeated sends display their count even when the first send was a flash.

Each supported list groups UUIDs by board and calls `useLogbook` once per board batch. A stable progress store builds the board/climb/angle index once; memoized leaves use keyed `useSyncExternalStore` subscriptions, so logbook changes do not repaint board art or unrelated rows. Toggling progress preserves the list instance; disabled hosts mount no auth/query loaders. Holds-revision filtering happens before progress is derived. A passive ownership guard starts with the root query client. Credential changes withdraw copied ticks synchronously and old shared-cache query identities stay fenced until auth cleanup removes them. Empty anonymous accumulators can carry into login only when no authenticated batch or fetched-climb marker exists; a pending previous-account fetch remains fenced.

Recency reads the clock inside a memo. It refreshes when the progress, locale or font scale changes, or when the row remounts; a row left mounted through midnight has no timer. The progress text caps at font scale 1.3, and recency drops before the outcome as space gets tighter. Direction statuses remain in the spoken label.

## Adding a switch

1. Add its field and default to `climb-row-display.ts`; spell it out in every preset.
2. Add its control and translated labels to the settings model and all common catalogs.
3. Apply it in the shared row visual; preserve each host's capability gates.
4. Update layout, skeleton and preview leaves if it adds geometry or data.
5. Check persistence, preset matching, visibility and reserved-line behavior in nearby tests.

Analytics emit `Climb Row Display Changed` from controller interactions only, with `kind`, and either `field`/`value` or `preset`.

Device QA covers each switch, Custom restoration, relaunch, legacy migration, small screens, large text, both themes, mirror boards and reorder rows. In particular inspect the current-climb pill at 375 pt, confirm the eye stays visible when the filter chips scroll, and check reserved empty lines on mirror boards.
