import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { deriveClimbLedger, type LedgerAngleSection } from '../climb-ledger';
import type { LogbookEntry } from '../types';

dayjs.extend(utc);

// Stored tick timestamps are naive UTC; parseTickTime recovers the absolute
// moment then renders LOCAL. Building fixtures FROM local wall-clock times pins
// the day bucketing in whatever timezone the suite runs in.
const storedUtcFromLocal = (localWallClock: string) => dayjs(localWallClock).utc().format('YYYY-MM-DDTHH:mm:ss');

const entry = (overrides: Partial<LogbookEntry>): LogbookEntry => ({
  climbed_at: storedUtcFromLocal('2026-06-01 12:00'),
  difficulty: null,
  tries: 1,
  angle: 40,
  status: 'attempt',
  ...overrides,
});

const at = (localWallClock: string, overrides: Partial<LogbookEntry> = {}) =>
  entry({ climbed_at: storedUtcFromLocal(localWallClock), ...overrides });

describe('deriveClimbLedger: tries', () => {
  it('gives an untried verdict, zero totals and no angles for no entries', () => {
    expect(deriveClimbLedger([], { currentAngle: 40 })).toEqual({
      verdict: { kind: 'untried' },
      totals: { scope: 'all', tries: 0, sessions: 0, sends: 0, personalGrade: null },
      angles: [],
    });
  });

  it('counts a send of 3 as three tries', () => {
    const [section] = deriveClimbLedger([entry({ status: 'send', tries: 3 })], { currentAngle: 40 }).angles;
    expect(section.sessions[0].totalTries).toBe(3);
    expect(Object.keys(section.sessions[0]).sort()).toEqual(['dayKey', 'entries', 'totalTries']);
  });

  it('counts a flash as one try whatever its tries field says', () => {
    const ledger = deriveClimbLedger([entry({ status: 'flash', tries: 3 })], { currentAngle: 40 });
    expect(ledger.angles[0].sessions[0].totalTries).toBe(1);
    expect(ledger.angles[0].totalTries).toBe(1);
    expect(ledger.totals.tries).toBe(1);
  });

  it('floors a zero-try tick at one', () => {
    const ledger = deriveClimbLedger([entry({ tries: 0 }), entry({ status: 'send', tries: 0 })], { currentAngle: 40 });
    expect(ledger.totals.tries).toBe(2);
    expect(ledger.angles[0].sessions[0].totalTries).toBe(2);
  });

  it('sums a day’s tries and lists its entries newest first', () => {
    const morning = at('2026-06-01 09:00', { tries: 2 });
    const evening = at('2026-06-01 18:00', { status: 'send', tries: 2 });
    const [section] = deriveClimbLedger([evening, morning], { currentAngle: 40 }).angles;
    expect(section.sessions).toHaveLength(1);
    expect(section.sessions[0].totalTries).toBe(4);
    expect(section.sessions[0].entries).toEqual([evening, morning]);
  });
});

describe('deriveClimbLedger: status source', () => {
  it('reads status only through statusOf', () => {
    const untyped = entry({ status: undefined, tries: 2 });
    const ledger = deriveClimbLedger([untyped], { currentAngle: 40, statusOf: () => 'send' });
    expect(ledger.angles[0].sendCount).toBe(1);
    expect(ledger.verdict).toEqual({ kind: 'send', angle: 40, climbedAt: untyped.climbed_at });
  });

  it('treats a missing status as an attempt by default', () => {
    const ledger = deriveClimbLedger([entry({ status: undefined, tries: 2 })], { currentAngle: 40 });
    expect(ledger.angles[0].sendCount).toBe(0);
    expect(ledger.verdict.kind).toBe('attempt');
  });
});

