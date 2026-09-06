// Pure form rules behind the "Report climb" sheet. Everything here is
// renderer-free so the arithmetic the backend rejects on — the trimmed reason
// length, the raw-vs-formatted grade label, the "you picked the grade it already
// has" case — is testable without mounting a native sheet.
//
// The grade a report carries MUST be the raw label the grades query returns
// (`Grade.name`, e.g. `6b+/V4`), never a display string from `useGradeFormat`:
// the backend matches it against the climb's own `difficulty`, which is raw.

import type { Proposal, ReportClimbInput, ReportClimbKind, ReportClimbStatus } from '@boardsesh/shared-schema';

/** Backend contract: the reason is trimmed, then bounded to 10..500 characters. */
export const REASON_MIN = 10;
export const REASON_MAX = 500;

/**
 * What is wrong with the climb. Aliased off the schema's own `ReportClimbKind`
 * rather than re-spelled, so adding a kind to the enum can't leave the sheet
 * silently offering the old two.
 */
export type ReportKind = ReportClimbKind;

/** Why the typed reason isn't submittable yet; `null` once it is. */
export type ReasonProblem = 'tooShort' | 'tooLong';

export function validateReason(reason: string): ReasonProblem | null {
  const trimmedLength = reason.trim().length;
  if (trimmedLength < REASON_MIN) return 'tooShort';
  if (trimmedLength > REASON_MAX) return 'tooLong';
  return null;
}

/** Characters still needed before the reason clears `REASON_MIN` (0 once valid). */
export function remainingReasonCharacters(reason: string): number {
  return Math.max(0, REASON_MIN - reason.trim().length);
}

export type BuildReportInputArgs = {
  kind: ReportKind;
  climbUuid: string;
  boardType: string;
  /** The angle the climb is being looked at. Carried on grade reports only. */
  angle: number;
  reason: string;
  /** Raw `Grade.name` of the chip the climber picked (grade reports). */
  selectedGradeName?: string | null;
  /** Raw `Climb.difficulty` — the grade the report would be arguing against. */
  currentGradeName?: string | null;
};

export type BuildReportInputResult =
  | { ok: true; input: ReportClimbInput }
  | { ok: false; error: 'reason' | 'noGrade' | 'sameGrade' };

/**
 * Turn the sheet's form state into the mutation input, or say which rule stopped
 * it. A hide report drops the angle (the climb is hidden at every angle) and
 * carries no grade; a grade report carries both, and refuses the grade the climb
 * already has — proposing it would be a no-op vote the backend has to reject.
 */
export function buildReportInput({
  kind,
  climbUuid,
  boardType,
  angle,
  reason,
  selectedGradeName,
  currentGradeName,
}: BuildReportInputArgs): BuildReportInputResult {
  if (validateReason(reason) !== null) return { ok: false, error: 'reason' };
  const trimmedReason = reason.trim();

  if (kind === 'hide') {
    return { ok: true, input: { climbUuid, boardType, angle: null, kind: 'hide', reason: trimmedReason } };
  }

  if (!selectedGradeName) return { ok: false, error: 'noGrade' };
  if (currentGradeName && selectedGradeName === currentGradeName) return { ok: false, error: 'sameGrade' };

  return {
    ok: true,
    input: { climbUuid, boardType, angle, kind: 'grade', proposedGrade: selectedGradeName, reason: trimmedReason },
  };
}

/** Vote counts the "reported" toast reads off the returned proposal. */
type ReportedProposal = Pick<Proposal, 'weightedUpvotes' | 'requiredUpvotes'>;

export type ReportToastCopy = {
  /** Catalog key in the `climbs` namespace. */
  textI18nKey: string;
  params: Record<string, number>;
};

/**
 * Which toast fires once the server has spoken. Keys are string literals inside
 * the switch so the orphan checker can resolve every one of them statically.
 */
export function reportToastCopy(
  status: ReportClimbStatus,
  kind: ReportKind,
  proposal: ReportedProposal,
): ReportToastCopy {
  switch (status) {
    case 'already_reported':
      return { textI18nKey: 'mobile.report.toast.alreadyReported', params: {} };
    case 'created':
    case 'added':
    // A status this build does not know (the backend may grow one) still landed
    // the report, so it reads like a fresh one rather than dropping the toast.
    default:
      if (kind === 'grade') return { textI18nKey: 'mobile.report.toast.reportedGrade', params: {} };
      return {
        textI18nKey: 'mobile.report.toast.reported',
        params: { current: proposal.weightedUpvotes, required: proposal.requiredUpvotes },
      };
  }
}
