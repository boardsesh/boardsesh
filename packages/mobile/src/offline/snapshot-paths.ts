// Where downloaded board artifacts live, as a constant with NO imports.
//
// A module of its own rather than a line in `snapshot-source.ts` because the
// cache sweeper (`lib/sweep-caches.ts`) needs the directory name and nothing
// else — and snapshot-source now statically imports `react-native` for
// `Platform.OS`. Under RN 0.86 that entry is Flow source, which Rolldown's
// collection-time scan cannot parse, so pulling it into the sweeper's graph
// broke four unrelated suites (see the `react-native` note in
// packages/mobile/vite.config.ts). Keep this file dependency-free.

// Cache-dir subfolder for downloaded artifacts. The engine ATTACHes the file,
// imports the scope's rows, then hands it back through `releaseArtifact`.
// Since issue #4310 a file the engine did NOT import survives to the next
// cycle, but it still lives under `Paths.cache`, not `Paths.document`: the OS
// may reclaim it under storage pressure and losing it costs a re-download,
// never data.
export const SNAPSHOT_DIR_NAME = 'board-snapshots';
