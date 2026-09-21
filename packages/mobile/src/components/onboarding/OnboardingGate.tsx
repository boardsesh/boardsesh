import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useSegments } from 'expo-router';
import * as Linking from 'expo-linking';
import { hasSeenOnboarding, markOnboardingSeen } from '../../lib/onboarding/onboarding-storage';
import { DEEP_LINK_SEGMENTS } from '../../lib/deep-link-segments';
import { useProfile } from '../../lib/graphql/hooks';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { reportError } from '../../lib/error-reporting';
import { startForegroundWatchdog } from '../../lib/onboarding/foreground-watchdog';
import {
  trackOnboardingGateEvaluated,
  type OnboardingGateEvaluation,
  type OnboardingGateTrigger,
} from '../../lib/onboarding/onboarding-gate-analytics';
import { useLaunchReady } from '../../providers/launch-ready-context';
import { BoardLookStepGate } from '../board-look/BoardLookStepGate';

/**
 * How much FOREGROUND time the gate gets to reach a decision before it reports
 * itself stalled. Deciding normally takes well under a second after the splash.
 */
export const ONBOARDING_GATE_STALL_MS = 15_000;

// The first gate mount in this JS process is the cold start; any later one is a
// remount (signing in swaps AuthProvider's children, which remounts the gate).
let mountedThisProcess = false;

/** Test seam: make the next mount read as a cold start again. */
export function resetOnboardingGateProcessForTests(): void {
  mountedThisProcess = false;
}

/** The parts of an evaluation a decision supplies; the gate fills in the rest. */
type GateDecision = Pick<OnboardingGateEvaluation, 'outcome' | 'reason' | 'step' | 'hadBoard' | 'seenFlag'>;

/**
 * First-run gate. Once the app is ready (auth + fonts loaded, splash hidden) it
 * decides whether the climber needs the onboarding route: yes unless a board is
 * already bound. Renders nothing itself. Mounting it below AuthProvider means it
 * only decides for an authenticated session; an unauthenticated cold start is
 * redirected to login by the auth gate, and the gate decides after sign-in.
 *
 * **It decides and logs, and presents nothing (#5654).** From 2.2.0 this gate
 * never ran: its `ready` prop was frozen at false behind `DatabaseProvider` (see
 * `launch-ready-context.tsx`). Waking it back up would have dropped every
 * existing climber without a board into a mandatory flow they never saw, in one
 * fleet-wide OTA. So it reports `would_present` through `Onboarding Gate
 * Evaluated` instead of pushing, and the first-run redesign decides who actually
 * gets a flow. The event also carries a 15 s stall watchdog, so a gate that
 * never decides can no longer go unnoticed.
 *
 * **The gate is "has a board", not "has seen the tour"** (issue #4961). The flow's
 * whole job is to leave the climber with a bound board, so the absence of one is
 * the only honest signal that it has not done its job. Keying on the seen flag
 * alone had a real hole: on iOS that flag lives in SecureStore, which survives an
 * uninstall, while the active board lives in AsyncStorage, which does not.
 *
 * The seen flag is still written (by `useActivateBoard`, on every bind path), and
 * backfilled here for climbers who bound a board before this gate existed. It is
 * a record of completion rather than the gate itself.
 *
 * The decision is keyed on the signed-in account, not the app process: on a
 * shared device a user can sign out and a different user sign in, and the new
 * account gets its own first-run check.
 */
