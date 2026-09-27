import {
  BACKGROUND_JOB_FAMILIES,
  type BackgroundJobFamily,
  type BackgroundWorkerRole,
} from '@boardsesh/db/background-jobs';
import type { BackgroundJobFamilyModule } from './types';
import { workerProbeFamily } from './worker-probe';

export { BackgroundJobError } from './types';
export type { BackgroundJobContext, BackgroundJobFamilyModule, BackgroundJobFamilyOptions } from './types';

/** Every family, keyed by name. The `satisfies` fails the build when a name has no module. */
const FAMILY_MODULES = {
  'worker-probe': workerProbeFamily,
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
