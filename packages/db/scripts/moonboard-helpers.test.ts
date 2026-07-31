import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SQL } from 'drizzle-orm';
import {
  coordinateToHoldId,
  movesToFrames,
  moveToHoldState,
  moonBoardGradeToDifficultyId,
  moonBoardGradeConflictFields,
  uuidv5,
  MOONBOARD_UUID_NAMESPACE,
  HOLD_STATE_CODES,
  type MoonBoardMove,
} from './moonboard-helpers.js';
import { sqlText } from '../src/test-utils/sql-text.js';

/**
 * sqlText (see its own doc comment) can't render an interpolated drizzle
 * Column — it only walks plain string/queryChunks arrays, so the COALESCE
 * fallback side renders blank there. That leaves a real gap: a regression
 * that swaps in the WRONG stored column as a field's fallback (e.g.
 * displayDifficulty silently falling back to benchmarkDifficulty's column)
 * would still render as `coalesce(excluded.display_difficulty, )` and pass
 * every sqlText-based assertion below. This helper reaches into the
 * fragment's queryChunks directly and duck-types the drizzle Column shape
 * (has both `name` and `table`, unlike a plain string chunk) to recover the
 * actual stored-side column name, so that class of regression is caught too.
 * Test-only — production code must keep using sqlText/plain SQL, not this.
 */
function isDrizzleColumnChunk(chunk: unknown): chunk is { name: string } {
  return (
    chunk !== null &&
    typeof chunk === 'object' &&
    'table' in chunk &&
    typeof (chunk as { name?: unknown }).name === 'string'
  );
}

function fallbackColumnName(fragment: SQL): string | undefined {
  const chunks = (fragment as unknown as { queryChunks: unknown[] }).queryChunks;
  const columnChunk = chunks.find(isDrizzleColumnChunk);
  return columnChunk?.name;
}

void describe('coordinateToHoldId', () => {
  void it('converts A1 to hold ID 1 (first hold, bottom-left)', () => {
    assert.equal(coordinateToHoldId('A1'), 1);
  });

  void it('converts K1 to hold ID 11 (last column, row 1)', () => {
    assert.equal(coordinateToHoldId('K1'), 11);
  });

  void it('converts A2 to hold ID 12 (first column, row 2)', () => {
    assert.equal(coordinateToHoldId('A2'), 12);
  });

  void it('converts K18 to hold ID 198 (last hold on standard 11x18 board)', () => {
    // (18 - 1) * 11 + 10 + 1 = 187 + 11 = 198
    assert.equal(coordinateToHoldId('K18'), 198);
  });

  void it('handles lowercase column letters', () => {
    assert.equal(coordinateToHoldId('a1'), 1);
    assert.equal(coordinateToHoldId('k18'), 198);
  });

  void it('converts common MoonBoard coordinates correctly', () => {
    // E5 = (5 - 1) * 11 + 4 + 1 = 44 + 5 = 49
    assert.equal(coordinateToHoldId('E5'), 49);
    // J3 = (3 - 1) * 11 + 9 + 1 = 22 + 10 = 32
    assert.equal(coordinateToHoldId('J3'), 32);
    // F10 = (10 - 1) * 11 + 5 + 1 = 99 + 6 = 105
    assert.equal(coordinateToHoldId('F10'), 105);
  });

  void it('throws for invalid column letter', () => {
    assert.throws(() => coordinateToHoldId('Z1'), /Invalid column/);
    assert.throws(() => coordinateToHoldId('L1'), /Invalid column/);
  });
});

void describe('movesToFrames', () => {
  void it('converts a single start move', () => {
    const moves: MoonBoardMove[] = [{ problemId: 1, description: 'A1', isStart: true, isEnd: false }];
    assert.equal(movesToFrames(moves), `p1r${HOLD_STATE_CODES.start}`);
  });

  void it('converts a single finish move', () => {
    const moves: MoonBoardMove[] = [{ problemId: 1, description: 'K18', isStart: false, isEnd: true }];
    assert.equal(movesToFrames(moves), `p198r${HOLD_STATE_CODES.finish}`);
  });

  void it('converts a single hand move', () => {
    const moves: MoonBoardMove[] = [{ problemId: 1, description: 'E5', isStart: false, isEnd: false }];
    assert.equal(movesToFrames(moves), `p49r${HOLD_STATE_CODES.hand}`);
  });

  void it('converts a full problem with start, hand, and finish moves', () => {
    const moves: MoonBoardMove[] = [
      { problemId: 1, description: 'A1', isStart: true, isEnd: false },
      { problemId: 1, description: 'E5', isStart: false, isEnd: false },
      { problemId: 1, description: 'K18', isStart: false, isEnd: true },
    ];
    const result = movesToFrames(moves);
    assert.equal(result, 'p1r42p49r43p198r44');
  });

  void it('returns empty string for empty moves array', () => {
    assert.equal(movesToFrames([]), '');
  });
});

void describe('moveToHoldState', () => {
  void it('returns STARTING for start moves', () => {
    assert.equal(moveToHoldState({ problemId: 1, description: 'A1', isStart: true, isEnd: false }), 'STARTING');
  });

  void it('returns FINISH for end moves', () => {
    assert.equal(moveToHoldState({ problemId: 1, description: 'K18', isStart: false, isEnd: true }), 'FINISH');
  });

  void it('returns HAND for regular moves', () => {
    assert.equal(moveToHoldState({ problemId: 1, description: 'E5', isStart: false, isEnd: false }), 'HAND');
  });
});

