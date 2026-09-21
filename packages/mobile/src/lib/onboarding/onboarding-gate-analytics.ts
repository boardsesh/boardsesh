// `Onboarding Gate Evaluated` (#5654): what the launch-time first-run gate
// decided and why. The event's contract lives beside its name in
// `@boardsesh/analytics` (SHARED_EVENTS.OnboardingGateEvaluated); this module
// only builds the payload and applies the volume rule, so the gate component
// stays free of property-key bookkeeping and the rule is unit-testable.

import { SHARED_EVENTS } from '@boardsesh/analytics';
import * as Updates from 'expo-updates';
import { track } from '../analytics';
import { nowMs } from '../clock';
import { REPORTS_LAUNCH_GATE_EVALUATIONS } from '../launch-gate-reporting';
import type { FirstBoardPickerVerdict } from './first-board-picker-decision';

/**
 * `presented` is the one decision that opens something: the board picker, for a
 * new account with no board (#5654). Every other climber without a board gets
 * `would_present`, the log-only answer the gate gave everyone in #5654's first
 * PR, and `picker_verdict` says why the picker stayed shut. `stalled` comes from
 * the watchdog, not a decision.
 */
export type OnboardingGateOutcome = 'presented' | 'would_present' | 'skipped' | 'stalled';

export type OnboardingGateReason =
  // presented: an account at most 7 days old with no board
  | 'new_account'
  // would_present
  | 'no_board'
  // skipped
  | 'has_board'
  | 'deep_link_segment'
  | 'launched_by_url'
  // a tapped push opened the app (it routes into a tab and leaves no launch URL)
  | 'launched_by_notification'
  | 'segment_after_reads'
  // stalled: which input was still missing when the watchdog fired
  | 'not_ready'
  | 'board_unresolved'
  | 'reads_pending';

/**
 * `cold_start` is the gate's first mount in this JS process, `remount` any later
 * one (sign-in remounts the whole tree under AuthProvider), and `account_switch`
 * a different signed-in account replacing the one the gate already decided for.
 */
export type OnboardingGateTrigger = 'cold_start' | 'remount' | 'account_switch';

export type OnboardingGateEvaluation = {
  outcome: OnboardingGateOutcome;
  reason: OnboardingGateReason;
  /**
   * What the gate opened (`first_board`, the board picker) or which walkthrough
   * step it would open (`intro`, `board`). Null on a skip or a stall.
   */
  step: 'intro' | 'board' | 'first_board' | null;
  /** null when the active-board read had not succeeded yet. */
  hadBoard: boolean | null;
  /** null when the gate stopped before reading the seen flag. */
  seenFlag: boolean | null;
  /**
   * The profile's ISO `createdAt`. The gate waits up to 5 s for the profile
   * before it decides, so this is only missing when that read failed or ran out
   * of time, and on a stall.
   */
  accountCreatedAt: string | null | undefined;
  trigger: OnboardingGateTrigger;
  topSegment: string | undefined;
  /**
   * From the gate's mount, or, on an `account_switch` decision, from the switch
   * that re-opened it: the previous account's time on screen is not the new
   * account's wait.
   */
  msSinceMount: number;
  /**
   * The watchdog had already reported this mount as `stalled` when the decision
   * landed. One mount can then send two events, and this is how a count of
   * decisions leaves the late one out, or a stall count finds its resolution.
   */
  afterStall: boolean;
  /**
   * For a climber with no board: whether the board picker opened (`presented`)
   * or why it stayed shut. Null on every other decision and on a stall.
   */
  pickerVerdict: FirstBoardPickerVerdict | null;
  /**
   * How many times the picker had already opened for this account on this
   * device, read before this decision. Null when the counter was not read (the
   * account was ruled out before it mattered) or could not be.
   */
  pickerTimesShown: number | null;
};

const MS_PER_HOUR = 3_600_000;

/** Whole hours since the account was created, or null when that is unknown. */
export function accountAgeHours(createdAt: string | null | undefined, atMs: number): number | null {
  if (!createdAt) return null;
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return null;
  return Math.max(0, Math.floor((atMs - createdMs) / MS_PER_HOUR));
}

/**
 * The volume rule. Two skips are left out because they would dominate the event
 * without saying anything:
 *
 * - a returning climber's steady state, a board bound and the seen flag not known
 *   to be false. That is most launches of most climbers. A board with the flag
 *   explicitly false still reports, because the gate backfills the flag then.
 * - a signed-out launch sitting on the login screen. The gate is mounted there
 *   too and stands down on the `auth` segment, but that is not a first-run
 *   decision; the one that counts comes after sign-in, when the tree remounts.
 *
 * Everything else reports: every `presented` and `would_present`, every stall,
 * and every skip of a climber without a board.
 *
 * Stalls are NOT filtered like decisions: the watchdog is the canary for #5654,
 * and that freeze hit every climber, returning ones included. So a stall rate
 * has to be read against launches (`OTA Update Status`, one per launch), never
 * against this event's own count, whose decisions leave the returning majority
 * out.
 */
export function shouldReportOnboardingGate(
  evaluation: Pick<OnboardingGateEvaluation, 'outcome' | 'hadBoard' | 'seenFlag' | 'topSegment'>,
): boolean {
  if (evaluation.outcome !== 'skipped') return true;
  if (evaluation.topSegment === 'auth') return false;
  return !(evaluation.hadBoard === true && evaluation.seenFlag !== false);
}

export function trackOnboardingGateEvaluated(evaluation: OnboardingGateEvaluation): void {
  // Off in the Expo browser build, where every launch reads as a URL launch.
  if (!REPORTS_LAUNCH_GATE_EVALUATIONS) return;
  if (!shouldReportOnboardingGate(evaluation)) return;
  track(SHARED_EVENTS.OnboardingGateEvaluated, {
    outcome: evaluation.outcome,
    reason: evaluation.reason,
    step: evaluation.step,
    had_board: evaluation.hadBoard,
    seen_flag: evaluation.seenFlag,
    account_age_hours: accountAgeHours(evaluation.accountCreatedAt, nowMs()),
    // Also a super property (OtaUpdateTracker), but stated here so the event
    // reads on its own: first launches run the binary's embedded JS, and that
    // split decides which release a first-run change has to ride.
    ota_is_embedded: Updates.isEmbeddedLaunch,
    trigger: evaluation.trigger,
    top_segment: evaluation.topSegment ?? null,
    ms_since_mount: Math.round(evaluation.msSinceMount),
    after_stall: evaluation.afterStall,
    picker_verdict: evaluation.pickerVerdict,
    picker_times_shown: evaluation.pickerTimesShown,
  });
}
