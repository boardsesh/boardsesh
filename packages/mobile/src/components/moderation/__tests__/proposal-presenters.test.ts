// The arithmetic and mapping behind a proposal card. Each of these is
// wrong-by-one if written from memory and invisible in a render test:
//   - a vote is cleared by re-sending the SAME value, so the optimistic step has
//     to move BOTH sides when a climber switches from support to oppose;
//   - the vote bar divides by `requiredUpvotes`, which the server can report as
//     zero, and shows a `current` the weighted total can exceed;
//   - a proposal without frames or a layout can't be drawn, and handing the play
//     drawer a half-built climb renders an empty board instead of falling back.
import { describe, expect, it } from 'vitest';
import type { Proposal, ProposalType } from '@boardsesh/shared-schema';
import {
  applyOptimisticVote,
  proposalToClimb,
  proposalTypeLine,
  statusChip,
  voteProgress,
} from '../proposal-presenters';

/** Passes grades through unchanged — the identity case for the formatter. */
const rawGrade = (difficulty: string | null | undefined) => difficulty ?? null;
/** Stands in for a formatter that can't parse the label (unknown scale). */
const noGrade = () => null;

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    uuid: 'p1',
    climbUuid: 'c1',
    boardType: 'kilter',
    angle: 40,
    proposerId: 'u1',
    proposerDisplayName: 'Alex',
    proposerAvatarUrl: null,
    type: 'hide',
    proposedValue: 'true',
    currentValue: 'false',
    status: 'open',
    reason: 'Holds are spinning',
    resolvedAt: null,
    resolvedBy: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    weightedUpvotes: 1,
    weightedDownvotes: 0,
    requiredUpvotes: 3,
    userVote: 0,
    climbName: 'Sandbag',
    frames: 'p1080r12',
    layoutId: 8,
    climbSetterUsername: 'setter',
    climbDifficulty: '6b+/V4',
    climbQualityAverage: '2.5',
    climbAscensionistCount: 12,
    climbDifficultyError: '0.4',
    climbBenchmarkDifficulty: null,
    climbIsNoMatch: false,
    upvoterCount: 1,
    commentCount: 0,
    climbIsHidden: false,
    ...overrides,
  };
}

describe('proposalTypeLine', () => {
  it('names the hide case without touching the grade formatter', () => {
    expect(proposalTypeLine(makeProposal({ type: 'hide' }), rawGrade)).toEqual({
      textI18nKey: 'climbs:mobile.moderation.type.hide',
      params: {},
    });
  });

  it('formats both ends of a grade change', () => {
    const line = proposalTypeLine(
      makeProposal({ type: 'grade', currentValue: '6b+/V4', proposedValue: '6c/V5' }),
      rawGrade,
    );
    expect(line.textI18nKey).toBe('climbs:mobile.moderation.type.grade');
    expect(line.params).toEqual({ from: '6b+/V4', to: '6c/V5' });
  });

  it('falls back to the raw label when the formatter cannot parse it', () => {
    // An unparseable label must still show SOMETHING — an empty "Grade  →  "
    // is worse than the raw string the server sent.
    const line = proposalTypeLine(
      makeProposal({ type: 'grade', currentValue: '6b+/V4', proposedValue: '6c/V5' }),
      noGrade,
    );
    expect(line.params).toEqual({ from: '6b+/V4', to: '6c/V5' });
  });

  it('carries the proposed value for classic and benchmark', () => {
    expect(proposalTypeLine(makeProposal({ type: 'classic', proposedValue: 'true' }), rawGrade)).toEqual({
      textI18nKey: 'climbs:mobile.moderation.type.classic',
      params: { value: 'true' },
    });
    expect(proposalTypeLine(makeProposal({ type: 'benchmark', proposedValue: 'false' }), rawGrade)).toEqual({
      textI18nKey: 'climbs:mobile.moderation.type.benchmark',
      params: { value: 'false' },
    });
  });

  it('renders a generic line for a type this build does not know', () => {
    // A server ahead of the store binary. The card must still draw a row.
    const futureType = 'quality' as unknown as ProposalType;
    expect(proposalTypeLine(makeProposal({ type: futureType }), rawGrade).textI18nKey).toBe(
      'climbs:mobile.moderation.type.unknown',
    );
  });
});