void describe('moonBoardGradeToDifficultyId', () => {
  void it('maps MoonBoard 5-series grades into shared difficulty ids', () => {
    assert.equal(moonBoardGradeToDifficultyId('5+'), 13);
    assert.equal(moonBoardGradeToDifficultyId('5A'), 13);
    assert.equal(moonBoardGradeToDifficultyId('5B'), 14);
    assert.equal(moonBoardGradeToDifficultyId('5C'), 15);
  });

  void it('keeps MoonBoard 6B on the shared boulder grade id', () => {
    assert.equal(moonBoardGradeToDifficultyId('6B'), 18);
    assert.equal(moonBoardGradeToDifficultyId('6b'), 18);
  });

  void it('maps the top MoonBoard dump grade', () => {
    assert.equal(moonBoardGradeToDifficultyId('8B+'), 31);
  });

  void it('maps 8C and 8C+ into the shared difficulty ids', () => {
    assert.equal(moonBoardGradeToDifficultyId('8C'), 32);
    assert.equal(moonBoardGradeToDifficultyId('8C+'), 33);
    assert.equal(moonBoardGradeToDifficultyId('8c'), 32);
    assert.equal(moonBoardGradeToDifficultyId('8c+'), 33);
  });

  void it('returns undefined for unknown grades', () => {
    assert.equal(moonBoardGradeToDifficultyId('9A'), undefined);
  });
});

void describe('uuidv5', () => {
  void it('produces a valid UUID format', () => {
    const uuid = uuidv5('test', MOONBOARD_UUID_NAMESPACE);
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    assert.match(uuid, uuidRegex);
  });

  void it('sets version 5 in the UUID', () => {
    const uuid = uuidv5('test', MOONBOARD_UUID_NAMESPACE);
    // Version is the 13th character (index 14 after dashes)
    assert.equal(uuid.charAt(14), '5');
  });

  void it('sets the correct variant bits', () => {
    const uuid = uuidv5('test', MOONBOARD_UUID_NAMESPACE);
    // Variant is the 17th hex char (index 19 after dashes), must be 8, 9, a, or b
    const variantChar = uuid.charAt(19);
    assert.ok(['8', '9', 'a', 'b'].includes(variantChar), `Expected variant char to be 8/9/a/b, got: ${variantChar}`);
  });

  void it('produces deterministic output (same input = same UUID)', () => {
    const uuid1 = uuidv5('moonboard:12345', MOONBOARD_UUID_NAMESPACE);
    const uuid2 = uuidv5('moonboard:12345', MOONBOARD_UUID_NAMESPACE);
    assert.equal(uuid1, uuid2);
  });

  void it('produces different UUIDs for different inputs', () => {
    const uuid1 = uuidv5('moonboard:12345', MOONBOARD_UUID_NAMESPACE);
    const uuid2 = uuidv5('moonboard:67890', MOONBOARD_UUID_NAMESPACE);
    assert.notEqual(uuid1, uuid2);
  });

  void it('matches RFC 4122 reference value for DNS namespace', () => {
    // Well-known test vector: uuid5("python.org", DNS namespace) = "886313e1-3b8a-5372-9b90-0c9aee199e5d"
    const uuid = uuidv5('python.org', MOONBOARD_UUID_NAMESPACE);
    assert.equal(uuid, '886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });
});

// issue #3530: a re-run of the deprecated single-file MoonBoard importers must
// never let a stale/absent incoming grade clobber a newer stored one. These
// assertions check the actual rendered SQL text (via sqlText, the same
// technique moonboard-catalog-helpers.test.ts uses for catalogAliasConflictUpdate)
// so a regression that reverts any one field back to a bare `excluded.*` (no
// fallback) fails here, not just a check for the fragment's absence. sqlText
// can't render the interpolated Column object itself (it only walks plain
// string/queryChunks arrays), so the stored-value side renders blank — these
// assertions pin the part sqlText CAN see: that each field is COALESCE-wrapped
// with `excluded.<column>` as the first (incoming) argument.
void describe('moonBoardGradeConflictFields', () => {
  void it('COALESCEs displayDifficulty: excluded.display_difficulty incoming, display_difficulty stored fallback', () => {
    const fields = moonBoardGradeConflictFields();
    assert.match(sqlText(fields.displayDifficulty), /^coalesce\(excluded\.display_difficulty,/i);
    assert.equal(fallbackColumnName(fields.displayDifficulty), 'display_difficulty');
  });

  void it('COALESCEs benchmarkDifficulty: excluded.benchmark_difficulty incoming, benchmark_difficulty stored fallback', () => {
    const fields = moonBoardGradeConflictFields();
    assert.match(sqlText(fields.benchmarkDifficulty), /^coalesce\(excluded\.benchmark_difficulty,/i);
    assert.equal(fallbackColumnName(fields.benchmarkDifficulty), 'benchmark_difficulty');
  });

  void it('COALESCEs difficultyAverage: excluded.difficulty_average incoming, difficulty_average stored fallback', () => {
    const fields = moonBoardGradeConflictFields();
    assert.match(sqlText(fields.difficultyAverage), /^coalesce\(excluded\.difficulty_average,/i);
    assert.equal(fallbackColumnName(fields.difficultyAverage), 'difficulty_average');
  });

  void it('never takes any of the three fields straight from excluded with no fallback', () => {
    const fields = moonBoardGradeConflictFields();
    for (const [name, fragment] of Object.entries(fields)) {
      const text = sqlText(fragment).toLowerCase();
      assert.ok(text.startsWith('coalesce('), `${name} should be COALESCE-wrapped, got: ${text}`);
    }
  });
});
