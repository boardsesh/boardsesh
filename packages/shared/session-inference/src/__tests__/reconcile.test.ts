import { describe, expect, it } from 'vitest';
import { SESSION_GAP_MS, expandWindow, expandReconciliationWindow, reconcileWindow } from '../index';
import type { ExistingExplicitSession, ExistingInferredSession, InferenceTick } from '../types';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const DAY_ONE = Date.UTC(2026, 8, 1, 9, 0, 0);

function tick(id: number, climbedAt: number, sessionId: string | null = null): InferenceTick {
  return { id, climbedAt, sessionId };
}

/** A run of `count` ticks 10 minutes apart, ids ascending from `startId`. */
function run(startId: number, startAt: number, count: number): InferenceTick[] {
  return Array.from({ length: count }, (_, i) => tick(startId + i, startAt + i * 10 * MINUTE));
}

function inferred(id: string, anchorTickId: number, userEdited = false): ExistingInferredSession {
  return { id, anchorTickId, userEdited };
}

function explicit(id: string, firstTickAt: number, lastTickAt: number): ExistingExplicitSession {
  return { id, firstTickAt, lastTickAt };
}

function reconcile(
  ticks: InferenceTick[],
  existingInferred: ExistingInferredSession[] = [],
  existingExplicit: ExistingExplicitSession[] = [],
) {
  return reconcileWindow({ ticks, existingInferred, existingExplicit });
}

describe('drawing runs', () => {
  it('keeps ticks inside the gap threshold together', () => {
    const result = reconcile(run(1, DAY_ONE, 5));

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].tickIds).toEqual([1, 2, 3, 4, 5]);
  });

  it('splits when the gap exceeds the threshold', () => {
    const morning = run(1, DAY_ONE, 3);
    const evening = run(10, DAY_ONE + 10 * HOUR, 3);
    const result = reconcile([...morning, ...evening]);

    expect(result.runs).toHaveLength(2);
    expect(result.runs[0].tickIds).toEqual([1, 2, 3]);
    expect(result.runs[1].tickIds).toEqual([10, 11, 12]);
  });

  it('does not split exactly at the threshold', () => {
    const result = reconcile([tick(1, DAY_ONE), tick(2, DAY_ONE + SESSION_GAP_MS)]);

    expect(result.runs).toHaveLength(1);
  });

  // 1.2% of real sessions cross midnight. The old day-bucketed grouping cut every one
  // of them in half; a gap rule has no reason to.
  it('keeps a session that runs past midnight whole', () => {
    const lateNight = [
      tick(1, Date.UTC(2026, 8, 1, 22, 0)),
      tick(2, Date.UTC(2026, 8, 1, 23, 30)),
      tick(3, Date.UTC(2026, 8, 2, 0, 45)),
    ];
    const result = reconcile(lateNight);

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].tickIds).toEqual([1, 2, 3]);
  });

  it('orders unsorted input before drawing runs', () => {
    const shuffled = [tick(3, DAY_ONE + 20 * MINUTE), tick(1, DAY_ONE), tick(2, DAY_ONE + 10 * MINUTE)];
    const result = reconcile(shuffled);

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].tickIds).toEqual([1, 2, 3]);
  });
});

describe('identity is anchored to an immutable tick id', () => {
  it('inherits the existing session when the run still holds its anchor', () => {
    const result = reconcile(run(1, DAY_ONE, 4), [inferred('sess-a', 1)]);

    expect(result.runs[0].sessionId).toBe('sess-a');
    expect(result.merges).toEqual([]);
    expect(result.emptiedSessionIds).toEqual([]);
  });

  it('mints a new session when no anchor is present', () => {
    const result = reconcile(run(1, DAY_ONE, 3));

    expect(result.runs[0].sessionId).toBeNull();
    expect(result.runs[0].anchorTickId).toBe(1);
  });

  // The v1 identity bug: ids were uuidv5(userId + ':' + firstTickTimestamp), so a
  // back-dated tick that became the new first tick re-keyed the session and orphaned
  // its votes and comments. Anchoring to the lowest tick id — assigned at insert,
  // never reassigned — makes an earlier climbedAt irrelevant.
  it('keeps the session id when a back-dated tick becomes the earliest climb', () => {
    const original = run(1, DAY_ONE, 3);
    const backdated = tick(99, DAY_ONE - 30 * MINUTE);
    const result = reconcile([backdated, ...original], [inferred('sess-a', 1)]);

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].sessionId).toBe('sess-a');
    expect(result.runs[0].tickIds).toContain(99);
  });
});

