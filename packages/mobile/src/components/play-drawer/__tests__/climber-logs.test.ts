import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FollowingClimbAscentItem } from '@boardsesh/graphql/operations';
import {
  INLINE_CLIMBER_LOG_CAP,
  buildClimberLogListItems,
  deriveCrewCounts,
  describeResult,
  filterClimberLogs,
  followingSectionCount,
  groupClimberLogs,
  otherAnglesNoticeCount,
  rankClimberLogGroups,
  takeInlineGroups,
  describeBareNames,
  foldEarlierLogs,
  gradeDisagrees,
  isBareLog,
  partitionClimberLogGroups,
  planClimberLogsCard,
  tallyDisagreeingGrades,
  type ClimberLog,
  type ClimberLogFilters,
  type ClimberLogListOptions,
} from '../climber-logs';

// Pinned so "distinct local days" does not depend on the machine's zone.
// America/Phoenix is UTC-7 all year (no DST).
beforeAll(() => {
  vi.stubEnv('TZ', 'America/Phoenix');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

let nextId = 0;
function log(overrides: Partial<ClimberLog> = {}): ClimberLog {
  nextId += 1;
  return {
    uuid: `log-${nextId}`,
    userId: 'mika',
    userDisplayName: 'Mika',
    userAvatarUrl: null,
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: false,
    status: 'attempt',
    attemptCount: 1,
    quality: null,
    effectiveQuality: null,
    difficulty: null,
    comment: '',
    climbedAt: '2026-03-10T18:00:00',
    ...overrides,
  };
}

const NO_FILTERS: ClimberLogFilters = { angleOnly: false, withNotes: false, sendsOnly: false };
const TWO_COLUMNS: ClimberLogListOptions = { columns: 2, boardAngle: 40, climbGradeId: 16 };
const ONE_COLUMN: ClimberLogListOptions = { ...TWO_COLUMNS, columns: 1 };

describe('gradeDisagrees and isBareLog', () => {
  it('counts a grade at the board angle that is not the climb grade', () => {
    expect(gradeDisagrees(log({ difficulty: 18 }), 40, 16)).toBe(true);
    expect(gradeDisagrees(log({ difficulty: 16 }), 40, 16)).toBe(false);
    expect(gradeDisagrees(log({ difficulty: null }), 40, 16)).toBe(false);
  });

  it('never counts a grade given at another angle', () => {
    expect(gradeDisagrees(log({ angle: 45, difficulty: 18 }), 40, 16)).toBe(false);
    expect(isBareLog(log({ angle: 45, difficulty: 18 }), 40, 16)).toBe(true);
  });

  it('counts any grade at the board angle when the climb grade is unknown', () => {
    expect(gradeDisagrees(log({ difficulty: 16 }), 40, null)).toBe(true);
    expect(isBareLog(log({ difficulty: 16 }), 40, null)).toBe(false);
    expect(gradeDisagrees(log({ angle: 45, difficulty: 16 }), 40, null)).toBe(false);
  });

  it('never lets stars make a log loud', () => {
    expect(isBareLog(log({ status: 'send', quality: 5, effectiveQuality: 5 }), 40, 16)).toBe(true);
  });

  it('is loud for a note, and bare for a blank one', () => {
    expect(isBareLog(log({ comment: 'toe hook' }), 40, 16)).toBe(false);
    expect(isBareLog(log({ comment: '   ' }), 40, 16)).toBe(true);
  });
});

describe('groupClimberLogs', () => {
  it('gives one group per climber', () => {
    const groups = groupClimberLogs([log(), log(), log({ userId: 'jonas', userDisplayName: 'Jonas' })], 40, null);
    expect(groups.map((group) => group.userId)).toEqual(['mika', 'jonas']);
    expect(groups[0].earlier).toHaveLength(1);
    expect(groups[1].earlier).toHaveLength(0);
  });

  it('leads with a send over a no-send, then the board angle, then the newest', () => {
    const tryAtAngle = log({ angle: 40, status: 'attempt', climbedAt: '2026-03-01T10:00:00' });
    const sentElsewhere = log({ angle: 45, status: 'send', climbedAt: '2026-01-01T10:00:00' });
    expect(groupClimberLogs([tryAtAngle, sentElsewhere], 40, null)[0].lead.uuid).toBe(sentElsewhere.uuid);

    const sentAtAngle = log({ userId: 'jonas', angle: 40, status: 'flash', climbedAt: '2026-01-01T10:00:00' });
    const newerSendElsewhere = log({ userId: 'jonas', angle: 45, status: 'send', climbedAt: '2026-03-01T10:00:00' });
    expect(groupClimberLogs([newerSendElsewhere, sentAtAngle], 40, null)[0].lead.uuid).toBe(sentAtAngle.uuid);

    const older = log({ userId: 'priya', climbedAt: '2026-01-01T10:00:00' });
    const newer = log({ userId: 'priya', climbedAt: '2026-03-01T10:00:00' });
    expect(groupClimberLogs([older, newer], 40, null)[0].lead.uuid).toBe(newer.uuid);
  });

  it('reads a climber who sent without a note, and noted an older no-send, as a send with that note', () => {
    const notedTry = log({
      status: 'attempt',
      attemptCount: 5,
      comment: '  Cannot hold the swing  ',
      climbedAt: '2026-01-10T10:00:00',
    });
    const send = log({ status: 'send', attemptCount: 2, climbedAt: '2026-03-09T10:00:00' });
    const [group] = groupClimberLogs([notedTry, send], 40, 16);

    // The result and the time are the send's; the note is the one they left.
    expect(describeResult(group.lead)).toEqual({ kind: 'sent', tries: 2 });
    expect(group.lead.climbedAt).toBe('2026-03-09T10:00:00');
    expect(group.note).toBe('Cannot hold the swing');
    expect(group).toMatchObject({ hasNote: true, sent: true, bare: false });
    expect(group.earlier.map((entry) => entry.uuid)).toEqual([notedTry.uuid]);
  });

  it('takes the note from the newest log that has one', () => {
    const [group] = groupClimberLogs(
      [
        log({ comment: 'old beta', climbedAt: '2026-01-01T10:00:00' }),
        log({ comment: 'new beta', climbedAt: '2026-02-01T10:00:00' }),
        log({ status: 'send', climbedAt: '2026-03-01T10:00:00' }),
      ],
      40,
      16,
    );
    expect(group.note).toBe('new beta');
  });

  it('treats a whitespace-only comment as no note', () => {
    const groups = groupClimberLogs([log({ comment: '   ' })], 40, null);
    expect(groups[0]).toMatchObject({ hasNote: false, note: null });
  });

  it('takes a disagreeing grade from the log that carries it, not from the lead', () => {
    const graded = log({ status: 'attempt', difficulty: 18, climbedAt: '2026-01-01T10:00:00' });
    const newerSend = log({ status: 'send', climbedAt: '2026-03-01T10:00:00' });
    const [group] = groupClimberLogs([newerSend, graded], 40, 16);
    expect(group.lead.uuid).toBe(newerSend.uuid);
    expect(group).toMatchObject({ disagreeingGradeId: 18, gradeDisagrees: true, bare: false, sent: true });
  });

  it('marks a climber bare only when no log of theirs has anything to add', () => {
    const [bareSender] = groupClimberLogs([log({ status: 'send', quality: 5 }), log({ status: 'attempt' })], 40, 16);
    expect(bareSender).toMatchObject({ bare: true, sent: true });

    const [agrees] = groupClimberLogs([log({ status: 'send', difficulty: 16 })], 40, 16);
    expect(agrees.bare).toBe(true);

    const [bareTrier] = groupClimberLogs([log({ status: 'attempt' })], 40, 16);
    expect(bareTrier).toMatchObject({ bare: true, sent: false });

    const [loud] = groupClimberLogs([log({ status: 'send' }), log({ comment: 'beta' })], 40, 16);
    expect(loud.bare).toBe(false);
  });

  it('lists the other logs newest first and floors each at one try', () => {
    const lead = log({ status: 'send', climbedAt: '2026-01-01T10:00:00' });
    const imported = log({ attemptCount: 0, climbedAt: '2026-02-01T10:00:00' });
    const session = log({ attemptCount: 4, climbedAt: '2026-03-01T10:00:00' });
    const [group] = groupClimberLogs([lead, imported, session], 40, null);
    expect(group.earlier.map((entry) => entry.uuid)).toEqual([session.uuid, imported.uuid]);
    expect(group.earlierTries).toBe(5);
  });

  it('counts earlier days in local time, so a pair either side of local midnight is two days', () => {
    const lead = log({ status: 'send', climbedAt: '2026-03-20T10:00:00' });
    // 06:30 and 07:30 UTC on the same UTC date are 23:30 and 00:30 in Phoenix.
    const beforeMidnight = log({ climbedAt: '2026-03-11T06:30:00' });
    const afterMidnight = log({ climbedAt: '2026-03-11T07:30:00' });
    // 01:00 and 05:00 UTC are both the evening of the 11th in Phoenix.
    const sameEvening = log({ climbedAt: '2026-03-12T01:00:00' });
    const sameEveningLater = log({ climbedAt: '2026-03-12T05:00:00' });

    expect(groupClimberLogs([lead, beforeMidnight, afterMidnight], 40, null)[0].earlierDays).toBe(2);
    expect(groupClimberLogs([lead, sameEvening, sameEveningLater], 40, null)[0].earlierDays).toBe(1);
  });

  it('takes the name and avatar from whichever log carries them', () => {
    const [group] = groupClimberLogs(
      [log({ userDisplayName: null, comment: 'beta' }), log({ userAvatarUrl: 'https://example.test/a.png' })],
      40,
      null,
    );
    expect(group.displayName).toBe('Mika');
    expect(group.avatarUrl).toBe('https://example.test/a.png');
  });
});

describe('rankClimberLogGroups', () => {
  it('puts a disagreeing grade under the notes and over everything else', () => {
    const groups = groupClimberLogs(
      [
        log({ userId: 'plain-new', climbedAt: '2026-05-01T10:00:00' }),
        log({ userId: 'graded', difficulty: 18, climbedAt: '2025-01-01T10:00:00' }),
        log({ userId: 'noted', angle: 20, comment: 'drop knee', climbedAt: '2024-01-01T10:00:00' }),
      ],
      40,
      16,
    );
    expect(rankClimberLogGroups(groups).map((group) => group.userId)).toEqual(['noted', 'graded', 'plain-new']);
  });

  it('orders notes, then the board angle, then the newest lead, with ties by user id', () => {
    const groups = groupClimberLogs(
      [
        log({ userId: 'newest-elsewhere', angle: 45, climbedAt: '2026-05-01T10:00:00' }),
        log({ userId: 'at-angle-old', angle: 40, climbedAt: '2026-01-01T10:00:00' }),
        log({ userId: 'at-angle-new', angle: 40, climbedAt: '2026-02-01T10:00:00' }),
        log({ userId: 'noted', angle: 20, comment: 'drop knee', climbedAt: '2025-01-01T10:00:00' }),
        log({ userId: 'tie-b', angle: 45, climbedAt: '2026-04-01T10:00:00' }),
        log({ userId: 'tie-a', angle: 45, climbedAt: '2026-04-01T10:00:00' }),
      ],
      40,
      null,
    );
    expect(rankClimberLogGroups(groups).map((group) => group.userId)).toEqual([
      'noted',
      'at-angle-new',
      'at-angle-old',
      'newest-elsewhere',
      'tie-a',
      'tie-b',
    ]);
  });
});

describe('takeInlineGroups', () => {
  it('never returns more than the inline cap', () => {
    const logs = Array.from({ length: 100 }, (_, index) => log({ userId: `climber-${index}` }));
    const inline = takeInlineGroups(rankClimberLogGroups(groupClimberLogs(logs, 40, null)));
    expect(INLINE_CLIMBER_LOG_CAP).toBe(4);
    expect(inline).toHaveLength(4);
  });
});

describe('partitionClimberLogGroups', () => {
  it('splits climbers with something to say from bare senders and bare triers, keeping order', () => {
    const groups = groupClimberLogs(
      [
        log({ userId: 'sender-1', status: 'send' }),
        log({ userId: 'noted-try', status: 'attempt', comment: 'so close' }),
        log({ userId: 'trier', status: 'attempt' }),
        log({ userId: 'sender-2', status: 'flash' }),
        log({ userId: 'grader', status: 'send', difficulty: 18 }),
      ],
      40,
      16,
    );
    const { loud, bareSent, bareTried } = partitionClimberLogGroups(groups);
    expect(loud.map((group) => group.userId)).toEqual(['noted-try', 'grader']);
    expect(bareSent.map((group) => group.userId)).toEqual(['sender-1', 'sender-2']);
    expect(bareTried.map((group) => group.userId)).toEqual(['trier']);
  });
});

describe('the sent count and the pools', () => {
  it('pools a bare climber with any send under "Also sent", even when their board-angle log is a no-send', () => {
    const groups = groupClimberLogs(
      [
        log({ userId: 'mika', angle: 40, status: 'attempt', climbedAt: '2026-03-01T10:00:00' }),
        log({ userId: 'mika', angle: 35, status: 'send', climbedAt: '2026-01-01T10:00:00' }),
        log({ userId: 'jonas', angle: 40, status: 'attempt' }),
      ],
      40,
      16,
    );
    const { bareSent, bareTried } = partitionClimberLogGroups(groups);
    expect(bareSent.map((group) => group.userId)).toEqual(['mika']);
    expect(bareTried.map((group) => group.userId)).toEqual(['jonas']);
  });

  it('never disagrees with the header: climbers shown as having sent are exactly those with a send', () => {
    const logs = [
      log({ userId: 'a', angle: 40, status: 'attempt' }),
      log({ userId: 'a', angle: 35, status: 'send' }),
      log({ userId: 'b', angle: 40, status: 'attempt', comment: 'close' }),
      log({ userId: 'b', angle: 45, status: 'flash' }),
      log({ userId: 'c', angle: 40, status: 'attempt' }),
      log({ userId: 'd', angle: 40, status: 'send', difficulty: 18 }),
    ];
    // What the server's senderCount counts: distinct climbers with a send at any angle.
    const senderCount = new Set(logs.filter((entry) => entry.status !== 'attempt').map((entry) => entry.userId)).size;
    const groups = groupClimberLogs(logs, 40, 16);
    const { loud, bareSent, bareTried } = partitionClimberLogGroups(groups);

    const shownAsSent = [...bareSent, ...loud.filter((group) => describeResult(group.lead).kind !== 'noSend')];
    expect(shownAsSent).toHaveLength(senderCount);
    expect(bareTried.every((group) => !group.sent)).toBe(true);
  });
});

describe('planClimberLogsCard', () => {
  it('gives the rows to the first four ranked climbers with something to say', () => {
    const logs = Array.from({ length: 6 }, (_, index) =>
      log({ userId: `noted-${index}`, comment: 'beta', climbedAt: `2026-03-0${index + 1}T10:00:00` }),
    );
    const plan = planClimberLogsCard(rankClimberLogGroups(groupClimberLogs(logs, 40, 16)));
    expect(plan.rows.map((group) => group.userId)).toEqual(['noted-5', 'noted-4', 'noted-3', 'noted-2']);
  });

  it('keeps every bare followed climber on the card, however many rows there are', () => {
    const logs = [
      ...Array.from({ length: 9 }, (_, index) => log({ userId: `noted-${index}`, comment: 'beta' })),
      log({ userId: 'bare-sender', status: 'send' }),
      log({ userId: 'bare-trier', status: 'attempt' }),
    ];
    const plan = planClimberLogsCard(rankClimberLogGroups(groupClimberLogs(logs, 40, 16)));
    expect(plan.rows).toHaveLength(INLINE_CLIMBER_LOG_CAP);
    expect(plan.rows.every((group) => !group.bare)).toBe(true);
    expect(plan.bareSent.map((group) => group.userId)).toEqual(['bare-sender']);
    expect(plan.bareTried.map((group) => group.userId)).toEqual(['bare-trier']);
  });

  it('gives a bare climber no row, even with rows to spare', () => {
    const plan = planClimberLogsCard(groupClimberLogs([log({ status: 'send' })], 40, 16));
    expect(plan.rows).toEqual([]);
    expect(plan.bareSent).toHaveLength(1);
  });
});

describe('describeBareNames', () => {
  const groups = groupClimberLogs(
    ['ana', 'jo', 'kit', 'lena'].map((userId) => log({ userId, userDisplayName: userId, status: 'send' })),
    40,
    16,
  );

  it('names two climbers and counts the rest when it holds every log', () => {
    expect(describeBareNames(groups, true)).toEqual({ names: ['ana', 'jo'], extra: 2, andMore: false });
    expect(describeBareNames(groups.slice(0, 2), true)).toEqual({ names: ['ana', 'jo'], extra: 0, andMore: false });
  });

  it('gives no number when the logs were cut at the cap', () => {
    expect(describeBareNames(groups, false)).toEqual({ names: ['ana', 'jo'], extra: 0, andMore: true });
    expect(describeBareNames(groups.slice(0, 1), false)).toEqual({ names: ['ana'], extra: 0, andMore: false });
  });
});

describe('tallyDisagreeingGrades', () => {
  it('counts each climber once, from their newest disagreeing log at the board angle', () => {
    const groups = groupClimberLogs(
      [
        log({ userId: 'mika', difficulty: 14, climbedAt: '2026-01-01T10:00:00' }),
        log({ userId: 'mika', difficulty: 18, climbedAt: '2026-02-01T10:00:00' }),
        log({ userId: 'mika', difficulty: 16, climbedAt: '2026-03-01T10:00:00' }),
        log({ userId: 'jonas', difficulty: 18 }),
        log({ userId: 'priya', difficulty: 14 }),
        log({ userId: 'agrees', difficulty: 16 }),
        log({ userId: 'elsewhere', angle: 45, difficulty: 20 }),
        log({ userId: 'ungraded', difficulty: null }),
      ],
      40,
      16,
    );
    expect(tallyDisagreeingGrades(groups)).toEqual([
      { difficultyId: 18, count: 2 },
      { difficultyId: 14, count: 1 },
    ]);
  });

  it('keeps the two most common grades, lower grade first on a tie', () => {
    const groups = groupClimberLogs(
      [
        log({ userId: 'a', difficulty: 20 }),
        log({ userId: 'b', difficulty: 20 }),
        log({ userId: 'c', difficulty: 14 }),
        log({ userId: 'd', difficulty: 12 }),
      ],
      40,
      16,
    );
    expect(tallyDisagreeingGrades(groups).map((entry) => entry.difficultyId)).toEqual([20, 12]);
  });

  it('is empty when everybody who graded it agrees with the climb', () => {
    const groups = groupClimberLogs([log({ difficulty: 16 }), log({ userId: 'b' })], 40, 16);
    expect(tallyDisagreeingGrades(groups)).toEqual([]);
  });
});

describe('foldEarlierLogs', () => {
  const repeat = (overrides: Partial<ClimberLog> = {}) => log({ status: 'send', attemptCount: 1, ...overrides });

  it('folds three or more plain one-try sends at an angle into one line, board angle first', () => {
    const hard = log({ status: 'send', attemptCount: 8 });
    const noted = repeat({ comment: 'Final test' });
    const earlier = [
      hard,
      noted,
      ...Array.from({ length: 4 }, () => repeat({ angle: 35 })),
      ...Array.from({ length: 3 }, () => repeat()),
    ];
    expect(foldEarlierLogs(earlier, 40, 16)).toEqual([
      { kind: 'log', log: hard },
      { kind: 'log', log: noted },
      { kind: 'fold', angle: 40, count: 3 },
      { kind: 'fold', angle: 35, count: 4 },
    ]);
  });

  it('leaves two plain repeats as lines of their own', () => {
    const earlier = [repeat(), repeat()];
    expect(foldEarlierLogs(earlier, 40, 16)).toEqual(earlier.map((entry) => ({ kind: 'log', log: entry })));
  });

  it('never folds a no-send, a multi-try send, a note or a disagreeing grade', () => {
    const earlier = [
      log({ status: 'attempt', attemptCount: 1 }),
      log({ status: 'send', attemptCount: 2 }),
      repeat({ comment: 'beta' }),
      repeat({ difficulty: 18 }),
      repeat(),
      repeat(),
      repeat(),
    ];
    const lines = foldEarlierLogs(earlier, 40, 16);
    expect(lines.filter((line) => line.kind === 'log')).toHaveLength(4);
    expect(lines.at(-1)).toEqual({ kind: 'fold', angle: 40, count: 3 });
  });

  it('counts a flash and an imported zero-try send as one-try sends', () => {
    const earlier = [log({ status: 'flash' }), repeat({ attemptCount: 0 }), repeat()];
    expect(foldEarlierLogs(earlier, 40, 16)).toEqual([{ kind: 'fold', angle: 40, count: 3 }]);
  });
});

describe('filterClimberLogs', () => {
  it('re-picks each lead at the board angle and drops climbers with no log there', () => {
    const notedElsewhere = log({ userId: 'mika', angle: 45, comment: 'pinch then throw' });
    const plainAtAngle = log({ userId: 'mika', angle: 40 });
    const onlyElsewhere = log({ userId: 'jonas', angle: 45 });
    const all = [notedElsewhere, plainAtAngle, onlyElsewhere];

    expect(groupClimberLogs(all, 40, null).find((group) => group.userId === 'mika')?.note).toBe('pinch then throw');

    const groups = groupClimberLogs(filterClimberLogs(all, 40, { ...NO_FILTERS, angleOnly: true }), 40, null);
    expect(groups.map((group) => group.userId)).toEqual(['mika']);
    expect(groups[0].lead.uuid).toBe(plainAtAngle.uuid);
  });

  it('combines "with notes" and "sends only"', () => {
    const notedSend = log({ status: 'send', comment: 'static finish' });
    const logs = [notedSend, log({ status: 'send' }), log({ comment: 'so close' }), log({ status: 'flash' })];
    expect(filterClimberLogs(logs, 40, { ...NO_FILTERS, withNotes: true, sendsOnly: true })).toEqual([notedSend]);
    expect(filterClimberLogs(logs, 40, { ...NO_FILTERS, sendsOnly: true })).toHaveLength(3);
    expect(filterClimberLogs(logs, 40, NO_FILTERS)).toHaveLength(4);
  });
});

describe('buildClimberLogListItems', () => {
  const groups = groupClimberLogs(
    [
      log({ userId: 'mika', comment: 'beta' }),
      log({ userId: 'mika', uuid: 'mika-old-1', climbedAt: '2026-02-02T10:00:00' }),
      log({ userId: 'mika', uuid: 'mika-old-2', climbedAt: '2026-02-01T10:00:00' }),
      log({ userId: 'jonas', comment: 'heel hook' }),
      log({ userId: 'jonas', uuid: 'jonas-old' }),
    ],
    40,
    16,
  );
  const bare = (userId: string, overrides: Partial<ClimberLog> = {}) => log({ userId, status: 'send', ...overrides });

  it('emits a header, the groups, earlier logs for expanded climbers only, then the notices', () => {
    const items = buildClimberLogListItems(
      [{ id: 'following', groups, count: 5 }],
      new Set(['mika']),
      [
        { notice: 'otherAngles', count: 3 },
        { notice: 'capped', count: 0 },
      ],
      TWO_COLUMNS,
    );

    expect(items.map((item) => item.kind)).toEqual([
      'header',
      'group',
      'earlier',
      'earlier',
      'group',
      'notice',
      'notice',
    ]);
    expect(items[0]).toMatchObject({ section: 'following', count: 5 });
    expect(items.filter((item) => item.kind === 'earlier').map((item) => item.key)).toEqual([
      'earlier:mika-old-1',
      'earlier:mika-old-2',
    ]);
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });

  it('folds an expanded climber plain repeats into one line per angle', () => {
    const repeats = groupClimberLogs(
      [
        log({ userId: 'mika', status: 'send', comment: 'beta', climbedAt: '2026-03-20T10:00:00' }),
        ...Array.from({ length: 3 }, () => bare('mika', { attemptCount: 1 })),
        bare('mika', { uuid: 'hard', attemptCount: 8 }),
      ],
      40,
      16,
    );
    const items = buildClimberLogListItems(
      [{ id: 'following', groups: repeats, count: 1 }],
      new Set(['mika']),
      [],
      TWO_COLUMNS,
    );
    expect(items.map((item) => item.key)).toEqual([
      'header:following',
      'following:mika',
      'earlier:hard',
      'earlierFold:mika:40',
    ]);
    expect(items.at(-1)).toMatchObject({ angle: 40, count: 3 });
  });

  it('gives bare climbers no row: two to a line under "Also sent" and "Tried, no send", after the rows', () => {
    const mixed = groupClimberLogs(
      [
        bare('ana'),
        log({ userId: 'noted', comment: 'beta' }),
        bare('jo'),
        log({ userId: 'bea', status: 'attempt' }),
        bare('kit'),
      ],
      40,
      16,
    );
    const items = buildClimberLogListItems([{ id: 'following', groups: mixed, count: 5 }], new Set(), [], TWO_COLUMNS);

    expect(items.map((item) => item.key)).toEqual([
      'header:following',
      'following:noted',
      'bareHeader:following:sent',
      'bare:following:ana',
      'bare:following:kit',
      'bareHeader:following:tried',
      'bare:following:bea',
    ]);
    expect(items.filter((item) => item.kind === 'group')).toHaveLength(1);
    expect(items[2]).toMatchObject({ result: 'sent', count: 3 });
    expect(items[3]).toMatchObject({ wide: false });
    expect(items[3].kind === 'bare' && items[3].groups.map((group) => group.userId)).toEqual(['ana', 'jo']);
    expect(items[5]).toMatchObject({ result: 'tried', count: 1 });
  });

  it('puts one bare climber on a line at large text sizes', () => {
    const three = groupClimberLogs([bare('ana'), bare('jo'), bare('kit')], 40, 16);
    const items = buildClimberLogListItems([{ id: 'following', groups: three, count: 3 }], new Set(), [], ONE_COLUMN);
    expect(items.filter((item) => item.kind === 'bare').map((item) => item.key)).toEqual([
      'bare:following:ana',
      'bare:following:jo',
      'bare:following:kit',
    ]);
  });

  it('gives a bare climber with earlier logs the whole line, and opens those logs under it', () => {
    const withHistory = groupClimberLogs(
      [
        bare('ana'),
        bare('mj'),
        bare('mj', { uuid: 'mj-old', attemptCount: 5, climbedAt: '2026-01-01T10:00:00' }),
        bare('jo'),
      ],
      40,
      16,
    );
    const section = { id: 'following' as const, groups: withHistory, count: 3 };

    const closed = buildClimberLogListItems([section], new Set(), [], TWO_COLUMNS);
    expect(closed.map((item) => item.key)).toEqual([
      'header:following',
      'bareHeader:following:sent',
      'bare:following:mj',
      'bare:following:ana',
    ]);
    expect(closed[2]).toMatchObject({ wide: true });
    expect(closed[3]).toMatchObject({ wide: false });

    const open = buildClimberLogListItems([section], new Set(['mj']), [], TWO_COLUMNS);
    expect(open.map((item) => item.key).slice(2, 5)).toEqual([
      'bare:following:mj',
      'earlier:mj-old',
      'bare:following:ana',
    ]);
  });

  it('offers no earlier logs and no bare count when the server cut the list', () => {
    const withHistory = groupClimberLogs([bare('mj'), bare('mj'), bare('ana')], 40, 16);
    const items = buildClimberLogListItems(
      [{ id: 'following', groups: withHistory, count: 40, capped: true }],
      new Set(['mj']),
      [],
      TWO_COLUMNS,
    );
    expect(items.map((item) => item.kind)).toEqual(['header', 'bareHeader', 'bare']);
    expect(items[1]).toMatchObject({ count: null });
    expect(items[2]).toMatchObject({ wide: false });
  });

  it('keeps the server order under Everyone, pairing bare climbers that sit next to each other', () => {
    const everyone = groupClimberLogs(
      [bare('dee'), log({ userId: 'rat', comment: 'no swing' }), bare('pilot'), bare('quin'), bare('rae')],
      40,
      16,
    );
    const items = buildClimberLogListItems(
      [{ id: 'everyone', groups: everyone, count: null }],
      new Set(),
      [],
      TWO_COLUMNS,
    );
    expect(items.map((item) => item.key)).toEqual([
      'header:everyone',
      'bare:everyone:dee',
      'everyone:rat',
      'bare:everyone:pilot',
      'bare:everyone:rae',
    ]);
    expect(items.some((item) => item.kind === 'bareHeader')).toBe(false);
  });

  it('always lists Following before Everyone, and never repeats a followed climber under Everyone', () => {
    const everyone = groupClimberLogs([log({ userId: 'lena', comment: 'sloper' }), log({ userId: 'mika' })], 40, 16);
    const items = buildClimberLogListItems(
      [
        { id: 'everyone', groups: everyone, count: null },
        { id: 'following', groups, count: 2 },
      ],
      new Set(),
      [{ notice: 'capped', count: 0 }],
      TWO_COLUMNS,
    );
    expect(items.map((item) => item.key)).toEqual([
      'header:following',
      'following:mika',
      'following:jonas',
      'notice:capped',
      'header:everyone',
      'everyone:lena',
    ]);
  });

  it('emits nothing for a section with no groups, so an empty result is an empty list', () => {
    expect(buildClimberLogListItems([{ id: 'following', groups: [], count: 0 }], new Set(), [], TWO_COLUMNS)).toEqual(
      [],
    );
    expect(
      buildClimberLogListItems(
        [{ id: 'following', groups: [], count: 0 }],
        new Set(),
        [{ notice: 'otherAngles', count: 2 }],
        TWO_COLUMNS,
      ),
    ).toEqual([
      // The notice keeps its Following header, so it never floats with nothing above it.
      { kind: 'header', key: 'header:following', section: 'following', count: 0 },
      { kind: 'notice', key: 'notice:otherAngles', notice: 'otherAngles', count: 2 },
    ]);
  });
});

describe('describeResult', () => {
  it('names a flash, a send with its tries, and a log with no send', () => {
    expect(describeResult(log({ status: 'flash', attemptCount: 1 }))).toEqual({ kind: 'flash' });
    expect(describeResult(log({ status: 'send', attemptCount: 4 }))).toEqual({ kind: 'sent', tries: 4 });
    expect(describeResult(log({ status: 'attempt', attemptCount: 6 }))).toEqual({ kind: 'noSend', tries: 6 });
  });

  it('turns an imported log with zero tries into one try', () => {
    expect(describeResult(log({ status: 'send', attemptCount: 0 }))).toEqual({ kind: 'sent', tries: 1 });
    expect(describeResult(log({ status: 'attempt', attemptCount: 0 }))).toEqual({ kind: 'noSend', tries: 1 });
  });
});

describe('deriveCrewCounts', () => {
  const summary = {
    climberCount: 5,
    senderCount: 4,
    byAngle: [
      { angle: 40, climberCount: 4, senderCount: 3 },
      { angle: 45, climberCount: 2, senderCount: 1 },
    ],
  };

  it('is null with no answer and when nobody followed has logged the climb', () => {
    expect(deriveCrewCounts(undefined, 40)).toBeNull();
    expect(deriveCrewCounts({ summary: { climberCount: 0, senderCount: 0, byAngle: [] } }, 40)).toBeNull();
  });

  it('reads the board angle from byAngle', () => {
    expect(deriveCrewCounts({ summary }, 40)).toEqual({
      climbers: 5,
      senders: 4,
      climbersAtAngle: 4,
      sendersAtAngle: 3,
    });
  });

  it('reads zero for an angle nobody logged at', () => {
    expect(deriveCrewCounts({ summary }, 20)).toMatchObject({ climbersAtAngle: 0, sendersAtAngle: 0 });
  });
});

describe('followingSectionCount', () => {
  const counts = { climbers: 12, senders: 9, climbersAtAngle: 7, sendersAtAngle: 5 };

  it('uses the server numbers for each chip combination', () => {
    expect(followingSectionCount(counts, NO_FILTERS)).toBe(12);
    expect(followingSectionCount(counts, { ...NO_FILTERS, sendsOnly: true })).toBe(9);
    expect(followingSectionCount(counts, { ...NO_FILTERS, angleOnly: true })).toBe(7);
    expect(followingSectionCount(counts, { ...NO_FILTERS, angleOnly: true, sendsOnly: true })).toBe(5);
  });

  it('has no number while "with notes" is on, or without counts', () => {
    expect(followingSectionCount(counts, { ...NO_FILTERS, withNotes: true })).toBeNull();
    expect(followingSectionCount(counts, { angleOnly: true, withNotes: true, sendsOnly: true })).toBeNull();
    expect(followingSectionCount(null, NO_FILTERS)).toBeNull();
  });
});

describe('otherAnglesNoticeCount', () => {
  const counts = { climbers: 5, senders: 2, climbersAtAngle: 2, sendersAtAngle: 2 };
  const angleOnly = { ...NO_FILTERS, angleOnly: true };

  it('counts the climbers who only logged at other angles', () => {
    expect(otherAnglesNoticeCount(counts, angleOnly)).toBe(3);
  });

  it('counts only senders elsewhere while "sends only" is on', () => {
    // Both senders sent at the board angle, so turning the angle chip off adds no row.
    expect(otherAnglesNoticeCount(counts, { ...angleOnly, sendsOnly: true })).toBe(0);
    expect(otherAnglesNoticeCount({ ...counts, senders: 4 }, { ...angleOnly, sendsOnly: true })).toBe(2);
  });

  it('has nothing to offer while "with notes" is on, the server has no count for it', () => {
    expect(otherAnglesNoticeCount(counts, { ...angleOnly, withNotes: true })).toBe(0);
    expect(otherAnglesNoticeCount(counts, { angleOnly: true, withNotes: true, sendsOnly: true })).toBe(0);
  });

  it('is zero with the angle chip off, without counts, and never negative', () => {
    expect(otherAnglesNoticeCount(counts, NO_FILTERS)).toBe(0);
    expect(otherAnglesNoticeCount(null, angleOnly)).toBe(0);
    expect(otherAnglesNoticeCount({ ...counts, climbers: 1 }, angleOnly)).toBe(0);
  });
});

describe('ClimberLog', () => {
  it('accepts the followed-climbers query item as it comes off the wire', () => {
    const item: FollowingClimbAscentItem = {
      uuid: 'wire-1',
      userId: 'mika',
      userDisplayName: 'Mika',
      climbUuid: 'climb-1',
      angle: 40,
      isMirror: false,
      status: 'send',
      attemptCount: 2,
      effectiveQuality: 4,
      difficulty: 18,
      comment: '',
      climbedAt: '2026-03-10T18:00:00',
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
    };
    const asLog: ClimberLog = item;
    expect(groupClimberLogs([asLog], 40, null)).toHaveLength(1);
  });
});
