import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestSqliteDb } from '../../testing/sqlite-test-db';
import { markScopeDownloadComplete } from '../../sync/checkpoints';
import { ensureHoldIndex } from '../hold-index';
import {
  HOLD_ROLE,
  HOLD_ROLE_OTHER,
  aggregateHoldUsage,
  decodeHoldSet,
  decodePostings,
  editPostings,
  encodeHoldSet,
  encodePostings,
  findSimilarClimbCandidates,
  getHoldSet,
  holdStateToRole,
} from '../query';
import { insertClimb, openTestDatabase, parseHoldRows } from './hold-index-fixtures';

describe('hold-set encoding', () => {
  it('round-trips, sorted by hold id, first role per hold winning', () => {
    const bytes = encodeHoldSet([
      { holdId: 70000, role: HOLD_ROLE.FINISH },
      { holdId: 3, role: HOLD_ROLE.STARTING },
      { holdId: 3, role: HOLD_ROLE.HAND },
      { holdId: 12, role: HOLD_ROLE_OTHER },
    ]);
    expect(bytes.byteLength).toBe(15);
    expect(decodeHoldSet(bytes)).toEqual([
      { holdId: 3, role: HOLD_ROLE.STARTING },
      { holdId: 12, role: HOLD_ROLE_OTHER },
      { holdId: 70000, role: HOLD_ROLE.FINISH },
    ]);
  });

  it('is little-endian uint32 + uint8 on disk', () => {
    expect([...encodeHoldSet([{ holdId: 0x01020304, role: HOLD_ROLE.FOOT }])]).toEqual([4, 3, 2, 1, 2]);
  });

  it('decodes a view that does not start at offset 0', () => {
    const backing = new Uint8Array(16);
    backing.set(encodeHoldSet([{ holdId: 9, role: HOLD_ROLE.HAND }]), 3);
    expect(decodeHoldSet(backing.subarray(3, 8))).toEqual([{ holdId: 9, role: HOLD_ROLE.HAND }]);
  });

  it('maps hold state names to role codes', () => {
    expect(['STARTING', 'HAND', 'FOOT', 'FINISH', 'AUX'].map(holdStateToRole)).toEqual([0, 1, 2, 3, HOLD_ROLE_OTHER]);
  });
});

describe('postings encoding', () => {
  it('round-trips', () => {
    expect([...decodePostings(encodePostings([1, 7, 4_000_000_000]))]).toEqual([1, 7, 4_000_000_000]);
    expect(decodePostings(encodePostings([])).length).toBe(0);
  });

  it('edits a sorted list in one merge, and says when nothing changed', () => {
    const edited = editPostings(encodePostings([2, 4, 6]), new Set([1, 5, 4]), new Set([6]));
    expect(edited && [...decodePostings(edited)]).toEqual([1, 2, 4, 5]);
    expect(editPostings(encodePostings([2, 4]), new Set([4]), new Set([9]))).toBeNull();
    expect(editPostings(null, new Set([3, 1]), new Set())).toEqual(encodePostings([1, 3]));
  });
});

describe('aggregateHoldUsage', () => {
  it('counts uses, roles, ascents and difficulty per hold', () => {
    const usage = aggregateHoldUsage([
      {
        holds: encodeHoldSet([
          { holdId: 1, role: HOLD_ROLE.STARTING },
          { holdId: 2, role: HOLD_ROLE.HAND },
        ]),
        ascents: 10,
        difficulty: 20,
      },
      {
        holds: encodeHoldSet([
          { holdId: 1, role: HOLD_ROLE.HAND },
          { holdId: 3, role: HOLD_ROLE_OTHER },
        ]),
        ascents: null,
        difficulty: null,
      },
    ]);
    expect(usage.get(1)).toEqual({
      uses: 2,
      byRole: [1, 1, 0, 0],
      ascentsSum: 10,
      difficultySum: 20,
      difficultyCount: 1,
    });
    expect(usage.get(3)).toEqual({
      uses: 1,
      byRole: [0, 0, 0, 0],
      ascentsSum: 0,
      difficultySum: 0,
      difficultyCount: 0,
    });
    expect(usage.size).toBe(3);
  });
});