describe('merging when a back-dated tick bridges two sessions', () => {
  const morning = run(1, DAY_ONE, 3);
  const evening = run(10, DAY_ONE + 10 * HOUR, 3);
  // Lands in the middle, within 4h of both ends, welding the two runs into one.
  const bridge = [tick(50, DAY_ONE + 4 * HOUR), tick(51, DAY_ONE + 7 * HOUR)];

  it('merges the two sessions into one run', () => {
    const result = reconcile([...morning, ...bridge, ...evening], [inferred('sess-a', 1), inferred('sess-b', 10)]);

    expect(result.runs).toHaveLength(1);
    expect(result.merges).toHaveLength(1);
  });

  it('keeps the session the climber has named', () => {
    const result = reconcile(
      [...morning, ...bridge, ...evening],
      [inferred('sess-a', 1), inferred('sess-b', 10, true)],
    );

    expect(result.runs[0].sessionId).toBe('sess-b');
    expect(result.merges).toEqual([{ survivorId: 'sess-b', loserId: 'sess-a' }]);
  });

  it('falls back to the earlier anchor when neither was edited', () => {
    const result = reconcile([...morning, ...bridge, ...evening], [inferred('sess-b', 10), inferred('sess-a', 1)]);

    expect(result.runs[0].sessionId).toBe('sess-a');
    expect(result.merges).toEqual([{ survivorId: 'sess-a', loserId: 'sess-b' }]);
  });

  // The loser is reported as a merge, never as an emptied session — the caller must
  // re-point its votes and comments before deleting it. v1 deleted emptied sessions
  // outright and orphaned their social rows, which migration 0120 then had to sweep.
  it('reports the absorbed session as a merge, not as emptied', () => {
    const result = reconcile([...morning, ...bridge, ...evening], [inferred('sess-a', 1), inferred('sess-b', 10)]);

    expect(result.emptiedSessionIds).toEqual([]);
    expect(result.merges[0].loserId).toBe('sess-b');
  });
});

// In the steady state every tick already carries the inferred session id it was last
// assigned, so these are the realistic inputs — not the all-null ones most of the
// fixtures above use. An earlier version short-circuited on "this run has an assigned
// id" without checking whose it was, which bypassed anchor and merge resolution on
// essentially every real reconciliation.
describe('runs whose ticks already carry an inferred session id', () => {
  const morning = run(1, DAY_ONE, 3).map((entry) => ({ ...entry, sessionId: 'sess-a' }));
  const evening = run(10, DAY_ONE + 10 * HOUR, 3).map((entry) => ({ ...entry, sessionId: 'sess-b' }));
  const bridge = [tick(50, DAY_ONE + 4 * HOUR), tick(51, DAY_ONE + 7 * HOUR)];

  it('still merges two inferred sessions a back-dated tick bridges', () => {
    const result = reconcile([...morning, ...bridge, ...evening], [inferred('sess-a', 1), inferred('sess-b', 10)]);

    expect(result.runs).toHaveLength(1);
    expect(result.merges).toEqual([{ survivorId: 'sess-a', loserId: 'sess-b' }]);
    expect(result.emptiedSessionIds).toEqual([]);
  });

  it('still honours user_edited when picking the merge survivor', () => {
    const result = reconcile(
      [...morning, ...bridge, ...evening],
      [inferred('sess-a', 1), inferred('sess-b', 10, true)],
    );

    expect(result.runs[0].sessionId).toBe('sess-b');
  });

  // The nastiest shape: an inferred run immediately before a party session on the same
  // day. Short-circuiting on the first assigned id would hand the party session's own
  // ticks to the inferred session.
  it('never reassigns explicit-session ticks to an inferred session', () => {
    const loose = run(1, DAY_ONE, 2).map((entry) => ({ ...entry, sessionId: 'sess-a' }));
    const partyTicks = run(10, DAY_ONE + 90 * MINUTE, 3).map((entry) => ({
      ...entry,
      sessionId: 'party-1',
    }));
    const party = explicit('party-1', DAY_ONE + 90 * MINUTE, DAY_ONE + 2 * HOUR);

    const result = reconcile([...loose, ...partyTicks], [inferred('sess-a', 1)], [party]);

    for (const resolvedRun of result.runs) {
      expect(resolvedRun.sessionId).toBe('party-1');
    }
    // sess-a lost every tick to the party session, so it is emptied, not merged.
    expect(result.emptiedSessionIds).toEqual(['sess-a']);
  });
});

