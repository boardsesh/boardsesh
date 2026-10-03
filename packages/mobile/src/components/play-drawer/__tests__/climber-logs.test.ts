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
  rankClimberLogGroups,
  takeInlineGroups,
  tallyGivenGrades,
  type ClimberLog,
  type ClimberLogFilters,
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

describe('groupClimberLogs', () => {
  it('gives one group per climber', () => {
    const groups = groupClimberLogs([log(), log(), log({ userId: 'jonas', userDisplayName: 'Jonas' })], 40);
    expect(groups.map((group) => group.userId)).toEqual(['mika', 'jonas']);
    expect(groups[0].earlier).toHaveLength(1);
    expect(groups[1].earlier).toHaveLength(0);
  });

  it('leads with a note over everything else', () => {
    const noted = log({ angle: 25, comment: 'Heel on the start jug', climbedAt: '2026-01-01T10:00:00' });
    const groups = groupClimberLogs([log({ status: 'send', climbedAt: '2026-03-01T10:00:00' }), noted], 40);
    expect(groups[0].lead.uuid).toBe(noted.uuid);
    expect(groups[0].hasNote).toBe(true);
    expect(groups[0].atBoardAngle).toBe(false);
  });

  it('treats a whitespace-only comment as no note', () => {
    const groups = groupClimberLogs([log({ comment: '   ' })], 40);
    expect(groups[0].hasNote).toBe(false);
  });

  it('then prefers the board angle, then a send, then the newest', () => {
    const atAngle = log({ angle: 40, status: 'attempt', climbedAt: '2026-01-01T10:00:00' });
    const sentElsewhere = log({ angle: 45, status: 'send', climbedAt: '2026-03-01T10:00:00' });
    expect(groupClimberLogs([sentElsewhere, atAngle], 40)[0].lead.uuid).toBe(atAngle.uuid);

    const sent = log({ userId: 'jonas', status: 'flash', climbedAt: '2026-01-01T10:00:00' });
    const newerTry = log({ userId: 'jonas', status: 'attempt', climbedAt: '2026-03-01T10:00:00' });
    expect(groupClimberLogs([newerTry, sent], 40)[0].lead.uuid).toBe(sent.uuid);

    const older = log({ userId: 'priya', climbedAt: '2026-01-01T10:00:00' });
    const newer = log({ userId: 'priya', climbedAt: '2026-03-01T10:00:00' });
    expect(groupClimberLogs([older, newer], 40)[0].lead.uuid).toBe(newer.uuid);
  });

  it('lists the other logs newest first and floors each at one try', () => {
    const lead = log({ comment: 'beta', climbedAt: '2026-01-01T10:00:00' });
    const imported = log({ attemptCount: 0, climbedAt: '2026-02-01T10:00:00' });
    const session = log({ attemptCount: 4, climbedAt: '2026-03-01T10:00:00' });
    const [group] = groupClimberLogs([lead, imported, session], 40);
    expect(group.earlier.map((entry) => entry.uuid)).toEqual([session.uuid, imported.uuid]);
    expect(group.earlierTries).toBe(5);
  });

  it('counts earlier days in local time, so a pair either side of local midnight is two days', () => {
    const lead = log({ comment: 'beta', climbedAt: '2026-03-20T10:00:00' });
    // 06:30 and 07:30 UTC on the same UTC date are 23:30 and 00:30 in Phoenix.
    const beforeMidnight = log({ climbedAt: '2026-03-11T06:30:00' });
    const afterMidnight = log({ climbedAt: '2026-03-11T07:30:00' });
    // 01:00 and 05:00 UTC are both the evening of the 11th in Phoenix.
    const sameEvening = log({ climbedAt: '2026-03-12T01:00:00' });
    const sameEveningLater = log({ climbedAt: '2026-03-12T05:00:00' });

    expect(groupClimberLogs([lead, beforeMidnight, afterMidnight], 40)[0].earlierDays).toBe(2);
    expect(groupClimberLogs([lead, sameEvening, sameEveningLater], 40)[0].earlierDays).toBe(1);
  });

  it('takes the name and avatar from whichever log carries them', () => {
    const [group] = groupClimberLogs(
      [log({ userDisplayName: null, comment: 'beta' }), log({ userAvatarUrl: 'https://example.test/a.png' })],
      40,
    );
    expect(group.displayName).toBe('Mika');
    expect(group.avatarUrl).toBe('https://example.test/a.png');
  });
});