describe('deriveClimbLedger: first send', () => {
  it('names the session the first send came in', () => {
    const [section] = deriveClimbLedger(
      [
        at('2026-06-01 18:00', { tries: 4 }),
        at('2026-06-03 18:00', { tries: 6 }),
        at('2026-06-08 18:00', { status: 'send', tries: 3 }),
        at('2026-06-09 18:00', { status: 'send', tries: 1 }),
      ],
      { currentAngle: 40 },
    ).angles;
    expect(section.firstSend).toEqual({
      sessionNumber: 3,
      flash: false,
      climbedAt: storedUtcFromLocal('2026-06-08 18:00'),
    });
    expect(section.sendCount).toBe(2);
    expect(section.sessionCount).toBe(4);
  });

  it('marks a flash and exposes no try ordinal', () => {
    const [section] = deriveClimbLedger([entry({ status: 'flash' })], { currentAngle: 40 }).angles;
    expect(section.firstSend?.flash).toBe(true);
    expect(section.firstSend?.sessionNumber).toBe(1);
    expect(Object.keys(section.firstSend ?? {}).sort()).toEqual(['climbedAt', 'flash', 'sessionNumber']);
  });

  it('has no first send when the angle was never sent', () => {
    const [section] = deriveClimbLedger([entry({ tries: 3 })], { currentAngle: 40 }).angles;
    expect(section.firstSend).toBeNull();
  });
});

describe('deriveClimbLedger: ordering', () => {
  const angleOrder = (sections: LedgerAngleSection<LogbookEntry>[]) => sections.map((section) => section.angle);
  const entries = [entry({ angle: 30 }), entry({ angle: 50 }), entry({ angle: 40 }), entry({ angle: 45 })];

  it('leads with the board angle, then steepest first', () => {
    expect(angleOrder(deriveClimbLedger(entries, { currentAngle: 40 }).angles)).toEqual([40, 50, 45, 30]);
  });

  it('is plain steepest first when the board angle has no logs', () => {
    expect(angleOrder(deriveClimbLedger(entries, { currentAngle: 35 }).angles)).toEqual([50, 45, 40, 30]);
  });

  it('orders sessions newest first', () => {
    const [section] = deriveClimbLedger([at('2026-06-01 18:00'), at('2026-06-20 18:00'), at('2026-06-10 18:00')], {
      currentAngle: 40,
    }).angles;
    expect(section.sessions.map((session) => session.dayKey)).toEqual(['2026-06-20', '2026-06-10', '2026-06-01']);
  });

  it('splits a pair that spans local midnight into two sessions', () => {
    const [section] = deriveClimbLedger([at('2026-06-01 23:30', { tries: 2 }), at('2026-06-02 00:30')], {
      currentAngle: 40,
    }).angles;
    expect(section.sessionCount).toBe(2);
    expect(section.sessions.map((session) => session.dayKey)).toEqual(['2026-06-02', '2026-06-01']);
  });
});

describe('deriveClimbLedger: totals', () => {
  it('scopes to the board angle when it has logs', () => {
    const ledger = deriveClimbLedger(
      [
        at('2026-06-01 18:00', { angle: 40, tries: 4 }),
        at('2026-06-02 18:00', { angle: 40, tries: 3, status: 'send' }),
        // A grade given at 50 must not be quoted as the grade at 40.
        at('2026-06-03 18:00', { angle: 50, tries: 2, status: 'send', difficulty: 22 }),
      ],
      { currentAngle: 40 },
    );
    expect(ledger.totals).toEqual({ scope: 'angle', tries: 7, sessions: 2, sends: 1, personalGrade: null });
  });

  it('prefers the newest graded send for the personal grade, then any graded entry', () => {
    const graded = deriveClimbLedger(
      [
        at('2026-06-01 18:00', { status: 'send', difficulty: 16 }),
        at('2026-06-02 18:00', { status: 'send', difficulty: 18 }),
        at('2026-06-03 18:00', { status: 'attempt', difficulty: 20 }),
        at('2026-06-04 18:00', { status: 'send', difficulty: null }),
      ],
      { currentAngle: 40 },
    );
    expect(graded.totals.personalGrade).toBe(18);
    const attemptOnly = deriveClimbLedger([at('2026-06-03 18:00', { difficulty: 20 })], { currentAngle: 40 });
    expect(attemptOnly.totals.personalGrade).toBe(20);
  });

  it('covers every angle otherwise and counts a shared day once', () => {
    const ledger = deriveClimbLedger(
      [
        at('2026-06-01 17:00', { angle: 45, tries: 2 }),
        at('2026-06-01 18:00', { angle: 50, tries: 1, status: 'flash', difficulty: 22 }),
        at('2026-06-05 18:00', { angle: 45, tries: 3, status: 'send' }),
      ],
      { currentAngle: 40 },
    );
    expect(ledger.totals).toEqual({ scope: 'all', tries: 6, sessions: 2, sends: 2, personalGrade: 22 });
  });
});

