// Pure view-model helpers behind the moderation feed. Everything a proposal card
// shows that needs a decision — which sentence describes the change, how far the
// vote has got, whether the climb can be drawn on a board — is derived here, so
// the card renders and the tests assert the same arithmetic.
//
// i18n keys are returned as `*I18nKey` properties holding literal, namespace
// qualified strings (`feed:…`, `climbs:…`). That shape is load-bearing twice
// over: the orphan checker records a `*I18nKey` property's literal as live, and
// react-i18next resolves the `ns:` prefix regardless of which namespace the
// calling `t` is bound to.

import type { Climb, Proposal } from '@boardsesh/shared-schema';

/** The two values `voteOnProposal` accepts. Re-sending one clears the vote. */
export type ProposalVoteValue = 1 | -1;

/** Formats a raw grade label (`6b+/V4`) for display; `useGradeFormat().formatGrade`. */
export type GradeFormatter = (difficulty: string | null | undefined) => string | null;

/** One line of copy describing what a proposal asks for. */
export type ProposalTypeLine = {
  /** Namespace-qualified i18n key. Read it with `t(line.textI18nKey, line.params)`. */
  textI18nKey: string;
  /** ICU interpolation values for the key above. */
  params: Record<string, string>;
};

/** The chip that marks a resolved proposal, or `null` while it is still open. */
export type ProposalStatusChip = {
  /** Namespace-qualified i18n key. Read it with `t(chip.labelI18nKey)`. */
  labelI18nKey: string;
};

/** Vote-bar numbers, already clamped into a range that can be rendered honestly. */
export type ProposalVoteProgress = {
  /** Weighted upvotes so far, never above `required` and never below zero. */
  current: number;
  /** Weighted upvotes needed to carry the proposal. At least 1. */
  required: number;
  /** Distinct climbers who backed it — the "N reporters" line, unweighted. */
  reporters: number;
  /** Weighted downvotes, never below zero. */
  opposed: number;
};

/**
 * The sentence describing what this proposal changes.
 *
 * Grades arrive as raw labels (`6b+/V4`), so the caller passes its bound
 * `formatGrade` and the from/to pair comes out in the climber's chosen scale.
 * A label the formatter can't parse falls through unchanged rather than
 * rendering an empty arrow.
 */
export function proposalTypeLine(
  proposal: Pick<Proposal, 'type' | 'proposedValue' | 'currentValue'>,
  formatGrade: GradeFormatter,
): ProposalTypeLine {
  switch (proposal.type) {
    case 'hide':
      return { textI18nKey: 'climbs:mobile.moderation.type.hide', params: {} };
    case 'grade':
      return {
        textI18nKey: 'climbs:mobile.moderation.type.grade',
        params: {
          from: formatGrade(proposal.currentValue) ?? proposal.currentValue,
          to: formatGrade(proposal.proposedValue) ?? proposal.proposedValue,
        },
      };
    case 'classic':
      return { textI18nKey: 'climbs:mobile.moderation.type.classic', params: { value: proposal.proposedValue } };
    case 'benchmark':
      return { textI18nKey: 'climbs:mobile.moderation.type.benchmark', params: { value: proposal.proposedValue } };
    default:
      // A proposal type this build doesn't know yet (the server is ahead of the
      // store binary). Still renders a row rather than a blank card.
      return { textI18nKey: 'climbs:mobile.moderation.type.unknown', params: {} };
  }
}

/**
 * Vote-bar numbers, clamped.
 *
 * The server's weighted counts are floats — an admin vote is worth 3 — and an
 * already-carried proposal can sit above its threshold. "7 / 3 votes needed"
 * reads as a bug, so `current` tops out at `required`, and `required` floors at
 * 1 so the bar never divides by a zero threshold.
 */