describe('voteProgress', () => {
  it('caps the current count at the requirement', () => {
    const progress = voteProgress(makeProposal({ weightedUpvotes: 7, requiredUpvotes: 3 }));
    expect(progress).toMatchObject({ current: 3, required: 3 });
  });

  it('floors the requirement at one so the bar never divides by zero', () => {
    expect(voteProgress(makeProposal({ requiredUpvotes: 0, weightedUpvotes: 0 })).required).toBe(1);
  });

  it('never reports negative counts', () => {
    const progress = voteProgress(
      makeProposal({ weightedUpvotes: -2, weightedDownvotes: -1, upvoterCount: -3, requiredUpvotes: 3 }),
    );
    expect(progress).toEqual({ current: 0, required: 3, reporters: 0, opposed: 0 });
  });

  it('reports reporters separately from the weighted total', () => {
    // One admin vote weighs 3 but is still one reporter.
    const progress = voteProgress(makeProposal({ weightedUpvotes: 3, upvoterCount: 1, requiredUpvotes: 3 }));
    expect(progress).toMatchObject({ current: 3, reporters: 1 });
  });
});

describe('proposalToClimb', () => {
  it('returns null without frames', () => {
    expect(proposalToClimb(makeProposal({ frames: null }))).toBeNull();
  });

  it('returns null without a layout', () => {
    expect(proposalToClimb(makeProposal({ layoutId: null }))).toBeNull();
  });

  it('carries the hidden flag through so the drawer can badge it', () => {
    const climb = proposalToClimb(makeProposal({ climbIsHidden: true }));
    expect(climb?.is_hidden).toBe(true);
  });

  it('maps the climb fields the feed carries', () => {
    const climb = proposalToClimb(makeProposal());
    expect(climb).toMatchObject({
      uuid: 'c1',
      name: 'Sandbag',
      frames: 'p1080r12',
      angle: 40,
      difficulty: '6b+/V4',
      quality_average: '2.5',
      setter_username: 'setter',
      ascensionist_count: 12,
      boardType: 'kilter',
      layoutId: 8,
    });
  });

  it('falls back to the uuid when the climb has no name', () => {
    expect(proposalToClimb(makeProposal({ climbName: null }))?.name).toBe('c1');
  });
});

describe('applyOptimisticVote', () => {
  it('adds a support vote', () => {
    const next = applyOptimisticVote(makeProposal({ userVote: 0, weightedUpvotes: 1 }), 1);
    expect(next).toMatchObject({ userVote: 1, weightedUpvotes: 2, weightedDownvotes: 0 });
  });

  it('clears the vote when the same value is sent again', () => {
    // The backend has no "clear" value — re-sending the recorded one deletes it.
    const next = applyOptimisticVote(makeProposal({ userVote: 1, weightedUpvotes: 2 }), 1);
    expect(next).toMatchObject({ userVote: 0, weightedUpvotes: 1 });
  });

  it('moves both sides when the climber switches support to oppose', () => {
    const next = applyOptimisticVote(makeProposal({ userVote: 1, weightedUpvotes: 2, weightedDownvotes: 1 }), -1);
    expect(next).toMatchObject({ userVote: -1, weightedUpvotes: 1, weightedDownvotes: 2 });
  });

  it('never drives a total below zero', () => {
    const next = applyOptimisticVote(makeProposal({ userVote: 1, weightedUpvotes: 0 }), 1);
    expect(next.weightedUpvotes).toBe(0);
  });

  it('leaves the rest of the proposal untouched', () => {
    const proposal = makeProposal({ commentCount: 4 });
    expect(applyOptimisticVote(proposal, 1).commentCount).toBe(4);
  });
});

describe('statusChip', () => {
  it('has no chip for an open proposal', () => {
    expect(statusChip(makeProposal({ status: 'open' }))).toBeNull();
  });

  it('reuses the shared approved / rejected labels', () => {
    expect(statusChip(makeProposal({ status: 'approved' }))).toEqual({
      labelI18nKey: 'feed:proposalVoteBar.approved',
    });
    expect(statusChip(makeProposal({ status: 'rejected' }))).toEqual({
      labelI18nKey: 'feed:proposalVoteBar.rejected',
    });
  });

  it('marks a superseded proposal as replaced', () => {
    expect(statusChip(makeProposal({ status: 'superseded' }))).toEqual({
      labelI18nKey: 'climbs:mobile.moderation.supersededChip',
    });
  });
});
