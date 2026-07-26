export { syncKilterUserData, type SyncKilterUserDataArgs } from './user-sync';
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