describe('explicit sessions win', () => {
  const sessionTicks = run(10, DAY_ONE + 8 * HOUR, 4).map((entry) => ({ ...entry, sessionId: 'party-1' }));
  const party = explicit('party-1', DAY_ONE + 8 * HOUR, DAY_ONE + 8 * HOUR + 30 * MINUTE);

  it('absorbs loose ticks logged earlier the same day', () => {
    const beforeStart = run(1, DAY_ONE, 2);
    const result = reconcile([...beforeStart, ...sessionTicks], [], [party]);

    for (const resolvedRun of result.runs) {
      expect(resolvedRun.sessionId).toBe('party-1');
    }
    const assigned = result.runs.flatMap((resolvedRun) => resolvedRun.tickIds);
    expect(assigned).toEqual(expect.arrayContaining([1, 2, 10]));
  });

  it('empties an inferred session whose ticks the explicit one takes', () => {
    const beforeStart = run(1, DAY_ONE, 2);
    const result = reconcile([...beforeStart, ...sessionTicks], [inferred('sess-a', 1)], [party]);

    expect(result.emptiedSessionIds).toEqual(['sess-a']);
  });

  it('leaves another day alone', () => {
    const otherDay = run(1, DAY_ONE + 48 * HOUR, 3);
    const result = reconcile([...sessionTicks, ...otherDay], [], [party]);

    const otherRun = result.runs.find((resolvedRun) => resolvedRun.tickIds.includes(1));
    expect(otherRun?.sessionId).toBeNull();
  });

  it('picks the nearer session when a day holds two', () => {
    const morningParty = explicit('party-am', DAY_ONE, DAY_ONE + 30 * MINUTE);
    const eveningParty = explicit('party-pm', DAY_ONE + 12 * HOUR, DAY_ONE + 13 * HOUR);
    const strays = [tick(77, DAY_ONE + 11 * HOUR)];
    const result = reconcile(strays, [], [morningParty, eveningParty]);

    expect(result.runs[0].sessionId).toBe('party-pm');
  });
});

describe('lone ticks', () => {
  it('folds into a bigger run on the same day', () => {
    const main = run(1, DAY_ONE, 5);
    const afterthought = [tick(80, DAY_ONE + 9 * HOUR)];
    const result = reconcile([...main, ...afterthought]);

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].tickIds).toContain(80);
  });

  it('stands alone when it is the only climbing that day', () => {
    const result = reconcile([tick(1, DAY_ONE)]);

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].tickIds).toEqual([1]);
  });

  it('does not fold into a bigger run on a different day', () => {
    const main = run(1, DAY_ONE, 5);
    const nextDay = [tick(80, DAY_ONE + 30 * HOUR)];
    const result = reconcile([...main, ...nextDay]);

    expect(result.runs).toHaveLength(2);
  });
});

