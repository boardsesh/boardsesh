import { describe, it, expect } from 'vitest';
import { pickReportAudience, REPORT_AUDIENCE_COPY_KEYS, type ReportAudience } from '../audience';
import { routeBoardReport, routeGymReport } from '../routing';
import {
  normalizeReportNote,
  OTHER_REASON_NOTE_MIN_LENGTH,
  REPORT_NOTE_MAX_LENGTH,
  reportNoteProblem,
  resolutionNoteProblem,
} from '../notes';
import {
  ESCALATE_AFTER_DAYS,
  isReportEscalationDue,
  isReportReminderDue,
  REMINDER_AFTER_DAYS,
  reportEscalatesAt,
} from '../timing';
import {
  BOARD_REPORT_REASONS,
  DIRECTORY_REPORT_REASONS,
  GYM_REPORT_REASONS,
  isCreatorOnlyBoardReportReason,
  isDirectoryReportOutcome,
  isOpenDirectoryReportStatus,
} from '../reasons';

describe('pickReportAudience', () => {
  const pick = (
    recipients: Parameters<typeof pickReportAudience>[0]['recipients'],
    overrides: Partial<Parameters<typeof pickReportAudience>[0]> = {},
  ): ReportAudience =>
    pickReportAudience({
      targetKind: 'board',
      recipients,
      creatorNameVisible: true,
      gymListingState: 'RUN_BY_GYM',
      ...overrides,
    });

  it('names the creator only when the viewer may see their name', () => {
    expect(pick(['creator'])).toBe('creator');
    expect(pick(['creator'], { creatorNameVisible: false })).toBe('creator_hidden');
    expect(pick(['creator', 'gym_staff'])).toBe('creator_and_staff');
    expect(pick(['creator', 'gym_staff'], { creatorNameVisible: false })).toBe('creator_hidden_and_staff');
    expect(pick(['creator', 'admin'])).toBe('creator_and_team');
    expect(pick(['creator', 'gym_staff', 'admin'], { creatorNameVisible: false })).toBe(
      'creator_hidden_staff_and_team',
    );
  });

  it('says why only the team will see it when nobody runs the gym', () => {
    expect(pick(['admin'], { gymListingState: 'UNCLAIMED' })).toBe('team_unclaimed_gym');
    expect(pick(['admin'], { gymListingState: 'CLIMBER_LISTED' })).toBe('team');
    expect(pick(['admin'], { targetKind: 'gym', gymListingState: 'UNCLAIMED' })).toBe('team');
  });

  it('agrees with the routing for every board case', () => {
    const routing = routeBoardReport({
      reason: 'wrong_place',
      boardOwnedBySystem: true,
      viewerIsCreator: false,
      hasGym: true,
      gymListingState: 'RUN_BY_GYM',
    });
    expect(pick(routing.recipients)).toBe('staff_and_team');
    const gymRouting = routeGymReport({ reason: 'wrong_details', gymListingState: 'RUN_BY_GYM' });
    expect(pick(gymRouting.recipients, { targetKind: 'gym' })).toBe('staff');
  });

  it('has a catalogue key for every audience', () => {
    const audiences: ReportAudience[] = [
      'creator',
      'creator_hidden',
      'creator_and_staff',
      'creator_hidden_and_staff',
      'creator_and_team',
      'creator_hidden_and_team',
      'creator_staff_and_team',
      'creator_hidden_staff_and_team',
      'staff',
      'staff_and_team',
      'team_unclaimed_gym',
      'team',
    ];
    for (const audience of audiences) expect(REPORT_AUDIENCE_COPY_KEYS[audience]).toMatch(/^report\.route/);
  });
});

describe('report notes', () => {
  it('trims, and treats blank as no note', () => {
    expect(normalizeReportNote('  12x14 at 40°  ')).toBe('12x14 at 40°');
    expect(normalizeReportNote('   ')).toBeNull();
    expect(normalizeReportNote(undefined)).toBeNull();
  });

  it('requires ten characters for "something else", counted after trimming', () => {
    expect(reportNoteProblem('other', null)).toBe('required');
    expect(reportNoteProblem('other', '   ')).toBe('required');
    expect(reportNoteProblem('other', `  ${'x'.repeat(OTHER_REASON_NOTE_MIN_LENGTH - 1)}  `)).toBe('too_short');
    expect(reportNoteProblem('other', 'x'.repeat(OTHER_REASON_NOTE_MIN_LENGTH))).toBeNull();
  });

  it('keeps every other reason optional, and caps every note', () => {
    expect(reportNoteProblem('wrong_setup', null)).toBeNull();
    expect(reportNoteProblem('wrong_setup', 'x'.repeat(REPORT_NOTE_MAX_LENGTH))).toBeNull();
    expect(reportNoteProblem('wrong_setup', 'x'.repeat(REPORT_NOTE_MAX_LENGTH + 1))).toBe('too_long');
    expect(resolutionNoteProblem(` ${'x'.repeat(REPORT_NOTE_MAX_LENGTH)} `)).toBeNull();
    expect(resolutionNoteProblem('x'.repeat(REPORT_NOTE_MAX_LENGTH + 1))).toBe('too_long');
  });
});

describe('report timing', () => {
  const createdAt = new Date('2026-11-01T10:00:00Z');
  const day = 24 * 60 * 60 * 1000;

  it('reminds once after seven days', () => {
    const due = new Date(createdAt.getTime() + REMINDER_AFTER_DAYS * day);
    expect(isReportReminderDue({ createdAt, remindedAt: null }, new Date(due.getTime() - 1))).toBe(false);
    expect(isReportReminderDue({ createdAt, remindedAt: null }, due)).toBe(true);
    expect(isReportReminderDue({ createdAt, remindedAt: due }, new Date(due.getTime() + day))).toBe(false);
  });

  it('escalates after fourteen days', () => {
    expect(reportEscalatesAt(createdAt).toISOString()).toBe('2026-11-15T10:00:00.000Z');
    const due = new Date(createdAt.getTime() + ESCALATE_AFTER_DAYS * day);
    expect(isReportEscalationDue({ createdAt }, new Date(due.getTime() - 1))).toBe(false);
    expect(isReportEscalationDue({ createdAt }, due)).toBe(true);
  });
});

describe('reasons and statuses', () => {
  it('every board and gym reason is in the shared enum', () => {
    for (const reason of [...BOARD_REPORT_REASONS, ...GYM_REPORT_REASONS]) {
      expect(DIRECTORY_REPORT_REASONS).toContain(reason);
    }
  });

  it('relist_request is the creator-only reason', () => {
    expect(isCreatorOnlyBoardReportReason('relist_request')).toBe(true);
    expect(isCreatorOnlyBoardReportReason('wrong_setup')).toBe(false);
  });

  it('open and escalated are waiting; the rest are outcomes', () => {
    expect(isOpenDirectoryReportStatus('open')).toBe(true);
    expect(isOpenDirectoryReportStatus('escalated')).toBe(true);
    expect(isDirectoryReportOutcome('escalated')).toBe(false);
    for (const outcome of ['fixed', 'removed', 'deleted', 'kept', 'merged']) {
      expect(isDirectoryReportOutcome(outcome)).toBe(true);
      expect(isOpenDirectoryReportStatus(outcome)).toBe(false);
    }
  });
});
