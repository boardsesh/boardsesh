import { useEffect, useRef } from 'react';
import { InteractionManager } from 'react-native';
import { router, useSegments } from 'expo-router';
import * as Linking from 'expo-linking';
import { clearDeadLetterRecoveryNotice, readDeadLetterRecoveryNotice } from '@boardsesh/offline-sync';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { getDatabaseHandle } from '../../db/connection';
import { useOfflineSchemaReady } from '../../db/use-offline-schema-ready';
import { hasSeenOnboarding } from '../../lib/onboarding/onboarding-storage';
import { track } from '../../lib/analytics';
import { reportHandledError } from '../../lib/error-reporting';
import { decideSendRecovery, type SendRecoveryInput } from '../../lib/offline-recovery/send-recovery-decision';

type SendRecoveryGateProps = {
  /** True once auth + fonts are resolved and the splash has hidden. */
  ready: boolean;
};

// Once per JS session, not once per mount — a re-render must never push a second
// copy of the notice.
let announcedThisSession = false;

/** Test seam: put the session guard back so each case starts from a cold start. */
export function resetSendRecoverySessionForTests(): void {
  announcedThisSession = false;
}

/**
 * Tells a climber that the one-time #5335 recovery found sends of theirs that
 * never reached the server. Renders nothing.
 *
 * The recovery itself already happened, before React mounted: it is the data step
 * of schema migration 6, which requeues the rows two transport failures had
 * dead-lettered and leaves a `sync_meta` note saying how many. This component
 * only delivers that note, once, and then removes it.
 *
 * The note is cleared BEFORE the route is pushed, so the notice is shown at most
 * once ever. Losing it to a crash in that instant costs a message, not data —
 * the sends are already back on the queue and will land either way, which is the
 * cheaper failure than telling somebody twice.
 *
 * The decision lives in `decideSendRecovery`, a pure function, so the policy is
 * unit-tested without a renderer. Everyone with nothing to recover — which is
 * almost everyone, and every fresh install — reads one `sync_meta` row and stops.
 */
export function SendRecoveryGate({ ready }: SendRecoveryGateProps) {
  const segments = useSegments();
  // Latest top-level segment for the async re-check, without re-running the
  // effect on every navigation — the gate decides once per launch.
  const topSegmentRef = useRef<string | undefined>(segments[0]);
  topSegmentRef.current = segments[0];

  const schemaReady = useOfflineSchemaReady();

  useEffect(() => {
    if (announcedThisSession) return;

    const sharedInput = {
      ready,
      schemaReady,
      screenshotMode: process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1',
      topSegment: topSegmentRef.current,
    } satisfies Omit<SendRecoveryInput, 'launchedByDeepLink' | 'onboardingSeen' | 'recoveredCount'>;

    // First pass with optimistic stand-ins for the values only readable
    // asynchronously. `wait` leaves the guard unset so the effect runs again
    // when its deps change.
    const preflight = decideSendRecovery({
      ...sharedInput,
      launchedByDeepLink: false,
      onboardingSeen: true,
      recoveredCount: 1,
    });
    if (preflight === 'wait') return;
    announcedThisSession = true;
    if (preflight === 'none') return;

    let cancelled = false;
    const interaction = InteractionManager.runAfterInteractions(() => {
      void (async () => {
        const db = getDatabaseHandle();
        // No handle means the schema-ready flag and the connection disagree, which
        // resolves itself on a later launch. The note is durable; nothing is lost.
        if (db === null) return;

        let recoveredCount: number | null = null;
        try {
          recoveredCount = await readDeadLetterRecoveryNotice(db);
        } catch (error) {
          reportHandledError(error, { tags: { source: 'offline-sync', op: 'read-recovery-notice' } });
          return;
        }
        if (cancelled || recoveredCount === null) return;

        // A custom-scheme deep link that resolves INTO a tab lands with
        // segments[0] === '(tabs)', so the segment guard alone misses it. The
        // cold-start launch URL is the reliable signal that the climber has
        // intent elsewhere; a plain launch returns null.
        let launchUrl: string | null = null;
        try {
          launchUrl = await Linking.getInitialURL();
        } catch {
          launchUrl = null;
        }
        if (cancelled) return;

        const onboardingSeen = await hasSeenOnboarding();
        if (cancelled) return;

        // Re-decide against the CURRENT route: a deep link may have arrived
        // while the reads were in flight.
        const decision = decideSendRecovery({
          ...sharedInput,
          topSegment: topSegmentRef.current,
          launchedByDeepLink: launchUrl !== null,
          onboardingSeen,
          recoveredCount,
        });
        if (decision !== 'show') return;

        // Cleared before navigating, for the same reason the QA brief marks
        // itself seen before it pushes: a climber who dismisses the notice and
        // relaunches has already been told.
        try {
          await clearDeadLetterRecoveryNotice(db);
        } catch (error) {
          // Telling them twice is worse than not telling them at all here — the
          // sends are on the queue regardless — so a failed clear stops the push.
          reportHandledError(error, { tags: { source: 'offline-sync', op: 'clear-recovery-notice' } });
          return;
        }
        if (cancelled) return;

        track(SHARED_EVENTS.OfflineSendRecoveryShown, { recoveredCount });
        router.push({ pathname: '/send-recovery', params: { count: String(recoveredCount) } });
      })();
    });

    return () => {
      cancelled = true;
      interaction.cancel();
    };
  }, [ready, schemaReady]);

  return null;
}
