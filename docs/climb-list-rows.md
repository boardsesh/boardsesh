# Climb list rows

Climbs → eye opens `/settings/climb-list` in the current tab. Settings also links to it immediately above Climb view. The screen uses the same row visual as the lists, with staged personal leaves so the example works without signing in or loading a logbook.

## Fields and presets

`packages/mobile/src/lib/climb-row-display.ts` is the switch registry. Name, prominent grade, rule badges, warnings and interactions stay fixed. Thumbnail, community grade, sends, rating, setter, sent mark, playlist tags and quick actions are individual choices. Personal progress is added separately to the same registry.

| Preset | Picture | Detail tokens | Sent mark | Playlist tags |
| --- | --- | --- | --- | --- |
| Names only | Off | Off | On | Off |
| Text only | Off | On | On | Off |
| Default | On | On | On | Off |
| Everything | On | On | On | On |

Quick actions is outside presets. Active preset is derived by comparing content fields. A manual mix reads Custom; applying a preset remembers that mix, and the Custom chip restores it. Default clears content overrides so shipped defaults can continue to apply.

The prominent grade still follows Settings → Grades. When the personal or Boardsesh grade differs, Community grade shows the crowd's grade in the detail line. With sends, rating and setter all hidden, that token docks beside the name.

## Persistence and geometry

`climb-row-display-preference.ts` owns the synchronous MMKV snapshot. Leaves subscribe to this store directly, so unrelated Settings writes do not redraw list rows. The legacy playlist-tags and quick-actions keys are reconciled and mirrored for OTA rollback compatibility; failed writes stay pending until retried.

`climb-row-layout.ts` decides which lines exist, the estimated height, and the separator inset. Thumbnail-off rows do not mount the native thumbnail renderer. Reserve late-loading tags and mirror status lines before those reads settle. The two reorder hosts keep one-line names and suppress personal progress; ordinary lists allow names to wrap from font scale 1.3.

The preview window reserves the tallest supported row at the current font scale and theme, with a 117 pt minimum, so switches stay in place and large-text tags stay visible. It uses the active board's most-climbed row and stages a favorite, direction statuses, two playlists and a differing personal grade. Without board geometry its picture is a neutral block. A second, unmarked row appears when both fit.

## Adding a switch

1. Add its field and default to `climb-row-display.ts`; spell it out in every preset.
2. Add its control and translated labels to the settings model and all common catalogs.
3. Apply it in the shared row visual; preserve each host's capability gates.
4. Update layout, skeleton and preview leaves if it adds geometry or data.
5. Check persistence, preset matching, visibility and reserved-line behavior in nearby tests.

Analytics emit `Climb Row Display Changed` from controller interactions only, with `kind`, and either `field`/`value` or `preset`.

Device QA covers each switch, Custom restoration, relaunch, legacy migration, small screens, large text, both themes, mirror boards and reorder rows. In particular inspect the three-action header at 375 pt and reserved empty lines on mirror boards.
