import { useEffect, useRef, useState } from 'react';
import { router, useSegments } from 'expo-router';
import * as Linking from 'expo-linking';
import { hasSeenOnboarding } from '../../lib/onboarding/onboarding-storage';
import { DEEP_LINK_SEGMENTS } from '../../lib/deep-link-segments';
import { useProfile } from '../../lib/graphql/hooks';
import { BoardLookStepGate } from '../board-look/BoardLookStepGate';

type OnboardingGateProps = {
  /** True once auth + fonts are resolved and the splash has hidden. */
  ready: boolean;
};

/**
 * First-run gate. Once the app is ready (auth + fonts loaded, splash hidden) it
 * reads the persisted "seen" flag; if the walkthrough is unseen and the user
 * isn't mid deep-link / auth flow, it pushes the onboarding route once. Renders
 * nothing. Mounting it below AuthProvider means it only runs for an
 * authenticated session — an unauthenticated cold start is redirected to login
 * by the auth gate, and the walkthrough shows after they sign in.
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

  useEffect(() => {
    if (!ready || decidedRef.current) return;
    // Screenshot builds never auto-present the tour: the app-store flow needs to
    // reach the tabs, and the onboarding-capture flow opens /onboarding itself.
    // Nothing else auto-presents in a capture run either, so this stays `pending`.
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return;
    decidedRef.current = true;

    let cancelled = false;
    void (async () => {
      // Don't interrupt a deep-link / auth / share landing on a non-tab group.
      if (topSegmentRef.current && DEEP_LINK_SEGMENTS.has(topSegmentRef.current)) {
        setTourEvaluated(true);
        return;
      }

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
      if (cancelled) return;
      if (initialUrl) {
        setTourEvaluated(true);
        return;
      }

      const seen = await hasSeenOnboarding();
      if (cancelled) return;
      if (seen) {
        setTourEvaluated(true);
        return;
      }
      // Re-check the route after the async reads — a deep link may have arrived
      // in the meantime — so we never cover an intentional destination.
      if (topSegmentRef.current && DEEP_LINK_SEGMENTS.has(topSegmentRef.current)) {
        setTourEvaluated(true);
        return;
      }
      setTourEvaluated(true);
      router.push('/onboarding');
    })();

    return () => {
      cancelled = true;
    };
    // `userId` is here so the effect re-runs after a sign-out/sign-in resets
    // `decidedRef` above — the new account gets its own first-run evaluation.
  }, [ready, userId]);

  return <BoardLookStepGate ready={ready} tourDecided={tourEvaluated} />;
}