describe('deriveClimbLedger: verdict', () => {
  it('lets a send at the board angle beat a newer attempt there', () => {
    const send = at('2026-06-01 18:00', { status: 'send', tries: 2 });
    const ledger = deriveClimbLedger([send, at('2026-06-09 18:00', { tries: 3 })], { currentAngle: 40 });
    expect(ledger.verdict).toEqual({ kind: 'send', angle: 40, climbedAt: send.climbed_at });
  });

  it('lets an attempt at the board angle beat a send elsewhere', () => {
    const attempt = at('2026-06-01 18:00', { angle: 40, tries: 3 });
    const ledger = deriveClimbLedger([attempt, at('2026-06-09 18:00', { angle: 45, status: 'send' })], {
      currentAngle: 40,
    });
    expect(ledger.verdict).toEqual({ kind: 'attempt', angle: 40, climbedAt: attempt.climbed_at });
  });

  it('quotes the newest attempt at the board angle', () => {
    const newest = at('2026-06-09 18:00', { tries: 1 });
    const ledger = deriveClimbLedger([at('2026-06-01 18:00', { tries: 3 }), newest], { currentAngle: 40 });
    expect(ledger.verdict).toEqual({ kind: 'attempt', angle: 40, climbedAt: newest.climbed_at });
  });

  it('falls back to the steepest other sent angle, then the newest attempt', () => {
    const sentAtFifty = at('2026-06-01 18:00', { angle: 50, status: 'send', tries: 2 });
    const sentAtFortyFive = at('2026-06-09 18:00', { angle: 45, status: 'send', tries: 2 });
    const newerAttempt = at('2026-06-12 18:00', { angle: 55, tries: 2 });
    expect(deriveClimbLedger([sentAtFifty, sentAtFortyFive, newerAttempt], { currentAngle: 40 }).verdict).toEqual({
      kind: 'send',
      angle: 50,
      climbedAt: sentAtFifty.climbed_at,
    });
    expect(
      deriveClimbLedger([at('2026-06-02 18:00', { angle: 30 }), newerAttempt], { currentAngle: 40 }).verdict,
    ).toEqual({ kind: 'attempt', angle: 55, climbedAt: newerAttempt.climbed_at });
  });

  it('quotes today’s repeat rather than last year’s send', () => {
    const repeat = at('2026-06-09 18:00', { status: 'send', tries: 1 });
    const ledger = deriveClimbLedger([at('2025-06-09 18:00', { status: 'send', tries: 4 }), repeat], {
      currentAngle: 40,
    });
    expect(ledger.verdict).toEqual({ kind: 'send', angle: 40, climbedAt: repeat.climbed_at });
  });

  it('says flash only for a lone flash', () => {
    const flash = at('2025-06-09 18:00', { status: 'flash' });
    expect(deriveClimbLedger([flash], { currentAngle: 40 }).verdict).toEqual({
      kind: 'flash',
      angle: 40,
      climbedAt: flash.climbed_at,
    });
    const repeat = at('2026-06-09 18:00', { status: 'send', tries: 1 });
    expect(deriveClimbLedger([flash, repeat], { currentAngle: 40 }).verdict).toEqual({
      kind: 'send',
      angle: 40,
      climbedAt: repeat.climbed_at,
    });
  });
});
