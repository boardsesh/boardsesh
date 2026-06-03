export { syncKilterUserData, type SyncKilterUserDataArgs } from './user-sync';
export { fingerprintFromHolds, type HoldTuple } from './fingerprint';
export { pushKilterUserData, type PushBackArgs } from './push-back';

// Catalog (Flow A) sync. The public climb catalog is pulled over REST per
// product layout (api/kilter-rest), deduped against the existing board_*
// catalog by UUID then hold fingerprint, and reconciled into board_climbs /
// board_climb_stats. Reference tables come over PowerSync (reference-pull).
export { syncKilterCatalog, type SyncKilterCatalogArgs, type KilterCatalogSummary } from './catalog-sync';
export { pullKilterReference, type KilterReferencePull } from './reference-pull';
export { buildLayoutResolver, type LayoutResolver } from './layout-resolver';
export { gripsClimbConcatToFrames, framesToHolds, fingerprintFrames } from './catalog-parse';
export { reconcileDeletions, type DeletionReport } from './deletions';
export { createSetterSyncNotifications, type NewClimbInfo } from './notifications';