// The property that makes it safe to call from every writer without coordination.
describe('idempotency', () => {
  it('is a no-op when re-run over its own output', () => {
    const ticks = [...run(1, DAY_ONE, 4), ...run(10, DAY_ONE + 10 * HOUR, 3)];
    const first = reconcile(ticks);

    const sessions = first.runs.map((resolvedRun, index) => inferred(`sess-${index}`, resolvedRun.anchorTickId));
    const assigned = ticks.map((entry) => {
      const owning = first.runs.findIndex((resolvedRun) => resolvedRun.tickIds.includes(entry.id));
      return { ...entry, sessionId: `sess-${owning}` };
    });

    const second = reconcileWindow({ ticks: assigned, existingInferred: sessions, existingExplicit: [] });

    expect(second.merges).toEqual([]);
    expect(second.emptiedSessionIds).toEqual([]);
    expect(second.runs.map((resolvedRun) => resolvedRun.sessionId)).toEqual(['sess-0', 'sess-1']);
    expect(second.runs.map((resolvedRun) => resolvedRun.tickIds)).toEqual(
      first.runs.map((resolvedRun) => resolvedRun.tickIds),
    );
  });

  it('leaves a run untouched when a tick lands in the middle of it', () => {
    const before = reconcile(run(1, DAY_ONE, 5), [inferred('sess-a', 1)]);
    const withInsert = reconcile([...run(1, DAY_ONE, 5), tick(60, DAY_ONE + 25 * MINUTE)], [inferred('sess-a', 1)]);

    expect(withInsert.runs).toHaveLength(before.runs.length);
    expect(withInsert.runs[0].sessionId).toBe('sess-a');
    expect(withInsert.merges).toEqual([]);
  });
});

