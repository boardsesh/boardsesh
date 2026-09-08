import { useLayoutEffect } from 'react';
import { markStartup } from './startup-profile';
import type { StartupOutcome } from './startup-collector';

/** Mounted beside the actual row/empty state, never beside a loading placeholder. */
export function HomeStartupCommit({ outcome }: { outcome: StartupOutcome | null }) {
  useLayoutEffect(() => {
    if (outcome) markStartup('home.useful.commit', outcome);
  }, [outcome]);
  return null;
}