describe('rankClimberLogGroups', () => {
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
    const inline = takeInlineGroups(rankClimberLogGroups(groupClimberLogs(logs, 40)));
    expect(INLINE_CLIMBER_LOG_CAP).toBe(4);
    expect(inline).toHaveLength(4);
  });
});

describe('tallyGivenGrades', () => {
  it('counts one grade per climber, from their newest graded log', () => {
    const groups = groupClimberLogs(
      [
        log({ userId: 'mika', difficulty: 16, climbedAt: '2026-01-01T10:00:00' }),
        log({ userId: 'mika', difficulty: 18, climbedAt: '2026-02-01T10:00:00' }),
        log({ userId: 'mika', difficulty: null, climbedAt: '2026-03-01T10:00:00' }),
        log({ userId: 'jonas', difficulty: 18 }),
        log({ userId: 'priya', difficulty: 16 }),
        log({ userId: 'tomas', difficulty: null }),
      ],
      40,
    );
    expect(tallyGivenGrades(groups)).toEqual([
      { difficultyId: 18, count: 2 },
      { difficultyId: 16, count: 1 },
    ]);
  });

  it('keeps the three most common grades, lower grade first on a tie', () => {
    const groups = groupClimberLogs(
      [
        log({ userId: 'a', difficulty: 20 }),
        log({ userId: 'b', difficulty: 20 }),
        log({ userId: 'c', difficulty: 14 }),
        log({ userId: 'd', difficulty: 12 }),
        log({ userId: 'e', difficulty: 22 }),
      ],
      40,
    );
    expect(tallyGivenGrades(groups).map((entry) => entry.difficultyId)).toEqual([20, 12, 14]);
  });

  it('is empty when nobody gave a grade', () => {
    expect(tallyGivenGrades(groupClimberLogs([log()], 40))).toEqual([]);
  });
});

describe('filterClimberLogs', () => {
  it('re-picks each lead at the board angle and drops climbers with no log there', () => {
    const notedElsewhere = log({ userId: 'mika', angle: 45, comment: 'pinch then throw' });
    const plainAtAngle = log({ userId: 'mika', angle: 40 });
    const onlyElsewhere = log({ userId: 'jonas', angle: 45 });
    const all = [notedElsewhere, plainAtAngle, onlyElsewhere];

    expect(groupClimberLogs(all, 40).find((group) => group.userId === 'mika')?.lead.uuid).toBe(notedElsewhere.uuid);

    const groups = groupClimberLogs(filterClimberLogs(all, 40, { ...NO_FILTERS, angleOnly: true }), 40);
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
      log({ userId: 'jonas' }),
      log({ userId: 'jonas', uuid: 'jonas-old' }),
    ],
    40,
  );

  it('emits a header, the groups, earlier logs for expanded climbers only, then the notices', () => {
    const items = buildClimberLogListItems([{ id: 'following', groups, count: 5 }], new Set(['mika']), [
      { notice: 'otherAngles', count: 3 },
      { notice: 'capped', count: 0 },
    ]);

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

  it('keeps keys unique across two sections, with the notices under the first', () => {
    const everyone = groupClimberLogs([log({ userId: 'lena' })], 40);
    const items = buildClimberLogListItems(
      [
        { id: 'following', groups, count: 2 },
        { id: 'everyone', groups: everyone, count: null },
      ],
      new Set(),
      [{ notice: 'capped', count: 0 }],
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
    expect(buildClimberLogListItems([{ id: 'following', groups: [], count: 0 }], new Set(), [])).toEqual([]);
    expect(
      buildClimberLogListItems([{ id: 'following', groups: [], count: 0 }], new Set(), [
        { notice: 'otherAngles', count: 2 },
      ]),
    ).toEqual([{ kind: 'notice', key: 'notice:otherAngles', notice: 'otherAngles', count: 2 }]);
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
    expect(groupClimberLogs([asLog], 40)).toHaveLength(1);
  });
});
