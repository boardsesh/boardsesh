import { useEffect, useRef } from 'react';
import { InteractionManager } from 'react-native';
import { router, useSegments } from 'expo-router';
import * as Linking from 'expo-linking';
import * as Updates from 'expo-updates';
import { hasSeenOnboarding } from '../../lib/onboarding/onboarding-storage';
import { useProfile } from '../../lib/graphql/hooks';
import { useOtaBranchSurfingState } from '../../lib/ota-branch-surfing-state';
import { getSetting, setSetting, useSetting } from '../../settings';
import { track } from '../../lib/analytics';
import { reportHandledError } from '../../lib/error-reporting';
import { decideQaGate, type QaGateInput } from '../../lib/qa/qa-gate-decision';
import { listPrBranches, readRunningOtaBranch, readRunningPrNumber, STAGING_OTA_BRANCH } from '../../lib/qa/qa-surf';
import { qaSessionKey } from '../../lib/qa/qa-keys';
import { prBranchName } from '../../lib/qa/pr-branch';
import { LAUNCH_ORIGIN, QA_BRIEF_SHOWN_EVENT, QA_PREVIEW_PROMPTED_EVENT } from '../../lib/qa/qa-analytics';
import { useFeatureFlagsResolved, useQaTesterGateEnabled } from '../../providers/feature-flags-provider';
import { useLaunchReady } from '../../providers/launch-ready-context';

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
 * On a store / TestFlight build that can surf OTA branches, an opted-in tester
 * is asked once per cold start either to pick a PR preview (when running
 * production) or to read the test plan for the preview they are already on.
 * Everyone else — every opted-out or non-tester account, every dev client,
 * every build without the surfing headers — sees nothing, ever.
 *
 * The decision itself lives in `decideQaGate`, a pure function, so the policy is
 * unit-tested without a renderer. This component is only the plumbing: it reads
 * the synchronous signals, bails out early when they already say "no", and only
 * then pays for the async ones (the launch URL, the onboarding flag, and a
 * network round-trip for the branch list).
 *
 * It waits on the launch-ready context and on the feature flags having resolved,
 * because `qa-tester-gate-kill` must be able to stop a push it has not made yet.
 * The gate never ran from 2.2.0 until #5654 (its `ready` prop was frozen behind
 * the database provider), which is why that switch exists at all.
 */
export function QaTesterGate() {
  const launchReady = useLaunchReady();
  const flagsResolved = useFeatureFlagsResolved();
  const enabled = useQaTesterGateEnabled();
  const [qaPromptOnLaunch] = useSetting('qaPromptOnLaunch');
  // This is a launch preference, not an immediate action. Enabling it from More
  // waits for the next cold start; disabling it remains live so it can cancel
  // deferred work that has not navigated yet.
  const promptEnabledAtLaunchRef = useRef(qaPromptOnLaunch);
  const promptEnabledForSession = promptEnabledAtLaunchRef.current && qaPromptOnLaunch;
  const ready = launchReady && flagsResolved;
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
    // Killed: stand down without spending the session guard, so nothing is
    // decided for this session on the killed flag's behalf.
    if (!enabled || promptedThisSession) return;
    // Spend this session while the personal preference is off. That keeps
    // switching it on from immediately interrupting the screen the tester is on;
    // the next cold start gets a fresh module-level session guard.
    if (!promptEnabledForSession) {
      promptedThisSession = true;
      return;
    }

    // Staging is an opt-in main update, not a PR to verdict. Do not interrupt
    // testers with a PR prompt when they relaunch on its bundle.
    if (readRunningOtaBranch() === STAGING_OTA_BRANCH) {
      promptedThisSession = true;
      return;
    }

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
        // while the reads were in flight, or SendRecoveryGate may have finished
        // first and put its notice up (first to finish wins; see its segment
        // list in qa-gate-decision.ts).
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
  }, [ready, enabled, promptEnabledForSession, surfingBuild, surfingReady, profile?.isTester, userId]);

  return null;
}