describe('expandWindow', () => {
  it('reaches the ends of a run the window only clips', () => {
    const ticks = run(1, DAY_ONE, 6);
    const middle = ticks[3].climbedAt;
    const expanded = expandWindow(ticks, middle, middle);

    expect(expanded.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('stops at a real gap instead of swallowing the neighbouring run', () => {
    const ticks = [...run(1, DAY_ONE, 3), ...run(10, DAY_ONE + 10 * HOUR, 3)];
    const target = ticks[1].climbedAt;
    const expanded = expandWindow(ticks, target, target);

    expect(expanded.map((entry) => entry.id)).toEqual([1, 2, 3]);
  });

  // Expanding to a partial run would let reconciliation split it, which is exactly
  // the failure the window exists to prevent.
  it('never returns a partial run', () => {
    const ticks = [...run(1, DAY_ONE, 4), ...run(20, DAY_ONE + 12 * HOUR, 4)];
    for (const entry of ticks) {
      const expanded = expandWindow(ticks, entry.climbedAt, entry.climbedAt);
      const ids = expanded.map((item) => item.id);
      const isFirstRun = ids.includes(1);
      expect(ids).toEqual(isFirstRun ? [1, 2, 3, 4] : [20, 21, 22, 23]);
    }
  });

  it('returns nothing when there are no ticks', () => {
    expect(expandWindow([], DAY_ONE, DAY_ONE)).toEqual([]);
  });
});

describe('empty window', () => {
  it('empties every inferred session when the last tick is gone', () => {
    const result = reconcile([], [inferred('sess-a', 1), inferred('sess-b', 5)]);

    expect(result.runs).toEqual([]);
    expect(result.emptiedSessionIds).toEqual(['sess-a', 'sess-b']);
  });
});

describe('expandReconciliationWindow', () => {
  it('includes same-day runs separated by more than four hours', () => {
    const ticks = [...run(1, DAY_ONE, 3), ...run(10, DAY_ONE + 10 * HOUR, 3)];
    expect(expandReconciliationWindow(ticks, DAY_ONE, DAY_ONE)).toEqual(ticks);
  });

  it('includes both whole days when a run crosses midnight', () => {
    const midnight = Date.UTC(2026, 4, 11);
    const ticks = [
      { id: 1, climbedAt: midnight - 12 * HOUR, sessionId: null },
      { id: 2, climbedAt: midnight - HOUR, sessionId: null },
      { id: 3, climbedAt: midnight + HOUR, sessionId: null },
      { id: 4, climbedAt: midnight + 12 * HOUR, sessionId: null },
      { id: 5, climbedAt: midnight + 36 * HOUR, sessionId: null },
    ];
    for (const tick of ticks.slice(0, 4)) {
      expect(expandReconciliationWindow(ticks, tick.climbedAt, tick.climbedAt)).toEqual(ticks.slice(0, 4));
    }
  });
});

describe('multiple explicit sessions in a timing run', () => {
  it('preserves explicit assignments and sends only loose ticks to the nearest session', () => {
    const explicitSessions = [
      explicit('morning', DAY_ONE, DAY_ONE + HOUR),
      explicit('later', DAY_ONE + 2 * HOUR, DAY_ONE + 3 * HOUR),
    ];
    const ticks = [
      tick(1, DAY_ONE, 'morning'),
      tick(2, DAY_ONE + HOUR, 'morning'),
      tick(3, DAY_ONE + HOUR + 5 * MINUTE),
      tick(4, DAY_ONE + 2 * HOUR - 5 * MINUTE),
      tick(5, DAY_ONE + 2 * HOUR, 'later'),
      tick(6, DAY_ONE + 3 * HOUR, 'later'),
    ];
    const result = reconcile(ticks, [], explicitSessions);
    expect(result.runs.map((run) => ({ sessionId: run.sessionId, tickIds: run.tickIds }))).toEqual([
      { sessionId: 'morning', tickIds: [1, 2, 3] },
      { sessionId: 'later', tickIds: [4, 5, 6] },
    ]);
    const assigned = ticks.map((tick) => ({
      ...tick,
      sessionId: result.runs.find((run) => run.tickIds.includes(tick.id))!.sessionId,
    }));
    expect(reconcile(assigned, [], explicitSessions)).toEqual(result);
  });

  it('preserves a lone explicit tick absorbed into another explicit session’s run', () => {
    const ticks = [
      tick(1, DAY_ONE, 'morning'),
      tick(2, DAY_ONE + 10 * MINUTE, 'morning'),
      tick(3, DAY_ONE + 10 * HOUR, 'later'),
    ];
    const result = reconcile(
      ticks,
      [],
      [
        explicit('morning', DAY_ONE, DAY_ONE + 10 * MINUTE),
        explicit('later', DAY_ONE + 10 * HOUR, DAY_ONE + 10 * HOUR),
      ],
    );
    expect(result.runs.map((run) => ({ sessionId: run.sessionId, tickIds: run.tickIds }))).toEqual([
      { sessionId: 'morning', tickIds: [1, 2] },
      { sessionId: 'later', tickIds: [3] },
    ]);
  });
});

describe('explicit sessions crossing midnight', () => {
  it('converges through more than thirty connected UTC days', () => {
    const firstDay = Date.UTC(2026, 0, 1);
    const ticks = Array.from({ length: 40 }, (_, day) => [
      tick(day * 2 + 1, firstDay + day * 24 * HOUR + HOUR, day === 0 ? 'party' : null),
      tick(day * 2 + 2, firstDay + day * 24 * HOUR + 23 * HOUR),
    ]).flat();
    expect(expandReconciliationWindow(ticks, ticks[0].climbedAt, ticks[0].climbedAt)).toEqual(ticks);

    const result = reconcile(ticks, [], [explicit('party', ticks[0].climbedAt, ticks[0].climbedAt)]);
    expect(result.runs.every((run) => run.sessionId === 'party')).toBe(true);
    expect(result.runs.flatMap((run) => run.tickIds).sort((first, second) => first - second)).toEqual(
      ticks.map((tick) => tick.id),
    );
  });

  it('settles same-day absorption before creating a session that the next pass would empty', () => {
    const midnight = Date.UTC(2026, 8, 2);
    const ticks = [
      tick(1, midnight - 14 * HOUR),
      tick(2, midnight - 13 * HOUR),
      tick(3, midnight - HOUR),
      tick(4, midnight + HOUR, 'party'),
    ];
    const result = reconcile(ticks, [], [explicit('party', midnight + HOUR, midnight + HOUR)]);
    expect(result.runs.every((run) => run.sessionId === 'party')).toBe(true);
    expect(result.runs.flatMap((run) => run.tickIds).sort((first, second) => first - second)).toEqual([1, 2, 3, 4]);
  });
});
