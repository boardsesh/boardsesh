# Mobile playlists and Discover

The Discover tab is `packages/mobile/app/(tabs)/discover/index.tsx`. It composes
shared playlist hooks from `@boardsesh/playlists-react` with the native
`DiscoverLibraryView`, playlist cards, shelves, and form sheets under
`packages/mobile/src/components/playlist/`.

## Library and detail

The library combines smart lists, pinned/owned playlists, and community discovery.
Smart lists include authored and liked climbs, ratings/projects/repeats, and the
recommendation presets supported by the current source. Community streams are
deduplicated. Shelf pagination must request one page per gesture rather than
draining a cursor automatically; preserve stable card callbacks and bounded rows.

`app/(tabs)/discover/[playlist_uuid].tsx` hosts detail. The shared
`app/playlists/[playlist_uuid].tsx` entry preserves incoming links. Ownership and
visibility determine edit/delete, follow, pin, and share actions. `PlaylistFormSheet`
serves creation and editing. Keep mutation cache updates in the shared playlist
hooks rather than duplicating business rules in a screen.

## Climb activation

The list/player/queue contract is in [lists and queue](../../product/climb-lists-and-queue.md).
`packages/mobile/src/lib/playlists/` owns activation snapshots, render-board
selection, sorts, loaded pages, and list continuation. A playlist's board scope is
not proof that every climb fits the currently selected physical wall.

Use [grade summaries](../../data/playlist-grade-summaries.md) for playlist grades,
[offline reads](../../data/offline-reads.md) for cached/offline behavior, and
[shared patterns](20-shared-patterns.md) for sheets and lists. Public website
playlist pages are SSR/share surfaces, not the removed interactive web library.
