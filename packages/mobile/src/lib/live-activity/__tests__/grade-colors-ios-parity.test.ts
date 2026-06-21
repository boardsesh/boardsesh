import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { V_GRADE_COLORS } from '@boardsesh/board-constants/grade-colors';

// The iOS Live Activity widget is native Swift and can't import the TS grade
// table, so it mirrors `V_GRADE_COLORS` into a `GradeColors.table` literal in
// ClimbSessionLiveActivity.swift. This test fails if the two drift, so a change
// to the board-constants palette can't silently leave the lock-screen grade
// colour stale.

const here = dirname(fileURLToPath(import.meta.url));
const SWIFT_PATH = resolve(here, '../../../../targets/BoardseshWidgets/ClimbSessionLiveActivity.swift');

function parseSwiftGradeTable(): Record<string, string> {
  const source = readFileSync(SWIFT_PATH, 'utf8');
  const block = source.match(/static let table: \[String: String\] = \[([\s\S]*?)\]/);
  if (!block) throw new Error('GradeColors.table literal not found in ClimbSessionLiveActivity.swift');
  const table: Record<string, string> = {};
  for (const entry of block[1].matchAll(/"(V\d+)"\s*:\s*"(#[0-9A-Fa-f]{6})"/g)) {
    table[entry[1]] = entry[2].toUpperCase();
  }
  return table;
}

describe('iOS Live Activity grade colours', () => {
  it('GradeColors.table mirrors V_GRADE_COLORS byte-for-byte', () => {
    const swiftTable = parseSwiftGradeTable();
    const expected: Record<string, string> = {};
    for (const [grade, hex] of Object.entries(V_GRADE_COLORS)) {
      expected[grade] = hex.toUpperCase();
    }
    expect(swiftTable).toEqual(expected);
  });
});
