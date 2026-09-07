import { describe, expect, it } from 'vitest';
import type { Proposal } from '@boardsesh/shared-schema';
import { decidedBy, selectModerationStatus } from '../moderation-status';
import { isUnhideProposal } from '../../moderation/proposal-presenters';

function makeProposal(overrides: Partial<Proposal> & Pick<Proposal, 'uuid'>): Proposal {
  return {
    climbUuid: 'climb-1',
    boardType: 'kilter',
    angle: null,
    proposerId: 'user-1',
    proposerDisplayName: 'Ana',
    type: 'hide',
    proposedValue: 'true',
    currentValue: 'false',
    status: 'open',
    reason: 'Duplicate of another problem',
    resolvedAt: null,
    resolvedBy: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    weightedUpvotes: 1,
    weightedDownvotes: 0,
    requiredUpvotes: 5,
    userVote: 0,
    upvoterCount: 1,
    commentCount: 1,
    ...overrides,
  };
}

describe('selectModerationStatus', () => {
  it('returns nothing for a climb with no proposals', () => {
    expect(selectModerationStatus([], 40)).toEqual({ hidden: null, openHide: null, openGradeAtAngle: [] });
  });

  it('reports an approved hide as the hidden verdict', () => {
    const approved = makeProposal({
      uuid: 'hide-1',
      status: 'approved',
      resolvedAt: '2026-09-02T10:00:00.000Z',
    });
    expect(selectModerationStatus([approved], 40).hidden).toBe(approved);
  });

  it('ignores a rejected or superseded hide', () => {
    const rejected = makeProposal({ uuid: 'hide-1', status: 'rejected', resolvedAt: '2026-09-02T10:00:00.000Z' });
    const superseded = makeProposal({ uuid: 'hide-2', status: 'superseded' });
    const status = selectModerationStatus([rejected, superseded], 40);
    expect(status.hidden).toBeNull();
    expect(status.openHide).toBeNull();
  });

  it('lets a later approved unhide clear the banner', () => {
    // Unhiding IS a hide proposal with proposedValue 'false'. Scanning only for
    // 'true' would keep the banner up on a climb voted back into view.
    const hide = makeProposal({
      uuid: 'hide-1',
      status: 'approved',
      proposedValue: 'true',
      resolvedAt: '2026-09-02T10:00:00.000Z',
    });
    const unhide = makeProposal({
      uuid: 'hide-2',
      status: 'approved',
      proposedValue: 'false',
      currentValue: 'true',
      resolvedAt: '2026-09-05T10:00:00.000Z',
    });
    expect(selectModerationStatus([hide, unhide], 40).hidden).toBeNull();
    expect(selectModerationStatus([unhide, hide], 40).hidden).toBeNull();
  });

  it('re-hides when a hide follows an unhide', () => {
    const unhide = makeProposal({
      uuid: 'hide-1',
      status: 'approved',
      proposedValue: 'false',
      resolvedAt: '2026-09-02T10:00:00.000Z',
    });
    const reHide = makeProposal({
      uuid: 'hide-2',
      status: 'approved',
      proposedValue: 'true',
      resolvedAt: '2026-09-05T10:00:00.000Z',
    });
    expect(selectModerationStatus([unhide, reHide], 40).hidden?.uuid).toBe('hide-2');
  });

  it('surfaces the open hide report while the climb is still visible', () => {
    const open = makeProposal({ uuid: 'hide-1', status: 'open', weightedUpvotes: 3 });
    const status = selectModerationStatus([open], 40);
    expect(status.openHide).toBe(open);
    expect(status.hidden).toBeNull();
  });

  it('keeps the newest open hide when a stale duplicate lingers', () => {
    const stale = makeProposal({ uuid: 'hide-old', createdAt: '2026-08-01T10:00:00.000Z' });
    const live = makeProposal({ uuid: 'hide-new', createdAt: '2026-09-01T10:00:00.000Z' });
    expect(selectModerationStatus([live, stale], 40).openHide?.uuid).toBe('hide-new');
  });

  it('keeps only open grade proposals for the angle being played', () => {
    const atAngle = makeProposal({ uuid: 'grade-40', type: 'grade', angle: 40, proposedValue: 'V6' });
    const otherAngle = makeProposal({ uuid: 'grade-25', type: 'grade', angle: 25, proposedValue: 'V7' });
    const settled = makeProposal({
      uuid: 'grade-done',
      type: 'grade',
      angle: 40,
      status: 'approved',
      resolvedAt: '2026-09-02T10:00:00.000Z',
    });
    const angleless = makeProposal({ uuid: 'grade-null', type: 'grade', angle: null });

    const status = selectModerationStatus([atAngle, otherAngle, settled, angleless], 40);
    expect(status.openGradeAtAngle.map((proposal) => proposal.uuid)).toEqual(['grade-40']);
  });

  it('does not treat a classic or benchmark proposal as a grade one', () => {
    const classic = makeProposal({ uuid: 'classic-1', type: 'classic', angle: 40 });
    const benchmark = makeProposal({ uuid: 'benchmark-1', type: 'benchmark', angle: 40 });
    expect(selectModerationStatus([classic, benchmark], 40).openGradeAtAngle).toEqual([]);
  });
});

describe('an open unhide request', () => {
  it('is surfaced as the open hide proposal, and reads as an unhide', () => {
    // There is no `unhide` type — it is a `hide` proposal carrying 'false'. The
    // selector keeps it in `openHide` (it IS the live hide-type proposal), and
    // the banner branches on the value: "Reported by 2 climbers · 1 of 3 votes
    // to hide" on a climb the crew is voting back into view is backwards.
    const unhide = makeProposal({
      uuid: 'hide-1',
      status: 'open',
      proposedValue: 'false',
      currentValue: 'true',
    });
    const status = selectModerationStatus([unhide], 40);
    expect(status.openHide).toBe(unhide);
    expect(status.hidden).toBeNull();
    expect(isUnhideProposal(unhide)).toBe(true);
  });

  it('leaves a plain open report reading as a report', () => {
    const report = makeProposal({ uuid: 'hide-1', status: 'open', proposedValue: 'true' });
    expect(isUnhideProposal(selectModerationStatus([report], 40).openHide!)).toBe(false);
  });
});

describe('decidedBy', () => {
  it('credits the crew when nobody resolved it by hand', () => {
    expect(decidedBy(makeProposal({ uuid: 'hide-1', status: 'approved', resolvedBy: null }))).toBe('crew');
  });

  it('credits a moderator when resolvedBy carries a user id', () => {
    expect(decidedBy(makeProposal({ uuid: 'hide-1', status: 'approved', resolvedBy: 'admin-9' }))).toBe('moderator');
  });
});