export function OnboardingGate() {
  const ready = useLaunchReady();
  const segments = useSegments();
  // Latest top-level segment for the async check, without re-running the effect
  // on every navigation — the gate decides once per app launch.
  const topSegmentRef = useRef<string | undefined>(segments[0]);
  topSegmentRef.current = segments[0];
  const decidedRef = useRef(false);
  const triggerRef = useRef<OnboardingGateTrigger>('cold_start');
  const mountedAtRef = useRef(0);
  const stopWatchdogRef = useRef<(() => void) | null>(null);

  // The gate decides once per signed-in account. `undefined` while the profile
  // loads, and the profile landing for the account already on screen is not a
  // new account: only a transition between two concrete ids re-decides.
  const { data: profile } = useProfile();
  const userId = profile?.id;
  const accountCreatedAtRef = useRef(profile?.createdAt);
  accountCreatedAtRef.current = profile?.createdAt;
  const decidedForUserRef = useRef<string | undefined>(userId);
  // Whether the tour has finished evaluating — which is all the board-look step
  // below has to wait for, in EITHER direction. It deliberately does not latch
  // on "the tour is showing": on a fresh install the tour hands off to the board
  // picker, and the board-look step is meant to appear when the climber comes
  // back with a board bound. What keeps the two from overlapping is the route
  // guard (`onboarding` and `boards` are both blocked segments), not this flag.
  const [tourEvaluated, setTourEvaluated] = useState(false);
  if (userId !== undefined && userId !== decidedForUserRef.current) {
    const switchedAccount = decidedForUserRef.current !== undefined;
    decidedForUserRef.current = userId;
    if (switchedAccount) {
      decidedRef.current = false;
      triggerRef.current = 'account_switch';
    }
  }

  // Only a successful storage read can confirm that no board is bound.
  // `isFetched` also turns true after a failed read; treating that failure as
  // a missing board sends a returning climber through setup again.
  // Read through a ref inside the effect so a board bound LATER in the session
  // (the picker, a Bluetooth adopt) doesn't re-run a decision already made.
  const { data: activeBoard, isSuccess: boardResolved } = useActiveBoard();
  const hasBoardRef = useRef(activeBoard != null);
  hasBoardRef.current = activeBoard != null;
  // Mirrors for the watchdog, which fires from a timer and has to say which
  // input was still missing at that moment.
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const boardResolvedRef = useRef(boardResolved);
  boardResolvedRef.current = boardResolved;

  // Declared before the decision effect so it runs first: a decision that lands
  // synchronously (a deep-link segment) must find the watchdog already armed.
  useEffect(() => {
    mountedAtRef.current = Date.now();
    triggerRef.current = mountedThisProcess ? 'remount' : 'cold_start';
    mountedThisProcess = true;
    // Screenshot builds never decide (below), so a stall there means nothing.
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return;

    const stopWatchdog = startForegroundWatchdog({
      timeoutMs: ONBOARDING_GATE_STALL_MS,
      appState: AppState,
      onExpire: () => {
        let reason: OnboardingGateEvaluation['reason'] = 'reads_pending';
        if (!readyRef.current) reason = 'not_ready';
        else if (!boardResolvedRef.current) reason = 'board_unresolved';
        trackOnboardingGateEvaluated({
          outcome: 'stalled',
          reason,
          step: null,
          hadBoard: boardResolvedRef.current ? hasBoardRef.current : null,
          seenFlag: null,
          accountCreatedAt: accountCreatedAtRef.current,
          trigger: triggerRef.current,
          topSegment: topSegmentRef.current,
          msSinceMount: Date.now() - mountedAtRef.current,
        });
      },
    });
    stopWatchdogRef.current = stopWatchdog;
    return () => {
      stopWatchdogRef.current = null;
      stopWatchdog();
    };
  }, []);

  useEffect(() => {
    if (!ready || !boardResolved || decidedRef.current) return;
    // Screenshot builds never auto-present the tour: the app-store flow needs to
    // reach the tabs, and the onboarding-capture flow opens /onboarding itself.
    // Nothing else auto-presents in a capture run either, so this stays `pending`.
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return;
    decidedRef.current = true;

    let cancelled = false;
    let decided = false;
    const decide = (decision: GateDecision) => {
      decided = true;
      stopWatchdogRef.current?.();
      trackOnboardingGateEvaluated({
        ...decision,
        accountCreatedAt: accountCreatedAtRef.current,
        trigger: triggerRef.current,
        topSegment: topSegmentRef.current,
        msSinceMount: Date.now() - mountedAtRef.current,
      });
    };

    void (async () => {
      // `tourEvaluated` is published in a `finally`, so EVERY exit — including a
      // cancellation — reports that the tour has had its turn.
      //
      // It used to be set at each `return` instead, and that wedged the
      // board-look step permanently: a cancelled run bailed without publishing,
      // and the re-run then hit the `decidedRef.current` guard and returned
      // immediately. Nothing ever set the flag again, so the step below waited
      // on it forever.
      try {
        // Don't interrupt a deep-link / auth / share landing on a non-tab group.
        if (topSegmentRef.current && DEEP_LINK_SEGMENTS.has(topSegmentRef.current)) {
          decide({
            outcome: 'skipped',
            reason: 'deep_link_segment',
            step: null,
            hadBoard: hasBoardRef.current,
            seenFlag: null,
          });
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
          // The URL itself is never sent: only that there was one.
          decide({
            outcome: 'skipped',
            reason: 'launched_by_url',
            step: null,
            hadBoard: hasBoardRef.current,
            seenFlag: null,
          });
          return;
        }

        const seen = await hasSeenOnboarding();
        if (cancelled) return;

        // A bound board means the flow has already done its job, however the
        // climber got there — the picker, the builder, a Bluetooth adopt, or a
        // build that predates this gate. Backfill the seen flag for that last
        // group so it stays a truthful record of completion.
        if (hasBoardRef.current) {
          if (!seen) {
            markOnboardingSeen().catch((error: unknown) => {
              // eslint-disable-next-line no-console
              console.warn('[onboarding] Failed to backfill "seen" flag', error);
              reportError(error);
            });
          }
          decide({ outcome: 'skipped', reason: 'has_board', step: null, hadBoard: true, seenFlag: seen });
          return;
        }

        // Re-check the route after the async reads — a deep link may have arrived
        // in the meantime — so we never cover an intentional destination.
        if (topSegmentRef.current && DEEP_LINK_SEGMENTS.has(topSegmentRef.current)) {
          decide({ outcome: 'skipped', reason: 'segment_after_reads', step: null, hadBoard: false, seenFlag: seen });
          return;
        }

        // Someone who has already been through the framing card would start at
        // the board step: a sign-out, a token expiry and a remote sign-out all
        // clear the device-wide active board (`clearPersistedUserStores`), and a
        // re-login should not re-teach why a named board matters.
        //
        // Logged, not presented (#5654). The push this replaced was
        // `router.push(seen ? { pathname: '/onboarding', params: { step: 'board' } } : '/onboarding')`.
        decide({
          outcome: 'would_present',
          reason: 'no_board',
          step: seen ? 'board' : 'intro',
          hadBoard: false,
          seenFlag: seen,
        });
      } finally {
        setTourEvaluated(true);
      }
    })();

    return () => {
      cancelled = true;
      // A run cancelled before it decided (the profile landing mid-read re-runs
      // this effect) has decided nothing, so the re-run must be allowed through.
      // Latching `decidedRef` here used to strand the gate undecided for the
      // rest of the launch.
      if (!decided) decidedRef.current = false;
    };
    // `userId` is here so the effect re-runs after an account switch resets
    // `decidedRef` above — the new account gets its own first-run evaluation.
  }, [ready, boardResolved, userId]);

  // The board-look step is evaluated and logged too, never presented (#5654).
  return <BoardLookStepGate ready={ready} tourDecided={tourEvaluated} present={false} />;
}
