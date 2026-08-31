import { useEffect, useRef, useState } from 'react';
import { router, useSegments } from 'expo-router';
import * as Linking from 'expo-linking';
import { hasSeenOnboarding, markOnboardingSeen } from '../../lib/onboarding/onboarding-storage';
import { DEEP_LINK_SEGMENTS } from '../../lib/deep-link-segments';
import { useProfile } from '../../lib/graphql/hooks';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { reportError } from '../../lib/error-reporting';
import { BoardLookStepGate } from '../board-look/BoardLookStepGate';

type OnboardingGateProps = {
  /** True once auth + fonts are resolved and the splash has hidden. */
  ready: boolean;
};

/**
 * First-run gate. Once the app is ready (auth + fonts loaded, splash hidden) it
 * pushes the onboarding route unless the climber already has a board bound.
 * Renders nothing. Mounting it below AuthProvider means it only runs for an
 * authenticated session — an unauthenticated cold start is redirected to login
 * by the auth gate, and the walkthrough shows after they sign in.
 *
 * **The gate is "has a board", not "has seen the tour"** (issue #4961). The flow
 * is mandatory and its whole job is to leave the climber with a bound board, so
 * the absence of one is the only honest signal that it has not done its job.
 * Keying on the seen flag alone had a real hole: on iOS that flag lives in
 * SecureStore, which survives an uninstall, while the active board lives in
 * AsyncStorage, which does not — so a reinstall landed on empty states with no
 * board and no way back to the picker.
 *
 * The seen flag is still written (by `useActivateBoard`, on every bind path), and
 * backfilled here for climbers who bound a board before this gate existed. It is
 * now a record of completion rather than the gate itself.
 *
 * The decision is keyed on the signed-in profile id, not the app process: on a
 * shared device a user can sign out and a different user sign in without a
 * relaunch, and the new account gets its own first-run check.
 */
export function OnboardingGate({ ready }: OnboardingGateProps) {
  const segments = useSegments();
  // Latest top-level segment for the async check, without re-running the effect
  // on every navigation — the gate decides once per app launch.
  const topSegmentRef = useRef<string | undefined>(segments[0]);
  topSegmentRef.current = segments[0];
  const decidedRef = useRef(false);

  // The gate decides once per signed-in account, not once per app process. On a
  // shared device a user can sign out and a DIFFERENT user can sign in without a
  // relaunch; keying the decision on the profile id lets the new account get its
  // own first-run check. `undefined` while the profile loads — we only reset the
  // decision on a transition between two concrete ids.
  const { data: profile } = useProfile();
  const userId = profile?.id;
  const decidedForUserRef = useRef<string | undefined>(userId);
  // Whether the tour has finished evaluating — which is all the board-look step
  // below has to wait for, in EITHER direction. It deliberately does not latch
  // on "the tour is showing": on a fresh install the tour hands off to the board
  // picker, and the board-look step is meant to appear when the climber comes
  // back with a board bound. What keeps the two from overlapping is the route
  // guard (`onboarding` and `boards` are both blocked segments), not this flag.
  const [tourEvaluated, setTourEvaluated] = useState(false);
  if (userId !== undefined && userId !== decidedForUserRef.current) {
    decidedForUserRef.current = userId;
    decidedRef.current = false;
  }

  // The gate's real input. `isFetched` is load-bearing: `data` is `undefined`
  // while the AsyncStorage read is in flight, which is indistinguishable from
  // "no board" and would flash the tour at every climber on every cold start.
  // Read through a ref inside the effect so a board bound LATER in the session
  // (the picker, a Bluetooth adopt) doesn't re-run a decision already made.
  const { data: activeBoard, isFetched: boardResolved } = useActiveBoard();
  const hasBoardRef = useRef(activeBoard != null);
  hasBoardRef.current = activeBoard != null;

  useEffect(() => {
    if (!ready || !boardResolved || decidedRef.current) return;
    // Screenshot builds never auto-present the tour: the app-store flow needs to
    // reach the tabs, and the onboarding-capture flow opens /onboarding itself.
    // Nothing else auto-presents in a capture run either, so this stays `pending`.
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return;
    decidedRef.current = true;

    let cancelled = false;
    void (async () => {
      // `tourEvaluated` is published in a `finally`, so EVERY exit — including a
      // cancellation — reports that the tour has had its turn.
      //
      // It used to be set at each `return` instead, and that wedged the
      // board-look step permanently: `useProfile()` resolves a tick after mount,
      // `userId` changes, this effect re-runs, its cleanup sets `cancelled`, the
      // in-flight run bails at a `if (cancelled) return` without publishing, and
      // the re-run then hits the `decidedRef.current` guard above and returns
      // immediately. Nothing ever set the flag again, so the step below waited
      // on it forever.
      try {
        // Don't interrupt a deep-link / auth / share landing on a non-tab group.
        if (topSegmentRef.current && DEEP_LINK_SEGMENTS.has(topSegmentRef.current)) return;

        // A custom-scheme deep link that resolves INTO a tab (e.g.
        // com.boardsesh.app://climbs/...) lands with segments[0] === '(tabs)', so
        // the segment guard above doesn't catch it and onboarding would cover the
        // intended destination. The cold-start launch URL is the reliable signal:
        // if the app was opened by ANY deep link, the user has explicit intent —
        // don't auto-present the tour over it. A plain launch returns null here,
        // so normal first-run (show once) is untouched.
        let initialUrl: string | null = null;
        try {
          initialUrl = await Linking.getInitialURL();
        } catch {
          initialUrl = null;
        }
        if (cancelled || initialUrl) return;

        // A bound board means the flow has already done its job, however the
        // climber got there — the picker, the builder, a Bluetooth adopt, or a
        // build that predates this gate. Backfill the seen flag for that last
        // group so it stays a truthful record of completion.
        if (hasBoardRef.current) {
          const seen = await hasSeenOnboarding();
          if (cancelled || seen) return;
          markOnboardingSeen().catch((error: unknown) => {
            // eslint-disable-next-line no-console
            console.warn('[onboarding] Failed to backfill "seen" flag', error);
            reportError(error);
          });
          return;
        }

        // Re-check the route after the async reads — a deep link may have arrived
        // in the meantime — so we never cover an intentional destination.
        if (cancelled || (topSegmentRef.current && DEEP_LINK_SEGMENTS.has(topSegmentRef.current))) return;
        router.push('/onboarding');
      } finally {
        setTourEvaluated(true);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `userId` is here so the effect re-runs after a sign-out/sign-in resets
    // `decidedRef` above — the new account gets its own first-run evaluation.
  }, [ready, boardResolved, userId]);

  return <BoardLookStepGate ready={ready} tourDecided={tourEvaluated} />;
}
