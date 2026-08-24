import { describe, expect, it } from 'vitest';

import { classifyAllSuspects, type AnchorTick, type SuspectTick } from '@boardsesh/db/queries';

/**
 * CI-VISIBLE mirror of packages/db/src/queries/ticks/__tests__/climbed-at-correction.test.ts.
 *
 * packages/db runs on `tsx --test` and is absent from vite.config.ts's
 * `test.projects`, and ci.yml only runs its migration-journal test — so the
 * node:test suite next to the classifier does NOT gate a merge on its own.
 * These cases do. They are deliberately the ones whose failure would silently
 * CORRUPT data rather than merely under-correct:
 *
 *   1. the per-row already-correct guard (a bucket median applied to a row that
 *      already lines up is the difference between a repair and a corruption),
 *   2. profile-offset-zero (never write a "correction" of nothing),
 *   3. no-anchor (a climber with no honest history is left alone, not guessed at).
 *
 * If the classifier is ever restructured, these must be updated in lockstep
 * with the node:test file — never deleted as "duplicates".
 */

const HOUR_SECONDS = 60 * 60;

function anchor(climb: string, iso: string): AnchorTick {
  return {
    userId: 'u1',
    boardType: 'kilter',
    canonicalClimbUuid: climb,
    angle: 40,
    climbedAtMs: Date.parse(iso),
    trust: 'native',
  };
}

function suspect(uuid: string, climb: string, iso: string): SuspectTick {
  return {
    uuid,
    userId: 'u1',
    boardType: 'kilter',
    canonicalClimbUuid: climb,
    angle: 40,
    climbedAtMs: Date.parse(iso),
    origin: 'json_import',
    isAuroraTwinMember: false,
  };
}

function shifted(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * HOUR_SECONDS * 1000).toISOString();
}

describe('#3909 climbed_at correction classifier', () => {
  it('never shifts a row that already matches its own anchor, even in a +10h bucket', () => {
    const anchors = [
      anchor('c1', '2026-02-01T10:00:00Z'),
      anchor('c2', '2026-02-02T10:00:00Z'),
      anchor('c3', '2026-02-03T10:00:00Z'),
      anchor('c4', '2026-02-04T10:00:00Z'),
    ];
    const suspects = [
      suspect('s2', 'c2', shifted('2026-02-02T10:00:00Z', 10)),
      suspect('s3', 'c3', shifted('2026-02-03T10:00:00Z', 10)),
      suspect('s4', 'c4', shifted('2026-02-04T10:00:00Z', 10)),
      suspect('s1', 'c1', '2026-02-01T10:00:03Z'),
    ];

    const decisions = classifyAllSuspects(anchors, suspects);
    const alreadyCorrect = decisions.find((entry) => entry.suspect.uuid === 's1');
    expect(alreadyCorrect?.verdict).toEqual({ verdict: 'already-correct', reason: 'row-matches-own-anchor' });

    // …while the genuinely shifted siblings are still corrected.
    const shiftedDecision = decisions.find((entry) => entry.suspect.uuid === 's3');
    expect(shiftedDecision?.verdict.verdict).toBe('shift');
    if (shiftedDecision?.verdict.verdict !== 'shift') return;
    expect(new Date(shiftedDecision.verdict.correctedMs).toISOString()).toBe('2026-02-03T10:00:00.000Z');
  });

  it('abstains rather than writing a zero-offset "correction"', () => {
    const anchors = [
      anchor('c1', '2026-02-01T10:00:00Z'),
      anchor('c2', '2026-02-02T10:00:00Z'),
      anchor('c3', '2026-02-03T10:00:00Z'),
    ];
    const suspects = [
      suspect('s1', 'c1', '2026-02-01T10:02:00Z'),
      suspect('s2', 'c2', '2026-02-02T10:02:00Z'),
      suspect('s3', 'c3', '2026-02-03T10:02:00Z'),
    ];

    const verdicts = classifyAllSuspects(anchors, suspects).map((entry) => entry.verdict);
    expect(verdicts.every((verdict) => verdict.verdict === 'abstain')).toBe(true);
    expect(verdicts[0]).toEqual({ verdict: 'abstain', reason: 'profile-offset-zero' });
  });

  it('leaves a climber with no honest anchor completely alone', () => {
    const suspects = [suspect('s1', 'c1', '2026-02-01T20:00:00Z'), suspect('s2', 'c2', '2026-02-02T20:00:00Z')];

    const decisions = classifyAllSuspects([], suspects);
    expect(decisions.map((entry) => entry.verdict)).toEqual([
      { verdict: 'abstain', reason: 'no-anchor' },
      { verdict: 'abstain', reason: 'no-anchor' },
    ]);
  });
});
