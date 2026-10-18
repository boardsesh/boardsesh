import type { ReactNode } from 'react';
import { DevScenarioOverrides } from './DevScenarioOverrides';

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

/** The story index and story screens, or `null` in a production bundle. */
export function loadStoryScreens(): typeof import('./screens') | null {
  return __DEV__ ? (require('./screens') as typeof import('./screens')) : null;
}
