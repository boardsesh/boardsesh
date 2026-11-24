import { describe, expect, it } from 'vitest';
import { SYSTEM_BOARD_OWNER_ID } from '@boardsesh/shared-schema';
import {
  boardReportAudience,
  canReportBoard,
  canReportGym,
  canSendReport,
  canSendSetupReport,
  gymReportAudience,
  reportDoneCopy,
  setupDoneCopy,
  setupSuggestionLine,
  showClaimNudge,
  viewerCanFixBoard,
} from '../report-problem-model';

const climberBoard = { ownerId: 'sam', ownerDisplayName: 'Sam', gymUuid: 'gym-1' };

describe('who is offered Report a problem', () => {
  it('is everyone who cannot fix the board, with the flag on', () => {
    expect(canReportBoard({ ownerId: 'sam' }, { enabled: true, viewerUserId: 'alex' })).toBe(true);
    expect(canReportBoard({ ownerId: 'sam' }, { enabled: false, viewerUserId: 'alex' })).toBe(false);
    // Signed out: still offered, and the tap opens login.
    expect(canReportBoard({ ownerId: 'sam' }, { enabled: true, viewerUserId: null })).toBe(true);
  });

  it.each([
    ['the creator', { ownerId: 'alex' }],
    ['an editor', { ownerId: 'sam', canEdit: true }],
    ['staff who can remove it', { ownerId: 'sam', canRemoveFromGym: true }],
    ['staff who can delete it', { ownerId: SYSTEM_BOARD_OWNER_ID, canDelete: true }],
  ])('gives %s the fix actions instead', (_who, board) => {
    expect(viewerCanFixBoard(board, 'alex')).toBe(true);
    expect(canReportBoard(board, { enabled: true, viewerUserId: 'alex' })).toBe(false);
  });

  it('offers a gym report to anyone who cannot edit the gym', () => {
    expect(canReportGym({ canEdit: false }, { enabled: true })).toBe(true);
    expect(canReportGym({ canEdit: true }, { enabled: true })).toBe(false);
    expect(canReportGym({ canEdit: false }, { enabled: false })).toBe(false);
  });
});

describe('who will see a board report', () => {
  it('names the creator alone at a gym nobody runs', () => {
    expect(
      boardReportAudience({ board: climberBoard, reason: null, viewerUserId: 'alex', gymListingState: 'UNCLAIMED' }),
    ).toBe('creator');
  });

  it('adds the staff of a gym run by the gym, and the team for the wrong place', () => {
    expect(
      boardReportAudience({
        board: climberBoard,
        reason: 'wrong_setup',
        viewerUserId: 'alex',
        gymListingState: 'RUN_BY_GYM',
      }),
    ).toBe('creator_and_staff');
    expect(
      boardReportAudience({
        board: climberBoard,
        reason: 'wrong_place',
        viewerUserId: 'alex',
        gymListingState: 'RUN_BY_GYM',
      }),
    ).toBe('creator_staff_and_team');
  });

  it('keeps a hidden creator unnamed', () => {
    expect(
      boardReportAudience({
        board: { ...climberBoard, ownerDisplayName: null },
        reason: 'gone',
        viewerUserId: 'alex',
        gymListingState: null,
      }),
    ).toBe('creator_hidden');
  });

  it('sends a synced board at an unclaimed gym to the team, saying why', () => {
    expect(
      boardReportAudience({
        board: { ownerId: SYSTEM_BOARD_OWNER_ID, gymUuid: 'gym-1' },
        reason: 'duplicate',
        viewerUserId: 'alex',
        gymListingState: 'UNCLAIMED',
      }),
    ).toBe('team_unclaimed_gym');
    expect(
      boardReportAudience({
        board: { ownerId: SYSTEM_BOARD_OWNER_ID, gymUuid: 'gym-1' },
        reason: 'duplicate',
        viewerUserId: 'alex',
        gymListingState: 'RUN_BY_GYM',
      }),
    ).toBe('staff');
  });

  it('routes gym reports: staff fix their own details, the team takes the rest', () => {
    expect(gymReportAudience('wrong_details', 'RUN_BY_GYM')).toBe('staff');
    expect(gymReportAudience('closed', 'RUN_BY_GYM')).toBe('team');
    expect(gymReportAudience(null, 'UNCLAIMED')).toBe('team');
  });
});

