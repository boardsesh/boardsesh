import {
  BACKGROUND_JOB_FAMILIES,
  type BackgroundJobFamily,
  type BackgroundWorkerRole,
} from '@boardsesh/db/background-jobs';
import type { BackgroundJobFamilyModule } from './types';
import { exportBoardSnapshotsFamily } from './export-board-snapshots';
import { refreshClimbGradesFamily } from './refresh-climb-grades';
import { refreshClimbNeighborsFamily } from './refresh-climb-neighbors';
import { refreshHoldFeaturesFamily } from './refresh-hold-features';
import { refreshMoonboardAngleEstimatesFamily } from './refresh-moonboard-angle-estimates';
import { refreshMoonboardWideAngleEstimatesFamily } from './refresh-moonboard-wide-angle-estimates';
import { refreshRecommendationsFamily } from './refresh-recommendations';
import { workerProbeFamily } from './worker-probe';

export { BackgroundJobError } from './types';
export type { BackgroundJobContext, BackgroundJobFamilyModule, BackgroundJobFamilyOptions } from './types';

/** Every family, keyed by name. The `satisfies` fails the build when a name has no module. */
const FAMILY_MODULES = {
  'worker-probe': workerProbeFamily,
  'refresh-recommendations': refreshRecommendationsFamily,
  'refresh-hold-features': refreshHoldFeaturesFamily,
  'refresh-climb-grades': refreshClimbGradesFamily,
  'refresh-climb-neighbors': refreshClimbNeighborsFamily,
  'export-board-snapshots': exportBoardSnapshotsFamily,
  'refresh-moonboard-angle-estimates': refreshMoonboardAngleEstimatesFamily,
  'refresh-moonboard-wide-angle-estimates': refreshMoonboardWideAngleEstimatesFamily,
} satisfies Record<BackgroundJobFamily, BackgroundJobFamilyModule>;

const registry: ReadonlyMap<string, BackgroundJobFamilyModule> = new Map(
  BACKGROUND_JOB_FAMILIES.map((name): [string, BackgroundJobFamilyModule] => [name, FAMILY_MODULES[name]]),
);

export function findFamily(name: string): BackgroundJobFamilyModule | undefined {
  return registry.get(name);
}

export function requireFamily(name: string): BackgroundJobFamilyModule {
  const family = registry.get(name);
  if (!family) throw new Error('UNKNOWN_FAMILY');
  return family;
}

export function familiesForRole(role: BackgroundWorkerRole): BackgroundJobFamilyModule[] {
  return [...registry.values()].filter((family) => family.roles.includes(role));
}

export function allFamilies(): BackgroundJobFamilyModule[] {
  return [...registry.values()];
}
