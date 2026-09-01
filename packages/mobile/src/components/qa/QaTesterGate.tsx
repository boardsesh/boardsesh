import { useEffect, useRef } from 'react';
import { InteractionManager } from 'react-native';
import { router, useSegments } from 'expo-router';
import * as Linking from 'expo-linking';
import * as Updates from 'expo-updates';
import { hasSeenOnboarding } from '../../lib/onboarding/onboarding-storage';
import { useProfile } from '../../lib/graphql/hooks';
import { useOtaBranchSurfingState } from '../../lib/ota-branch-surfing-state';
import { getSetting, setSetting } from '../../settings';
import { track } from '../../lib/analytics';
import { reportHandledError } from '../../lib/error-reporting';
import { decideQaGate, type QaGateInput } from '../../lib/qa/qa-gate-decision';
import { listPrBranches, readRunningPrNumber } from '../../lib/qa/qa-surf';
import { qaSessionKey } from '../../lib/qa/qa-keys';
import { prBranchName } from '../../lib/qa/pr-branch';
import { LAUNCH_ORIGIN, QA_BRIEF_SHOWN_EVENT, QA_PREVIEW_PROMPTED_EVENT } from '../../lib/qa/qa-analytics';

type QaTesterGateProps = {
  /** True once auth + fonts are resolved and the splash has hidden. */
  ready: boolean;
};

// Once per JS session, not once per mount. A cold start is a new session, and so
// is the reload a surf performs — which is exactly right: the tester lands on the
// preview and the gate immediately shows them what to test.
let promptedThisSession = false;

/** Test seam: put the session guard back so each case starts from a cold start. */
export function resetQaGateSessionForTests(): void {
  promptedThisSession = false;
}

/**
 * Launch-time gate for crowdsourced QA (see `docs/crowdsourced-qa-mobile.md`).
 * Renders nothing.
 *
 * On a store / TestFlight build that can surf OTA branches, a tester is asked
 * once per cold start either to pick a PR preview (when running production) or
 * to read the test plan for the preview they are already on. Everyone else —
 * every non-tester, every dev client, every build without the surfing headers —
 * sees nothing, ever.
 *
 * The decision itself lives in `decideQaGate`, a pure function, so the policy is
 * unit-tested without a renderer. This component is only the plumbing: it reads
 * the synchronous signals, bails out early when they already say "no", and only
 * then pays for the async ones (the launch URL, the onboarding flag, and a
 * network round-trip for the branch list).
 */
export function QaTesterGate({ ready }: QaTesterGateProps) {
  const segments = useSegments();
  // Latest top-level segment for the async re-check, without re-running the
  // effect on every navigation — the gate decides once per launch.
  const topSegmentRef = useRef<string | undefined>(segments[0]);
  topSegmentRef.current = segments[0];

  const { surfingBuild, ready: surfingReady } = useOtaBranchSurfingState();

  // Like OnboardingGate: decide once per signed-in account, not once per app
  // process, so a sign-out / sign-in on a shared device re-evaluates for the new
  // user. `undefined` while the profile loads — only a transition between two
  // concrete ids resets the decision.
  const { data: profile } = useProfile();
  const userId = profile?.id;
  const decidedForUserRef = useRef<string | undefined>(userId);
  if (userId !== undefined && userId !== decidedForUserRef.current) {
    decidedForUserRef.current = userId;
    promptedThisSession = false;
  }

  useEffect(() => {
    if (promptedThisSession) return;

    const runningPrNumber = readRunningPrNumber();
    // Null until BOTH are known: the markers are account-scoped, so a key built
    // without the signed-in id would read another tester's decisions.
    const currentKey =
      runningPrNumber === null || userId === undefined
        ? null
        : qaSessionKey(userId, prBranchName(runningPrNumber), Updates.updateId);
    const sharedInput = {
      ready,
      isTester: profile?.isTester,
      userId,
      surfingBuild,
      surfingReady,
      screenshotMode: process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1',
      topSegment: topSegmentRef.current,
      runningPrNumber,
      briefSeenKey: getSetting('qaBriefSeenKey'),
      verdictSubmittedKey: getSetting('qaVerdictSubmittedKey'),
      currentKey,
    } satisfies Omit<QaGateInput, 'launchedByDeepLink' | 'onboardingSeen' | 'prBranchCount'>;

    // First pass with optimistic stand-ins for the values only readable
    // asynchronously. A non-`wait`, non-`none` answer means "none of the cheap
    // reasons to stop apply" — worth paying for the async reads. `wait` leaves
    // the guard unset so the effect runs again when its deps change.
    const preflight = decideQaGate({
      ...sharedInput,
      launchedByDeepLink: false,
      onboardingSeen: true,
      prBranchCount: 1,
    });
    if (preflight === 'wait') return;
    promptedThisSession = true;
    if (preflight === 'none') return;

    let cancelled = false;
    const interaction = InteractionManager.runAfterInteractions(() => {
      void (async () => {
        // A custom-scheme deep link that resolves INTO a tab lands with
        // segments[0] === '(tabs)', so the segment guard alone misses it. The
        // cold-start launch URL is the reliable signal that the user has intent
        // elsewhere; a plain launch returns null.
        let launchUrl: string | null = null;
        try {
          launchUrl = await Linking.getInitialURL();
        } catch {
          launchUrl = null;
        }
        if (cancelled) return;

        const onboardingSeen = await hasSeenOnboarding();
        if (cancelled) return;

        // Only production needs the branch list; on a preview the brief is about
        // the branch already running.
        let prBranchCount: number | null = null;
        let prNumbers: number[] = [];
        if (runningPrNumber === null) {
          try {
            const branches = await listPrBranches();
            prBranchCount = branches === null ? null : branches.length;
            prNumbers = branches?.map((branch) => branch.prNumber) ?? [];
          } catch (error) {
            // An unreachable update server is not the tester's problem, and a
            // failed launch prompt must never become a visible error.
            reportHandledError(error, { tags: { source: 'qa', op: 'list-branches' } });
            return;
          }
          if (cancelled) return;
        }

        // Re-decide against the CURRENT route: a deep link may have arrived
        // while the reads were in flight.
        const decision = decideQaGate({
          ...sharedInput,
          topSegment: topSegmentRef.current,
          launchedByDeepLink: launchUrl !== null,
          onboardingSeen,
          prBranchCount,
        });

        if (decision === 'pick') {
          track(QA_PREVIEW_PROMPTED_EVENT, { count: prBranchCount });
          // Hand the screen the numbers we just listed so it renders straight
          // away instead of repeating the round-trip we already paid for, and
          // mark this as the launch prompt so a dismissal counts as a skip —
          // the same screen opened by hand from the drawer must not.
          router.push({
            pathname: '/qa/pick',
            params: { prNumbers: prNumbers.join(','), origin: LAUNCH_ORIGIN },
          });
          return;
        }
        if (decision === 'brief' && runningPrNumber !== null) {
          // Written before navigating: if the tester dismisses the brief and
          // relaunches, they have already been told once, and the drawer is
          // where they go back to it.
          if (currentKey !== null) setSetting('qaBriefSeenKey', currentKey);
          track(QA_BRIEF_SHOWN_EVENT, { prNumber: runningPrNumber });
          router.push('/qa/brief');
        }
      })();
    });

    return () => {
      cancelled = true;
      interaction.cancel();
    };
    // `userId` is here so the effect re-runs after a sign-out / sign-in resets
    // the session guard above — the new account gets its own evaluation.
  }, [ready, surfingBuild, surfingReady, profile?.isTester, userId]);

  return null;
}
