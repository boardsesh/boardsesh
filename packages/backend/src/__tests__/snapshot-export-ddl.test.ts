// The DDL a board-snapshot artifact is built from, checked without Postgres.
//
// `boardSnapshotDdlStatements` picks statements out of the client MIGRATIONS by a
// word-boundary match on the snapshot table names. The device also builds tables
// of its own (the derived holds index, DEVICE_ONLY_TABLES) that must never ship in
// a public artifact; this pins both halves: what goes in, and what cannot.

import { describe, it, expect } from 'vite-plus/test';
import { DatabaseSync } from 'node:sqlite';
import { DEVICE_ONLY_TABLES } from '@boardsesh/offline-sync';
import { boardSnapshotDdlStatements } from '../scripts/export-board-snapshots';

const ARTIFACT_TABLES = ['board_climb_stats', 'board_climbs', 'snapshot_meta'];

function tableNamesAfterApplying(statements: readonly string[]): string[] {
  const database = new DatabaseSync(':memory:');
  try {
    for (const statement of statements) database.exec(statement);
    return (
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
  } finally {
    database.close();
  }
}

describe('boardSnapshotDdlStatements', () => {
  it('names only the artifact tables in every statement', () => {
    for (const statement of boardSnapshotDdlStatements()) {
      const namesAKnownTable = ARTIFACT_TABLES.some((table) => new RegExp(`\\b${table}\\b`).test(statement));
      expect(namesAKnownTable, statement).toBe(true);
    }
  });

  it('creates exactly board_climbs, board_climb_stats and snapshot_meta', () => {
    expect(tableNamesAfterApplying(boardSnapshotDdlStatements())).toEqual(ARTIFACT_TABLES);
  });

  it('never carries a device-only table', () => {
    expect([...DEVICE_ONLY_TABLES].sort()).toEqual([
      'board_climb_hold_postings',
      'board_climb_hold_sets',
      'holds_index_climbs',
    ]);
    for (const statement of boardSnapshotDdlStatements()) {
      for (const table of DEVICE_ONLY_TABLES) {
        expect(statement, statement).not.toMatch(new RegExp(`\\b${table}\\b`));
      }
    }
  });

  it('carries the sync_seq index on board_climbs, which names only a snapshot table', () => {
    expect(boardSnapshotDdlStatements().some((statement) => statement.includes('idx_climbs_sync_seq'))).toBe(true);
    expect(
      boardSnapshotDdlStatements().some((statement) => /hold_sets|hold_postings|holds_index/.test(statement)),
    ).toBe(false);
  });

  it('keeps the grades artifact to board_climb_grades and snapshot_meta', () => {
    expect(tableNamesAfterApplying(boardSnapshotDdlStatements(['board_climb_grades']))).toEqual([
      'board_climb_grades',
      'snapshot_meta',
    ]);
  });
});
