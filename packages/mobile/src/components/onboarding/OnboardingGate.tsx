import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { router, useSegments } from 'expo-router';
import * as Linking from 'expo-linking';
import { hasSeenOnboarding, markOnboardingSeen } from '../../lib/onboarding/onboarding-storage';
import { DEEP_LINK_SEGMENTS } from '../../lib/deep-link-segments';
import { useProfile } from '../../lib/graphql/hooks';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { reportError } from '../../lib/error-reporting';
import { nowMs } from '../../lib/clock';
import { getConnectivitySnapshot } from '../../lib/connectivity/connectivity-store';
import { startForegroundWatchdog } from '../../lib/onboarding/foreground-watchdog';
import {
  trackOnboardingGateEvaluated,
  type OnboardingGateEvaluation,
  type OnboardingGateTrigger,
} from '../../lib/onboarding/onboarding-gate-analytics';
import { decideFirstBoardPicker, isNewAccount } from '../../lib/onboarding/first-board-picker-decision';
import {
  readFirstBoardPickerShowCount,
  recordFirstBoardPickerShown,
} from '../../lib/onboarding/first-board-picker-store';
import { FIRST_BOARD_PICKER_HREF } from '../../lib/boards/first-board-mode';
import { markBoardLookStepSeen } from '../../lib/board-render/board-look-step-seen';
import { wasOpenedFromNotification } from '../../lib/onboarding/launch-notification';
import { useFeatureFlagsResolved, useFirstBoardPickerEnabled } from '../../providers/feature-flags-provider';
import { useLaunchReady } from '../../providers/launch-ready-context';
import { BoardLookStepGate } from '../board-look/BoardLookStepGate';

/**
 * How much FOREGROUND time the gate gets to reach a decision before it reports
 * itself stalled. Deciding normally takes well under a second after the splash.
 */
export const ONBOARDING_GATE_STALL_MS = 15_000;

/**
 * The longest the decision waits for the profile read, counted from mount. The
 * profile only supplies the account age, and a slow or offline read must not
 * hold the decision to the stall watchdog: after this it goes out with a null
 * age. Well inside the watchdog, so the profile is never what a stall names.
 */
export const ONBOARDING_GATE_PROFILE_WAIT_MS = 5_000;

// The first gate mount in this JS process is the cold start; any later one is a
// remount (signing in swaps AuthProvider's children, which remounts the gate).
let mountedThisProcess = false;

/** Test seam: make the next mount read as a cold start again. */
export function resetOnboardingGateProcessForTests(): void {
  mountedThisProcess = false;
}

/** The parts of an evaluation a decision supplies; the gate fills in the rest. */
type GateDecision = Pick<
  OnboardingGateEvaluation,
  'outcome' | 'reason' | 'step' | 'hadBoard' | 'seenFlag' | 'pickerVerdict' | 'pickerTimesShown'
>;

/**
 * New accounts never get the board-look step (#5654). Their stored mode is
 * `default`, which already draws Aura, and the step's question ("keep the look
 * you know, or switch?") is for climbers who knew the old one. Marking it seen
 * is what keeps it away if the step ever presents again. Awaited by the gate
 * before it releases `BoardLookStepGate`, so the step's own read sees the mark.
 * A failed write is reported and costs nothing else: the step only logs today.
 *
 * The marker is per device, not per account, so on a shared phone a new second
 * account also retires the step for the older account there. And a device that
 * already stores Classic keeps Classic for the new account: the step never asks
 * anyone whose stored mode is not `default`, with or without this mark.
 * `first-board-picker-kill` turns this off along with the picker, so the switch
 * takes back everything the gate does differently for new accounts.
 */
async function markBoardLookStepSeenForNewAccount(): Promise<void> {
  try {
    await markBoardLookStepSeen();
  } catch (error: unknown) {
    // eslint-disable-next-line no-console
    console.warn('[onboarding] Failed to mark the board-look step seen for a new account', error);
    reportError(error);
  }
}

/**
 * Whether the profile read has anything more to say. A loaded profile is final.
 * Otherwise the read has to have finished, success or error, with nothing in
 * flight: a sign-in keeps the login screen's cached `profile: null` while the
 * refetch that replaces it is running, and deciding on that would send a null
 * account age for every climber who just signed up.
 */
function isProfileSettled(profileQuery: {
  data: unknown;
  isFetching: boolean;
  isSuccess: boolean;
  isError: boolean;
}): boolean {
  if (profileQuery.data != null) return true;
  return !profileQuery.isFetching && (profileQuery.isSuccess || profileQuery.isError);
}

