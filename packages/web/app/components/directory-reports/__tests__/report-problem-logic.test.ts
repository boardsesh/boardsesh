import { describe, expect, it } from 'vite-plus/test';
import { SYSTEM_BOARD_OWNER_ID } from '@boardsesh/shared-schema';
import {
  EMPTY_REPORT_DRAFT,
  NOT_SURE_DUPLICATE,
  buildReportBoardInput,
  buildReportGymInput,
  canSendReport,
  chooseReason,
  claimNudgeGym,
  reportAudienceFor,
  reportErrorKind,
  reportReasonsFor,
  sentMessageFor,
  shouldResetReportDialog,
  type ReportGymSubject,
  type ReportProblemTarget,
} from '../report-problem-logic';

const unclaimedGym: ReportGymSubject = {
  uuid: 'gym-1',
  name: 'Crux',
  slug: 'crux',
  listingState: 'UNCLAIMED',
  canClaim: true,
};
const runGym: ReportGymSubject = { ...unclaimedGym, listingState: 'RUN_BY_GYM', canClaim: false };

function boardTarget(
  overrides: { ownerId?: string | null; ownerDisplayName?: string | null; gym?: ReportGymSubject | null } = {},
): ReportProblemTarget {
  return {
    kind: 'board',
    board: {
      uuid: 'board-1',
      name: 'Kilter',
      ownerId: overrides.ownerId === undefined ? 'sam' : overrides.ownerId,
      ownerDisplayName: overrides.ownerDisplayName === undefined ? 'Sam' : overrides.ownerDisplayName,
    },
    gym: overrides.gym === undefined ? unclaimedGym : overrides.gym,
    otherBoards: [{ uuid: 'board-2', label: 'Kilter · 40°' }],
  };
}

describe('report reasons', () => {
  it('lists the board and gym reasons in the order the sheet shows them', () => {
    expect(reportReasonsFor('board')).toEqual(['wrong_setup', 'duplicate', 'gone', 'wrong_place', 'other']);
    expect(reportReasonsFor('gym')).toEqual(['duplicate', 'closed', 'wrong_details', 'not_a_gym', 'other']);
  });

  it('never offers the creator-only relist request', () => {
    expect(reportReasonsFor('board')).not.toContain('relist_request');
  });
});

describe('when Send is enabled', () => {
  it('waits for a reason', () => {
    expect(canSendReport(EMPTY_REPORT_DRAFT)).toBe(false);
    expect(canSendReport(chooseReason(EMPTY_REPORT_DRAFT, 'gone'))).toBe(true);
  });

  it('needs ten characters of note for Something else', () => {
    const other = chooseReason(EMPTY_REPORT_DRAFT, 'other');
    expect(canSendReport(other)).toBe(false);
    expect(canSendReport({ ...other, note: '   short   ' })).toBe(false);
    expect(canSendReport({ ...other, note: 'The wall is a 7x10 now' })).toBe(true);
  });

  it('refuses a note over 500 characters', () => {
    expect(canSendReport({ ...chooseReason(EMPTY_REPORT_DRAFT, 'gone'), note: 'x'.repeat(501) })).toBe(false);
  });
});

describe('changing the reason', () => {
  it('drops the duplicate pick but keeps the note', () => {
    const picked = { ...chooseReason(EMPTY_REPORT_DRAFT, 'duplicate'), duplicateBoardPick: 'board-2', note: 'hi' };
    const switched = chooseReason(picked, 'gone');
    expect(switched).toEqual({ reason: 'gone', duplicateBoardPick: null, duplicateGymUuid: null, note: 'hi' });
  });

  it('is a no-op for the same reason', () => {
    const picked = { ...chooseReason(EMPTY_REPORT_DRAFT, 'duplicate'), duplicateBoardPick: 'board-2' };
    expect(chooseReason(picked, 'duplicate')).toBe(picked);
  });
});

describe('the mutation inputs', () => {
  it('names the other board only for a duplicate the climber picked', () => {
    const duplicate = { ...chooseReason(EMPTY_REPORT_DRAFT, 'duplicate'), duplicateBoardPick: 'board-2' };
    expect(buildReportBoardInput('board-1', duplicate)).toEqual({
      boardUuid: 'board-1',
      reason: 'duplicate',
      duplicateOfBoardUuid: 'board-2',
      note: null,
    });
    expect(
      buildReportBoardInput('board-1', { ...duplicate, duplicateBoardPick: NOT_SURE_DUPLICATE })?.duplicateOfBoardUuid,
    ).toBeNull();
    expect(
      buildReportBoardInput('board-1', { ...duplicate, duplicateBoardPick: 'board-1' })?.duplicateOfBoardUuid,
    ).toBeNull();
  });

  it('trims the note and sends no note for whitespace', () => {
    const gone = chooseReason(EMPTY_REPORT_DRAFT, 'gone');
    expect(buildReportBoardInput('board-1', { ...gone, note: '  taken down  ' })?.note).toBe('taken down');
    expect(buildReportBoardInput('board-1', { ...gone, note: '   ' })?.note).toBeNull();
  });

  it('builds nothing until the draft can be sent', () => {
    expect(buildReportBoardInput('board-1', EMPTY_REPORT_DRAFT)).toBeNull();
    expect(buildReportGymInput('gym-1', chooseReason(EMPTY_REPORT_DRAFT, 'other'))).toBeNull();
  });

  it('names the other gym listing for a gym duplicate, never the gym itself', () => {
    const duplicate = { ...chooseReason(EMPTY_REPORT_DRAFT, 'duplicate'), duplicateGymUuid: 'gym-2' };
    expect(buildReportGymInput('gym-1', duplicate)).toEqual({
      gymUuid: 'gym-1',
      reason: 'duplicate',
      duplicateOfGymUuid: 'gym-2',
      note: null,
    });
    expect(buildReportGymInput('gym-1', { ...duplicate, duplicateGymUuid: 'gym-1' })?.duplicateOfGymUuid).toBeNull();
    const closed = { ...chooseReason(EMPTY_REPORT_DRAFT, 'closed'), duplicateGymUuid: 'gym-2' };
    expect(buildReportGymInput('gym-1', closed)?.duplicateOfGymUuid).toBeNull();
  });
});

