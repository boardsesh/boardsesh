export {
  syncKilterUserData,
  // Exported for the real-Postgres tests in packages/backend: log mutation
  // serialization, the ratings conflict clause (created_at from upstream +
  // the setWhere change guard), and the REMOVE soft-detach
  // (backend/src/__tests__/climb-ratings-remove-detach.test.ts) can only be
  // verified against an actual database. The package only exposes the '.'
  // and './sync' subpaths, so a deep import into user-sync isn't an option.
  applyLogs,
  applyClimbRatings,
  // Same reason: the legacy-playlist adoption in applyCircuits (#4707) turns on
  // how Postgres treats NULLs in the global `playlists_kilter_id_idx` unique,
  // which only a real database reproduces.
  applyCircuits,
  type SyncKilterUserDataArgs,
  type SyncKilterUserDataResult,
  type ApplyCircuitsResult,
} from './user-sync';
export { fingerprintFromHolds, type HoldTuple } from './fingerprint';
export { pushKilterUserData, type PushBackArgs } from './push-back';

// Catalog (Flow A) sync. The public climb catalog is pulled over REST per
// product layout (api/kilter-rest), deduped against the existing board_*
// catalog by UUID then hold fingerprint, and reconciled into board_climbs /
// board_climb_stats. Reference tables come over PowerSync (reference-pull).
export { syncKilterCatalog, type SyncKilterCatalogArgs, type KilterCatalogSummary } from './catalog-sync';
export {
  repairKilterCatalogStats,
  type KilterStatsRepairArgs,
  type KilterStatsRepairSummary,
  type KilterStatsRepairTopRow,
} from './stats-repair';
export { pullKilterReference, type KilterReferencePull } from './reference-pull';
export { buildLayoutResolver, type LayoutResolver } from './layout-resolver';
export {
  buildKilterLocationRecords,
  syncKilterLocations,
  type BuildKilterLocationRecordsResult,
} from './locations-sync';
export {
  decodeGripsClimbConcat,
  isKilterSkipReason,
  KILTER_SKIP_REASONS,
  type GripsDecodeResult,
  type KilterSkipReason,
} from './catalog-parse';
// Climbs the catalog read but could not ingest, kept with their raw upstream
// payload so an encoding change is visible instead of silent (issue #3523).
export { loadBacklog, summarizeSkipReasons, type ClimbIngestSkip } from './catalog-backlog';
export { reconcileDeletions, type DeletionReport } from './deletions';
export { createSetterSyncNotifications, type NewClimbInfo } from './notifications';
