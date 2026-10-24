import { useSyncExternalStore, type ReactNode } from 'react';
import { DevScenarioOverrides } from './DevScenarioOverrides';
import { getScenarioOverrides, subscribeScenarioOverrides, type ScenarioOverrides } from './scenario-overrides';

/**
 * The only door from app code into the story harness.
 *
 * The story screens, the registry and every `*.stories.tsx` file sit behind the
 * `__DEV__` require below. Metro folds `__DEV__` to `false` in a production
 * bundle before it collects dependencies, so none of them reach a store build or
 * an OTA update. `vp run check:mobile-bundle` fails if they ever do.
 *
 * The overrides provider is a plain import: it is ~70 lines with no fixtures,
 * and Node's `require` (which the unit tests run under) can't load a `.tsx`
 * file. Production gets the pass-through instead of it.
 */

function PassThrough({ children }: { children: ReactNode }) {
  return children;
}

/** Patches the live values a scenario story fakes. A pass-through in production. */
export const DevScenarioOverridesHost: (props: { children: ReactNode }) => ReactNode = __DEV__
  ? DevScenarioOverrides
  : PassThrough;

/** Who a story says holds the wall (`ScenarioOverrides.wall`). */
export type DevScenarioWall = NonNullable<ScenarioOverrides['wall']>;

const getScenarioWall = (): DevScenarioWall | null => getScenarioOverrides()?.wall ?? null;

function useScenarioWallFromStories(): DevScenarioWall | null {
  return useSyncExternalStore(subscribeScenarioOverrides, getScenarioWall, getScenarioWall);
}

function noScenarioWall(): DevScenarioWall | null {
  return null;
}

/**
 * A story's fake wall holder, for the wall-driver rule (the rest timer's crew
 * stories, #5382). Always null in production, where no story ever runs.
 */
export const useDevScenarioWall: () => DevScenarioWall | null = __DEV__ ? useScenarioWallFromStories : noScenarioWall;

/** The story index and story screens, or `null` in a production bundle. */
export function loadStoryScreens(): typeof import('./screens') | null {
  return __DEV__ ? (require('./screens') as typeof import('./screens')) : null;
}