describe('the routing line', () => {
  it('names the creator at a gym nobody runs', () => {
    expect(reportAudienceFor(boardTarget(), 'wrong_setup', 'viewer')).toBe('creator');
    expect(reportAudienceFor(boardTarget({ ownerDisplayName: null }), 'wrong_setup', 'viewer')).toBe('creator_hidden');
  });

  it('adds the staff of a gym run by the gym', () => {
    expect(reportAudienceFor(boardTarget({ gym: runGym }), 'gone', 'viewer')).toBe('creator_and_staff');
  });

  it('adds our team for wrong gym or place', () => {
    expect(reportAudienceFor(boardTarget(), 'wrong_place', 'viewer')).toBe('creator_and_team');
  });

  it('sends a synced board at an unclaimed gym to the team, saying why', () => {
    const synced = boardTarget({ ownerId: SYSTEM_BOARD_OWNER_ID, ownerDisplayName: 'Boardsesh' });
    expect(reportAudienceFor(synced, 'wrong_setup', 'viewer')).toBe('team_unclaimed_gym');
    expect(reportAudienceFor(boardTarget({ ownerId: SYSTEM_BOARD_OWNER_ID, gym: runGym }), 'gone', 'viewer')).toBe(
      'staff',
    );
  });

  it('never routes a report back to the creator filing it', () => {
    expect(reportAudienceFor(boardTarget({ ownerId: 'viewer' }), 'gone', 'viewer')).toBe('team_unclaimed_gym');
    expect(reportAudienceFor(boardTarget({ ownerId: 'viewer', gym: null }), 'gone', 'viewer')).toBe('team');
    expect(reportAudienceFor(boardTarget({ ownerId: 'viewer', gym: runGym }), 'gone', 'viewer')).toBe('staff');
  });

  it('words the common case before a reason is picked', () => {
    expect(reportAudienceFor(boardTarget(), null, null)).toBe('creator');
    expect(reportAudienceFor({ kind: 'gym', gym: unclaimedGym }, null, null)).toBe('team');
  });

  it('sends wrong details on a gym run by the gym to its staff, everything else to the team', () => {
    expect(reportAudienceFor({ kind: 'gym', gym: runGym }, 'wrong_details', null)).toBe('staff');
    expect(reportAudienceFor({ kind: 'gym', gym: runGym }, 'closed', null)).toBe('team');
    expect(reportAudienceFor({ kind: 'gym', gym: { ...runGym, listingState: null } }, 'wrong_details', null)).toBe(
      'team',
    );
  });
});

describe('the claim nudge', () => {
  it('shows for a gym the viewer can claim that nobody runs yet', () => {
    expect(claimNudgeGym(boardTarget())).toBe(unclaimedGym);
    expect(claimNudgeGym({ kind: 'gym', gym: { ...unclaimedGym, listingState: 'CLIMBER_LISTED' } })).not.toBeNull();
  });

  it('hides for a gym run by the gym, one the viewer cannot claim, or no gym', () => {
    expect(claimNudgeGym(boardTarget({ gym: { ...unclaimedGym, listingState: 'RUN_BY_GYM' } }))).toBeNull();
    expect(claimNudgeGym(boardTarget({ gym: { ...unclaimedGym, canClaim: false } }))).toBeNull();
    expect(claimNudgeGym(boardTarget({ gym: null }))).toBeNull();
  });
});

describe('the done state', () => {
  it('says sent, joined or already reported', () => {
    expect(sentMessageFor({ status: 'created', otherReporterCount: 0 })).toEqual({ kind: 'sent' });
    expect(sentMessageFor({ status: 'added', otherReporterCount: 2 })).toEqual({ kind: 'joined', count: 2 });
    expect(sentMessageFor({ status: 'added', otherReporterCount: 0 })).toEqual({ kind: 'sent' });
    expect(sentMessageFor({ status: 'already_reported', otherReporterCount: 3 })).toEqual({ kind: 'already' });
  });

  it('tells an offline climber to connect', () => {
    expect(reportErrorKind(false)).toBe('offline');
    expect(reportErrorKind(true)).toBe('error');
  });
});

describe('shouldResetReportDialog', () => {
  const closed = { open: false, targetKey: null };
  it('resets when the dialog opens', () => {
    expect(shouldResetReportDialog(closed, { open: true, targetKey: 'board:a' })).toBe(true);
  });
  it('keeps the draft when the target goes null and comes back (token rotation)', () => {
    const open = { open: true, targetKey: 'board:a' };
    expect(shouldResetReportDialog(open, { open: true, targetKey: null })).toBe(false);
    expect(shouldResetReportDialog({ open: true, targetKey: 'board:a' }, { open: true, targetKey: 'board:a' })).toBe(
      false,
    );
  });
  it('resets between two different real targets', () => {
    expect(shouldResetReportDialog({ open: true, targetKey: 'board:a' }, { open: true, targetKey: 'board:b' })).toBe(
      true,
    );
  });
  it('never resets while closed', () => {
    expect(shouldResetReportDialog({ open: true, targetKey: 'board:a' }, { open: false, targetKey: 'board:a' })).toBe(
      false,
    );
  });
});