describe('the report sheet', () => {
  it('offers the claim on a gym the viewer may claim that nobody runs yet', () => {
    expect(showClaimNudge({ canClaim: true, listingState: 'UNCLAIMED' })).toBe(true);
    expect(showClaimNudge({ canClaim: true, listingState: 'CLIMBER_LISTED' })).toBe(true);
    expect(showClaimNudge({ canClaim: true, listingState: 'RUN_BY_GYM' })).toBe(false);
    expect(showClaimNudge({ canClaim: false, listingState: 'UNCLAIMED' })).toBe(false);
    expect(showClaimNudge(null)).toBe(false);
  });

  it('sends once a reason is picked, and "Something else" once it says enough', () => {
    expect(canSendReport(null, '')).toBe(false);
    expect(canSendReport('wrong_setup', '')).toBe(true);
    expect(canSendReport('other', 'too short')).toBe(false);
    expect(canSendReport('other', 'The holds are from another set')).toBe(true);
    expect(canSendReport('gone', 'x'.repeat(501))).toBe(false);
  });

  it('words the done state from the server status', () => {
    expect(reportDoneCopy({ status: 'created', otherReporterCount: 0 })).toEqual({ kind: 'sent' });
    expect(reportDoneCopy({ status: 'added', otherReporterCount: 2 })).toEqual({ kind: 'joined', count: 2 });
    expect(reportDoneCopy({ status: 'already_reported', otherReporterCount: 3 })).toEqual({ kind: 'already_reported' });
  });
});

describe('suggesting the setup', () => {
  it('sends a changed setup with or without a note, and an unchanged one only with enough words', () => {
    expect(canSendSetupReport({ setupChanged: true, note: '' })).toBe(true);
    expect(canSendSetupReport({ setupChanged: false, note: '' })).toBe(false);
    expect(canSendSetupReport({ setupChanged: false, note: '  12x14  ' })).toBe(false);
    expect(canSendSetupReport({ setupChanged: false, note: 'The kicker is gone' })).toBe(true);
    expect(canSendSetupReport({ setupChanged: true, note: 'x'.repeat(501) })).toBe(false);
  });

  it('words the line under Send from the gym, and waits for the gym to load', () => {
    expect(setupSuggestionLine({ boardGymUuid: 'gym-1', gymListingState: 'UNCLAIMED' })).toBe('applies_for_everyone');
    expect(setupSuggestionLine({ boardGymUuid: 'gym-1', gymListingState: 'CLIMBER_LISTED' })).toBe(
      'applies_for_everyone',
    );
    expect(setupSuggestionLine({ boardGymUuid: 'gym-1', gymListingState: 'RUN_BY_GYM' })).toBe('staff_review');
    expect(setupSuggestionLine({ boardGymUuid: null, gymListingState: null })).toBe('creator_review');
    expect(setupSuggestionLine({ boardGymUuid: 'gym-1', gymListingState: null })).toBeNull();
  });

  it('picks the done step from the outcome', () => {
    // Applied whether or not the answer carried the board: the change committed.
    expect(setupDoneCopy({ setupOutcome: 'APPLIED', setupReviewReason: null })).toEqual({ kind: 'applied' });
    expect(setupDoneCopy({ setupOutcome: 'SENT_FOR_REVIEW', setupReviewReason: 'CLAIMED_GYM' })).toEqual({
      kind: 'review',
      reason: 'CLAIMED_GYM',
    });
    // The server's flag is off: no reason, so the plain done line.
    expect(setupDoneCopy({ setupOutcome: 'SENT_FOR_REVIEW', setupReviewReason: null })).toBeNull();
    expect(setupDoneCopy({ setupOutcome: null, setupReviewReason: null })).toBeNull();
  });
});
