// When to sweep the on-disk board-art cache (issue #3647).
//
// The native modules already enforce a 200 MB cap, but behind a
// once-per-module-lifetime gate — so it only ever runs on a cold launch. The
// failure mode the issue names is the opposite of that: a session that stays in
// the foreground and grows. This repo has already met that shape once, in
// `useIpadTabSwitchImageCacheSweep`, written because "an iPad kept open for days
// never backgrounds" (#3803, ~3.7 days uptime).
//
// So the trigger set is deliberately three-legged:
//
//   launch      — reclaims whatever the last session left, deferred past the
//                 opening animation, WITH a fallback timer because
//                 `runAfterInteractions` can be starved indefinitely (the same
//                 reason use-deferred-after-interactions pairs the two).
//   background  — the natural seam; costs the user nothing.
//   writes      — the foreground leg the other two miss. The overlay index
//                 counts writes and fires once per OVERLAY_WRITES_PER_SWEEP,
//                 which tracks growth rather than the clock.
//
// Snapshot leftovers are swept once at launch only: they are orphaned by a kill,
// so nothing new appears mid-session.

import { useEffect, useRef } from 'react';
import { InteractionManager } from 'react-native';
import { useIsAppBackgrounded } from '../lib/app-visibility';
import { OVERLAY_WRITES_PER_SWEEP } from '../lib/cache-sweep-plan';
import { onOverlayWriteThreshold } from '../lib/overlay-index';
import { sweepBoardArtCache, sweepSnapshotLeftovers, type CacheSweepTrigger } from '../lib/sweep-caches';
import { reportHandledError } from '../lib/error-reporting';

/** Matches use-deferred-after-interactions' fallback: a starved queue must not mean "never". */
const LAUNCH_DEFER_FALLBACK_MS = 2_000;

function runSweep(trigger: CacheSweepTrigger): void {
  void sweepBoardArtCache({ trigger }).catch((error: unknown) => {
    // A sweep is best-effort housekeeping. Worth knowing about if it fails
    // persistently (the cap stops being enforced) but never worth a crash.
    reportHandledError(error, { tags: { source: 'offline-sync', kind: 'cache-sweep' } });
  });
}

export function useDiskCacheSweep(): void {
  const isBackgrounded = useIsAppBackgrounded();
  const hasSweptOnLaunch = useRef(false);

  useEffect(() => {
    if (hasSweptOnLaunch.current) return;
    let settled = false;
    const sweepOnce = () => {
      if (settled) return;
      settled = true;
      hasSweptOnLaunch.current = true;
      runSweep('launch');
      void sweepSnapshotLeftovers().catch((error: unknown) => {
        reportHandledError(error, { tags: { source: 'offline-sync', kind: 'snapshot-leftover-sweep' } });
      });
    };

    const interaction = InteractionManager.runAfterInteractions(sweepOnce);
    const fallback = setTimeout(sweepOnce, LAUNCH_DEFER_FALLBACK_MS);
    return () => {
      interaction.cancel();
      clearTimeout(fallback);
    };
  }, []);

  useEffect(() => {
    // Gates on the flag VALUE, so returning to the foreground doesn't sweep again.
    if (isBackgrounded) runSweep('background');
  }, [isBackgrounded]);

  useEffect(() => {
    return onOverlayWriteThreshold(OVERLAY_WRITES_PER_SWEEP, () => {
      runSweep('write-threshold');
    });
  }, []);
}
