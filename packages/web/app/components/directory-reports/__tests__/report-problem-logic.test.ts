import { describe, expect, it } from 'vite-plus/test';
import { SYSTEM_BOARD_OWNER_ID } from '@boardsesh/shared-schema';
import {
  getBoardLayouts,
  getBoardSetsForLayoutAndSize,
  getBoardSizesForLayoutId,
  setupSelectionReducer,
} from '@boardsesh/board-config';
import {
  EMPTY_REPORT_DRAFT,
  NOT_SURE_DUPLICATE,
  buildReportBoardInput,
  buildReportGymInput,
  canSendReport,
  chooseReason,
  claimNudgeGym,
  draftSetupSelection,
  reportAudienceFor,
  reportErrorKind,
  reportReasonsFor,
  sentMessageFor,
  sentMessageForError,
  setupFieldsBoard,
  setupPreviewFor,
  shouldResetReportDialog,
  type ReportBoardSetup,
  type ReportDraft,
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

// A real Kilter layout with two sizes, found in the bundled catalogue.
const kilterLayout = getBoardLayouts('kilter').find(
  (layout) => getBoardSizesForLayoutId('kilter', layout.id).length >= 2,
);
if (!kilterLayout) throw new Error('Expected a Kilter layout with two sizes');
const [kilterSize, otherKilterSize] = getBoardSizesForLayoutId('kilter', kilterLayout.id);
const kilterSetIds = getBoardSetsForLayoutAndSize('kilter', kilterLayout.id, kilterSize.id).map((set) => set.id);

const kilterSetup: ReportBoardSetup = {
  boardType: 'kilter',
  layoutId: kilterLayout.id,
  sizeId: kilterSize.id,
  setIds: kilterSetIds.join(','),
  angle: 40,
  isAngleAdjustable: true,
};

function boardTarget(
  overrides: {
    ownerId?: string | null;
    ownerDisplayName?: string | null;
    gym?: ReportGymSubject | null;
    setup?: ReportBoardSetup | null;
  } = {},
): ReportProblemTarget {
  return {
    kind: 'board',
    board: {
      uuid: 'board-1',
      name: 'Kilter',
      ownerId: overrides.ownerId === undefined ? 'sam' : overrides.ownerId,
      ownerDisplayName: overrides.ownerDisplayName === undefined ? 'Sam' : overrides.ownerDisplayName,
      setup: overrides.setup === undefined ? kilterSetup : overrides.setup,
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
    expect(switched).toEqual({
      reason: 'gone',
      duplicateBoardPick: null,
      duplicateGymUuid: null,
      note: 'hi',
      setup: null,
    });
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

describe('the setup fields', () => {
  const wrongSetup = chooseReason(EMPTY_REPORT_DRAFT, 'wrong_setup');

  it('show only for "Set up wrong" with the flag on, on a board with a known setup', () => {
    expect(setupFieldsBoard(boardTarget(), 'wrong_setup', true)).toBe(kilterSetup);
    expect(setupFieldsBoard(boardTarget(), 'wrong_setup', false)).toBeNull();
    expect(setupFieldsBoard(boardTarget(), 'gone', true)).toBeNull();
    expect(setupFieldsBoard(boardTarget(), null, true)).toBeNull();
    expect(setupFieldsBoard(boardTarget({ setup: null }), 'wrong_setup', true)).toBeNull();
    expect(setupFieldsBoard(boardTarget({ setup: { ...kilterSetup, boardType: 'spray' } }), 'wrong_setup', true)).toBe(
      null,
    );
    expect(
      setupFieldsBoard(boardTarget({ setup: { ...kilterSetup, boardType: 'not-a-board' } }), 'wrong_setup', true),
    ).toBeNull();
    expect(setupFieldsBoard({ kind: 'gym', gym: unclaimedGym }, 'other', true)).toBeNull();
  });

  it("start on the board's current setup", () => {
    expect(draftSetupSelection(wrongSetup, kilterSetup)).toMatchObject({
      layoutId: kilterLayout.id,
      sizeId: kilterSize.id,
      setIds: kilterSetIds,
      angleIsFixed: false,
    });
  });

  it('keep Send off until the setup differs', () => {
    expect(canSendReport(wrongSetup)).toBe(true);
    expect(canSendReport(wrongSetup, kilterSetup)).toBe(false);
    const selection = draftSetupSelection(wrongSetup, kilterSetup);
    if (!selection) throw new Error('Expected a selection');
    const changed: ReportDraft = {
      ...wrongSetup,
      setup: setupSelectionReducer(selection, { type: 'selectSize', sizeId: otherKilterSize.id }),
    };
    expect(canSendReport(changed, kilterSetup)).toBe(true);
    // Picked back to what the board has: nothing to suggest.
    const back: ReportDraft = {
      ...changed,
      setup: setupSelectionReducer(changed.setup ?? selection, { type: 'selectSize', sizeId: kilterSize.id }),
    };
    expect(canSendReport(back, kilterSetup)).toBe(false);
  });

  it('send the picked setup, sets in canonical order, no angle on a board that tilts', () => {
    const selection = draftSetupSelection(wrongSetup, kilterSetup);
    if (!selection) throw new Error('Expected a selection');
    const setup = setupSelectionReducer(selection, { type: 'selectSize', sizeId: otherKilterSize.id });
    const input = buildReportBoardInput('board-1', { ...wrongSetup, setup, note: ' 7x10 now ' }, kilterSetup);
    expect(input).toEqual({
      boardUuid: 'board-1',
      reason: 'wrong_setup',
      duplicateOfBoardUuid: null,
      note: '7x10 now',
      suggestedSetup: {
        layoutId: kilterLayout.id,
        sizeId: otherKilterSize.id,
        setIds: [...setup.setIds].sort((first, second) => first - second).join(','),
        angle: null,
      },
    });
    // Without the fields the input carries no suggestion, as before.
    expect(buildReportBoardInput('board-1', { ...wrongSetup, setup })).not.toHaveProperty('suggestedSetup');
  });

  it('send the angle of a board that does not tilt', () => {
    const fixed: ReportBoardSetup = { ...kilterSetup, isAngleAdjustable: false };
    const selection = draftSetupSelection(wrongSetup, fixed);
    if (!selection) throw new Error('Expected a selection');
    const setup = setupSelectionReducer(selection, { type: 'selectAngle', angle: 45 });
    expect(buildReportBoardInput('board-1', { ...wrongSetup, setup }, fixed)?.suggestedSetup?.angle).toBe(45);
  });

  it('word the line above Send from the gym', () => {
    expect(setupPreviewFor(boardTarget())).toBe('applies_for_everyone');
    expect(setupPreviewFor(boardTarget({ gym: { ...unclaimedGym, listingState: 'CLIMBER_LISTED' } }))).toBe(
      'applies_for_everyone',
    );
    expect(setupPreviewFor(boardTarget({ gym: runGym }))).toBe('staff_review');
    expect(setupPreviewFor(boardTarget({ gym: null }))).toBe('creator_review');
  });

  it('say nothing above Send when the gym is known but its state did not load', () => {
    // The rule would read an unknown state as no gym ("the creator checks it first") while the server may apply it.
    expect(setupPreviewFor(boardTarget({ gym: { ...unclaimedGym, listingState: null } }))).toBeNull();
  });

  it('start without a set the catalogue does not list, and open unchanged', () => {
    const withUnlisted: ReportBoardSetup = { ...kilterSetup, setIds: `${kilterSetup.setIds},99999` };
    const selection = draftSetupSelection(wrongSetup, withUnlisted);
    expect(selection?.setIds).toEqual(kilterSetIds);
    expect(canSendReport(wrongSetup, withUnlisted)).toBe(false);
  });
});

describe('the done state after a suggested setup', () => {
  it('says the board changed, or why it waits', () => {
    expect(
      sentMessageFor({ status: 'created', otherReporterCount: 0, setupOutcome: 'APPLIED', setupReviewReason: null }),
    ).toEqual({ kind: 'setup_applied' });
    expect(
      sentMessageFor({
        status: 'added',
        otherReporterCount: 2,
        setupOutcome: 'SENT_FOR_REVIEW',
        setupReviewReason: 'CLAIMED_GYM',
      }),
    ).toEqual({ kind: 'setup_review', reason: 'CLAIMED_GYM' });
  });

  it('reads a refusal of the setup the board has now as done, and nothing else', () => {
    const unchanged = {
      response: {
        errors: [{ message: 'same', extensions: { code: 'BAD_USER_INPUT', reason: 'SETUP_UNCHANGED' } }],
      },
    };
    expect(sentMessageForError(unchanged)).toEqual({ kind: 'setup_unchanged' });
    const otherBadInput = { response: { errors: [{ message: 'bad', extensions: { code: 'BAD_USER_INPUT' } }] } };
    expect(sentMessageForError(otherBadInput)).toBeNull();
    expect(sentMessageForError(new Error('network down'))).toBeNull();
  });

  it("keeps today's words when the server gives no reason (the flag off)", () => {
    expect(
      sentMessageFor({
        status: 'created',
        otherReporterCount: 0,
        setupOutcome: 'SENT_FOR_REVIEW',
        setupReviewReason: null,
      }),
    ).toEqual({ kind: 'sent' });
    expect(
      sentMessageFor({
        status: 'added',
        otherReporterCount: 3,
        setupOutcome: 'SENT_FOR_REVIEW',
        setupReviewReason: null,
      }),
    ).toEqual({ kind: 'joined', count: 3 });
  });
});
