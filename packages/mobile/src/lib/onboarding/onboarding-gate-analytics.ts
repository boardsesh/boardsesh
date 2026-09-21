// `Onboarding Gate Evaluated` (#5654): what the launch-time first-run gate
// decided and why. The event's contract lives beside its name in
// `@boardsesh/analytics` (SHARED_EVENTS.OnboardingGateEvaluated); this module
// only builds the payload and applies the volume rule, so the gate component
// stays free of property-key bookkeeping and the rule is unit-testable.

import { SHARED_EVENTS } from '@boardsesh/analytics';
import * as Updates from 'expo-updates';
import { track } from '../analytics';
import { nowMs } from '../clock';

/**
 * `would_present` rather than `presented`: in #5654's first PR the gate decides
 * and logs, and shows nothing. `stalled` comes from the watchdog, not a decision.
 */
export type OnboardingGateOutcome = 'would_present' | 'skipped' | 'stalled';

export type OnboardingGateReason =
  // would_present
  | 'no_board'
  // skipped
  | 'has_board'
  | 'deep_link_segment'
  | 'launched_by_url'
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
  /** Which walkthrough step the gate would open; null unless `would_present`. */
  step: 'intro' | 'board' | null;
  /** null when the active-board read had not succeeded yet. */
  hadBoard: boolean | null;
  /** null when the gate stopped before reading the seen flag. */
  seenFlag: boolean | null;
  /** The profile's ISO `createdAt`, when the profile has loaded. */
  accountCreatedAt: string | null | undefined;
  trigger: OnboardingGateTrigger;
  topSegment: string | undefined;
  msSinceMount: number;
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
 * Everything else reports: every `would_present`, every stall, and every skip of
 * a climber without a board.
 */
export function shouldReportOnboardingGate(
  evaluation: Pick<OnboardingGateEvaluation, 'outcome' | 'hadBoard' | 'seenFlag' | 'topSegment'>,
): boolean {
  if (evaluation.outcome !== 'skipped') return true;
  if (evaluation.topSegment === 'auth') return false;
  return !(evaluation.hadBoard === true && evaluation.seenFlag !== false);
}

export function trackOnboardingGateEvaluated(evaluation: OnboardingGateEvaluation): void {
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
  });
}