describe('findSimilarClimbCandidates', () => {
  let db: TestSqliteDb;
  let close: () => void;

  // A deterministic pseudo-random catalog: 120 climbs over 40 holds.
  const climbs: { uuid: string; holds: number[] }[] = [];
  let seed = 7;
  const next = () => {
    // 32-bit LCG in integer arithmetic (a float multiply would lose the low bits).
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 8;
  };
  for (let index = 0; index < 120; index += 1) {
    const holds = new Set<number>();
    const count = 4 + (next() % 9);
    while (holds.size < count) holds.add(1 + (next() % 40));
    climbs.push({ uuid: `c-${String(index).padStart(3, '0')}`, holds: [...holds] });
  }

  function bruteForce(target: number[], threshold: number, excludeUuid: string) {
    const targetSet = new Set(target);
    return climbs
      .filter((climb) => climb.uuid !== excludeUuid)
      .map((climb) => {
        const shared = climb.holds.filter((holdId) => targetSet.has(holdId)).length;
        const jaccard = shared / (targetSet.size + climb.holds.length - shared);
        return { uuid: climb.uuid, shared, candidateSize: climb.holds.length, jaccard };
      })
      .filter((candidate) => candidate.shared > 0 && candidate.jaccard >= threshold)
      .sort(
        (left, right) =>
          right.jaccard - left.jaccard ||
          right.shared - left.shared ||
          (left.uuid < right.uuid ? -1 : left.uuid > right.uuid ? 1 : 0),
      );
  }

  beforeEach(async () => {
    ({ db, close } = await openTestDatabase());
    await markScopeDownloadComplete(db, 'kilter:1:12');
    let seq = 1;
    for (const climb of climbs) {
      await insertClimb(db, {
        uuid: climb.uuid,
        seq: seq++,
        frames: climb.holds.map((holdId) => `p${holdId}r13`).join(''),
      });
    }
    await insertClimb(db, {
      uuid: 'other-layout',
      seq: seq++,
      layoutId: 2,
      frames: climbs[0].holds.map((h) => `p${h}r13`).join(''),
    });
    await markScopeDownloadComplete(db, 'kilter:2:12');
    await ensureHoldIndex(db, { boardType: 'kilter', layoutId: 1, sizeId: 12 }, { parseHoldRows });
    await ensureHoldIndex(db, { boardType: 'kilter', layoutId: 2, sizeId: 12 }, { parseHoldRows });
  });

  afterEach(() => close());

  it.each([0.2, 0.35, 0.5])('matches a brute-force Jaccard over the catalog at threshold %s', async (threshold) => {
    for (const target of climbs.slice(0, 10)) {
      const actual = await findSimilarClimbCandidates(db, {
        boardType: 'kilter',
        layoutId: 1,
        targetHoldIds: target.holds,
        threshold,
        excludeUuid: target.uuid,
        limit: 1000,
      });
      const expected = bruteForce(target.holds, threshold, target.uuid);
      expect(actual.map((candidate) => candidate.uuid)).toEqual(expected.map((candidate) => candidate.uuid));
      for (const [index, candidate] of actual.entries()) {
        expect(candidate.shared).toBe(expected[index].shared);
        expect(candidate.candidateSize).toBe(expected[index].candidateSize);
        expect(candidate.jaccard).toBeCloseTo(expected[index].jaccard, 12);
      }
    }
  });

  it('stays inside the layout, excludes the target, and caps at limit × 4', async () => {
    const target = climbs[0];
    const capped = await findSimilarClimbCandidates(db, {
      boardType: 'kilter',
      layoutId: 1,
      targetHoldIds: target.holds,
      threshold: 0.01,
      excludeUuid: target.uuid,
      limit: 2,
    });
    expect(capped).toHaveLength(8);
    expect(capped.map((candidate) => candidate.uuid)).not.toContain(target.uuid);
    expect(capped.map((candidate) => candidate.uuid)).not.toContain('other-layout');
  });

  it('drops a posting entry whose hold set is gone', async () => {
    const target = climbs[0];
    await db.runAsync(
      'DELETE FROM board_climb_hold_sets WHERE climb_id = (SELECT id FROM holds_index_climbs WHERE uuid = ?)',
      [climbs[1].uuid],
    );
    const result = await findSimilarClimbCandidates(db, {
      boardType: 'kilter',
      layoutId: 1,
      targetHoldIds: target.holds,
      threshold: 0.01,
      limit: 1000,
    });
    expect(result.map((candidate) => candidate.uuid)).not.toContain(climbs[1].uuid);
  });

  it('returns nothing for an empty target', async () => {
    expect(
      await findSimilarClimbCandidates(db, {
        boardType: 'kilter',
        layoutId: 1,
        targetHoldIds: [],
        threshold: 0.5,
        limit: 12,
      }),
    ).toEqual([]);
  });

  it('reads one climb hold set back by uuid', async () => {
    expect((await getHoldSet(db, climbs[0].uuid))?.map((entry) => entry.holdId)).toEqual(
      [...climbs[0].holds].sort((left, right) => left - right),
    );
    expect(await getHoldSet(db, 'nope')).toBeNull();
  });
});