export function voteProgress(
  proposal: Pick<Proposal, 'weightedUpvotes' | 'weightedDownvotes' | 'requiredUpvotes' | 'upvoterCount'>,
): ProposalVoteProgress {
  const required = Math.max(1, Math.round(proposal.requiredUpvotes));
  const current = Math.min(required, Math.max(0, Math.round(proposal.weightedUpvotes)));
  return {
    current,
    required,
    reporters: Math.max(0, Math.round(proposal.upvoterCount)),
    opposed: Math.max(0, Math.round(proposal.weightedDownvotes)),
  };
}

/**
 * A play-drawer-ready `Climb` built from the climb fields the proposal feed
 * carries, or `null` when it can't be drawn.
 *
 * Two fields gate it, for the same reason `tickToClimb` gates on frames: without
 * `frames` there is nothing to light, and without `layoutId` the board config
 * can't resolve. The caller then opens the climb by reference instead, which
 * loads the full row by uuid.
 */
export function proposalToClimb(proposal: Proposal): Climb | null {
  if (!proposal.frames || proposal.layoutId == null) return null;

  const quality = proposal.climbQualityAverage ?? '0';
  const stars = Number(quality);

  return {
    uuid: proposal.climbUuid,
    name: proposal.climbName ?? proposal.climbUuid,
    frames: proposal.frames,
    angle: proposal.angle ?? 0,
    ascensionist_count: proposal.climbAscensionistCount ?? 0,
    difficulty: proposal.climbDifficulty ?? '',
    difficulty_error: proposal.climbDifficultyError ?? '',
    quality_average: quality,
    stars: Number.isFinite(stars) ? stars : 0,
    setter_username: proposal.climbSetterUsername ?? '',
    benchmark_difficulty: proposal.climbBenchmarkDifficulty ?? null,
    is_no_match: proposal.climbIsNoMatch ?? false,
    is_hidden: proposal.climbIsHidden ?? false,
    boardType: proposal.boardType,
    layoutId: proposal.layoutId,
  };
}

/**
 * The proposal as it should look the instant a vote button is tapped.
 *
 * `voteOnProposal` has no "clear" value: re-sending the value already on record
 * is how the backend deletes a vote, so tapping Support twice lands on
 * `userVote: 0`. The weighted totals move by 1 on each side that changed —
 * a placeholder, since the viewer's real weight (2 for a leader, 3 for an admin)
 * is only known server-side. `onSuccess` overwrites the row with the server's
 * numbers, so the guess never outlives the round trip.
 */
export function applyOptimisticVote(proposal: Proposal, value: ProposalVoteValue): Proposal {
  const previousVote = proposal.userVote;
  const nextVote = previousVote === value ? 0 : value;

  let weightedUpvotes = proposal.weightedUpvotes;
  let weightedDownvotes = proposal.weightedDownvotes;
  if (previousVote === 1) weightedUpvotes -= 1;
  if (previousVote === -1) weightedDownvotes -= 1;
  if (nextVote === 1) weightedUpvotes += 1;
  if (nextVote === -1) weightedDownvotes += 1;

  return {
    ...proposal,
    userVote: nextVote,
    weightedUpvotes: Math.max(0, weightedUpvotes),
    weightedDownvotes: Math.max(0, weightedDownvotes),
  };
}

/**
 * The chip a resolved proposal carries, or `null` while it is open — an open
 * proposal already shows its vote bar and action buttons, so a redundant "Open"
 * chip would only add noise.
 */
export function statusChip(proposal: Pick<Proposal, 'status'>): ProposalStatusChip | null {
  switch (proposal.status) {
    case 'approved':
      return { labelI18nKey: 'feed:proposalVoteBar.approved' };
    case 'rejected':
      return { labelI18nKey: 'feed:proposalVoteBar.rejected' };
    case 'superseded':
      return { labelI18nKey: 'climbs:mobile.moderation.supersededChip' };
    default:
      // `'open'`, and any status a newer server introduces.
      return null;
  }
}