/**
 * First-run gate. Once the app is ready (auth + fonts loaded, splash hidden) it
 * decides whether the climber needs help finding a board: yes unless a board is
 * already bound. Renders nothing itself. Mounting it below AuthProvider means it
 * only decides for an authenticated session; an unauthenticated cold start is
 * redirected to login by the auth gate, and the gate decides after sign-in.
 *
 * **Only new accounts get anything (#5654).** From 2.2.0 this gate never ran:
 * its `ready` prop was frozen at false behind `DatabaseProvider` (see
 * `launch-ready-context.tsx`). Waking it for everyone would have dropped every
 * existing climber without a board into a flow they never saw, in one
 * fleet-wide OTA. So:
 *
 * - An account at most 7 days old with no board gets the board picker in
 *   first-board mode ("Where do you climb?"), at most twice per account, never
 *   offline, never over a launch that came from a link or a tapped
 *   notification, and never with `first-board-picker-kill` on. It is skippable,
 *   and a bind from it lands on Climbs. Logged as `presented`.
 * - Every other climber without a board gets the log-only `would_present` the
 *   gate gave everyone before, with `picker_verdict` saying why the picker
 *   stayed shut.
 *
 * The old walkthrough (`/onboarding`) is no longer opened from here. It stays
 * reachable from the More tab's replay rows.
 *
 * Every decision goes out through `Onboarding Gate Evaluated`, which also
 * carries a 15 s stall watchdog, so a gate that never decides can no longer go
 * unnoticed. The decision waits up to 5 s for the profile, because the account
 * age is what tells a new account from an existing one, and for the feature
 * flags, so the kill switch lands before the push it exists to stop.
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
  const flagsResolved = useFeatureFlagsResolved();
  const pickerEnabled = useFirstBoardPickerEnabled();
  const pickerEnabledRef = useRef(pickerEnabled);
  pickerEnabledRef.current = pickerEnabled;
  const segments = useSegments();
  // Latest top-level segment for the async check, without re-running the effect
  // on every navigation — the gate decides once per app launch.
  const topSegmentRef = useRef<string | undefined>(segments[0]);
  topSegmentRef.current = segments[0];
  const decidedRef = useRef(false);
  const triggerRef = useRef<OnboardingGateTrigger>('cold_start');
  const mountedAtRef = useRef(0);
  const stopWatchdogRef = useRef<(() => void) | null>(null);
  // Set when the watchdog has already reported this mount as stalled, so a
  // decision that lands later says so and the two events can be told apart.
  const stalledRef = useRef(false);

  // The gate decides once per signed-in account. `undefined` while the profile
  // loads, and the profile landing for the account already on screen is not a
  // new account: only a transition between two concrete ids re-decides.
  const profileQuery = useProfile();
  const profile = profileQuery.data;
  const userId = profile?.id;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
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
      // `ms_since_mount` on the new account's decision counts from the switch,
      // not from a mount that belonged to the previous account.
      mountedAtRef.current = Date.now();
    }
  }

  // The decision waits for the profile so the event can carry the account age,
  // which is what splits new accounts from existing ones. Latched: once the wait
  // is over, a later refetch (an avatar change, a focus refresh) must not
  // re-open it and cancel a run that is already reading.
  const [profileWaitExpired, setProfileWaitExpired] = useState(false);
  const profileReadyRef = useRef(false);
  if (profileWaitExpired || isProfileSettled(profileQuery)) profileReadyRef.current = true;
  const profileReady = profileReadyRef.current;

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
        stalledRef.current = true;
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
          afterStall: false,
          pickerVerdict: null,
          pickerTimesShown: null,
        });
      },
    });
    stopWatchdogRef.current = stopWatchdog;
    return () => {
      stopWatchdogRef.current = null;
      stopWatchdog();
    };
  }, []);

  // The bound on the profile wait. A plain timer, not the foreground watchdog:
  // it only ever shortens a wait, and it expires long before the watchdog can.
  useEffect(() => {
    const timer = setTimeout(() => setProfileWaitExpired(true), ONBOARDING_GATE_PROFILE_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready || !boardResolved || !profileReady || !flagsResolved || decidedRef.current) return;
    // Screenshot builds never auto-present the tour: the app-store flow needs to
    // reach the tabs, and the onboarding-capture flow opens /onboarding itself.
    // Nothing else auto-presents in a capture run either, so this stays `pending`.
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return;
    decidedRef.current = true;

    let cancelled = false;
    let decided = false;
    // Read once for the whole run, so every branch below agrees on it. The
    // board-look mark follows the kill switch: with it on, a new account gets
    // exactly what it got before the picker existed.
    const markLookStepForNewAccount = isNewAccount(accountCreatedAtRef.current, nowMs()) && pickerEnabledRef.current;
    const decide = (decision: GateDecision) => {
      decided = true;
      stopWatchdogRef.current?.();
      trackOnboardingGateEvaluated({
        ...decision,
        accountCreatedAt: accountCreatedAtRef.current,
        trigger: triggerRef.current,
        topSegment: topSegmentRef.current,
        msSinceMount: Date.now() - mountedAtRef.current,
        afterStall: stalledRef.current,
      });
    };

    void (async () => {
      // `tourEvaluated` is published in a `finally` by every run that was not
      // cancelled, so no exit path can forget it. A cancelled run publishes
      // nothing: it decided nothing, the cleanup below has cleared
      // `decidedRef` so the re-run goes through, and that re-run publishes once
      // it decides. Publishing from the cancelled run would let the board-look
      // step evaluate before the tour has actually decided. An unmount needs
      // nothing at all. For a new account the board-look step is marked seen
      // first, unless the kill switch is on (see
      // `markBoardLookStepSeenForNewAccount`).
      try {
        // Don't interrupt a deep-link / auth / share landing on a non-tab group.
        if (topSegmentRef.current && DEEP_LINK_SEGMENTS.has(topSegmentRef.current)) {
          decide({
            outcome: 'skipped',
            reason: 'deep_link_segment',
            step: null,
            hadBoard: hasBoardRef.current,
            seenFlag: null,
            pickerVerdict: null,
            pickerTimesShown: null,
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
            pickerVerdict: null,
            pickerTimesShown: null,
          });
          return;
        }

        // A tapped push lands the same way (a session invite opens the queue tab)
        // but leaves no launch URL, so it needs its own check. Same intent,
        // same answer: don't cover where the notification sent them.
        if (wasOpenedFromNotification()) {
          decide({
            outcome: 'skipped',
            reason: 'launched_by_notification',
            step: null,
            hadBoard: hasBoardRef.current,
            seenFlag: null,
            pickerVerdict: null,
            pickerTimesShown: null,
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
          decide({
            outcome: 'skipped',
            reason: 'has_board',
            step: null,
            hadBoard: true,
            seenFlag: seen,
            pickerVerdict: null,
            pickerTimesShown: null,
          });
          return;
        }

        // No board. Whether the picker opens is about the account (new, known,
        // not asked twice already) and the moment (online, not killed). The
        // counter is only read for an account the cheap checks let through: a
        // preflight with a stand-in count of 0 rules everyone else out first.
        const accountId = userIdRef.current;
        const pickerInput = {
          userId: accountId,
          accountCreatedAt: accountCreatedAtRef.current,
          nowMs: nowMs(),
          enabled: pickerEnabledRef.current,
          offline: getConnectivitySnapshot().effectiveOffline,
        };
        let pickerVerdict = decideFirstBoardPicker({ ...pickerInput, timesShown: 0 });
        let pickerTimesShown: number | null = null;
        if (pickerVerdict === 'presented' && accountId) {
          pickerTimesShown = await readFirstBoardPickerShowCount(accountId);
          if (cancelled) return;
          pickerVerdict = decideFirstBoardPicker({ ...pickerInput, timesShown: pickerTimesShown });
        }

        // Re-check the route after the async reads — a deep link may have arrived
        // in the meantime — so we never cover an intentional destination.
        if (topSegmentRef.current && DEEP_LINK_SEGMENTS.has(topSegmentRef.current)) {
          decide({
            outcome: 'skipped',
            reason: 'segment_after_reads',
            step: null,
            hadBoard: false,
            seenFlag: seen,
            pickerVerdict: null,
            pickerTimesShown,
          });
          return;
        }

        if (pickerVerdict === 'presented' && accountId && pickerTimesShown !== null) {
          // Counted BEFORE it opens, so a crash inside the picker still spends
          // one of the two showings. A counter that cannot be written cannot
          // cap anything, so it does not open at all.
          try {
            await recordFirstBoardPickerShown(accountId, pickerTimesShown + 1);
          } catch (error: unknown) {
            reportError(error);
            pickerVerdict = 'storage_error';
          }
          if (cancelled) return;
        }

        if (pickerVerdict === 'presented') {
          router.push(FIRST_BOARD_PICKER_HREF);
          decide({
            outcome: 'presented',
            reason: 'new_account',
            step: 'first_board',
            hadBoard: false,
            seenFlag: seen,
            pickerVerdict,
            pickerTimesShown,
          });
          return;
        }

        // Everyone else keeps the log-only answer. Someone who has already been
        // through the framing card would start at the board step: a sign-out, a
        // token expiry and a remote sign-out all clear the device-wide active
        // board (`clearPersistedUserStores`), and a re-login should not re-teach
        // why a named board matters.
        decide({
          outcome: 'would_present',
          reason: 'no_board',
          step: seen ? 'board' : 'intro',
          hadBoard: false,
          seenFlag: seen,
          pickerVerdict,
          pickerTimesShown,
        });
      } finally {
        if (!cancelled) {
          if (markLookStepForNewAccount) await markBoardLookStepSeenForNewAccount();
          if (!cancelled) setTourEvaluated(true);
        }
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
  }, [ready, boardResolved, profileReady, flagsResolved, userId]);

  // The board-look step is evaluated and logged too, never presented (#5654).
  return <BoardLookStepGate ready={ready} tourDecided={tourEvaluated} present={false} />;
}
