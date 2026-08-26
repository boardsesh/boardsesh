// The nightly board-catalogue export: what lands in the artifact, what is
// deliberately left out of it, and the ordering contract the seeded developer
// database image loads it by.
//
// S3 is mocked at the storage/s3 boundary (same as snapshot-export-run.test.ts);
// Postgres is the real worker test DB.

import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';

vi.mock('../storage/s3', () => ({
  isS3Configured: vi.fn(() => true),
  getPublicUrl: vi.fn((key: string) => `https://cdn.example/${key}`),
  uploadToS3: vi.fn(async (_buffer: Buffer, key: string) => ({ url: `https://cdn.example/${key}`, key })),
  deleteFromS3: vi.fn(async () => {}),
  listS3Objects: vi.fn(async () => []),
}));

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sql } from 'drizzle-orm';
import { createPool } from '@boardsesh/db/client';
import {
  CATALOG_SNAPSHOT_TABLES,
  CATALOG_SNAPSHOT_EXCLUDED_COLUMNS,
  catalogSnapshotBaseTables,
  catalogSnapshotDeferredTables,
} from '@boardsesh/db/catalog-snapshot';
import { db } from '../db/client';
import { buildCatalogArtifact, catalogColumnsFor, parseArgs } from '../scripts/export-board-catalog';

const BUILT_AT = '2026-08-26T07:15:58.102Z';

async function resetCatalogTables(): Promise<void> {
  for (const table of [...catalogSnapshotDeferredTables()].reverse()) {
    await db.execute(sql.raw(`DELETE FROM ${table}`));
  }
  await db.execute(sql.raw('DELETE FROM board_climbs'));
  for (const table of [...catalogSnapshotBaseTables()].reverse()) {
    await db.execute(sql.raw(`DELETE FROM ${table}`));
  }
}

async function seedMinimalCatalog(): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_products (board_type, id, name, is_listed, min_count_in_frame, max_count_in_frame)
    VALUES ('kilter', 1, 'Kilter Board', true, 1, 1)
  `);
  await db.execute(sql`
    INSERT INTO board_layouts (board_type, id, product_id, name, is_mirrored, is_listed)
    VALUES ('kilter', 1, 1, 'Original', false, true)
  `);
  await db.execute(sql`
    INSERT INTO board_kits (board_type, serial_number, name, is_autoconnect, is_listed, created_at, updated_at)
    VALUES ('kilter', 'SN-1', 'A kit', true, true, '2026-01-01', '2026-01-02')
  `);
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, is_draft, is_listed)
    VALUES ('climb-1', 'kilter', 1, 'A climb', 'p1r12', false, true)
  `);
  await db.execute(sql`
    INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
    VALUES ('kilter', 'climb-1', 'climb-1', 'backfill')
  `);
  await db.execute(sql`
    INSERT INTO board_beta_links (board_type, climb_uuid, link, foreign_username, angle, is_listed, created_by_user_id)
    VALUES ('kilter', 'climb-1', 'https://instagram.test/p/abc', 'someone', 40, true, NULL)
  `);
}

describe('board catalogue export', () => {
  beforeEach(async () => {
    await resetCatalogTables();
  });

  it('parses its flags and rejects an unsafe key prefix', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, keyPrefix: 'board-snapshots/v1-catalog' });
    expect(parseArgs(['--dry-run', '--key-prefix', 'board-snapshots/staging'])).toEqual({
      dryRun: true,
      keyPrefix: 'board-snapshots/staging',
    });
    expect(() => parseArgs(['--key-prefix', '../escape'])).toThrow(/--key-prefix/);
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
  });

  // These are per-user links to production rows. The artifact is public and the
  // ids resolve in exactly one database, so they must never be exported.
  it('drops the account-linking columns of board_beta_links', async () => {
    const sqlClient = createPool();
    const columns = await catalogColumnsFor(sqlClient, 'board_beta_links');
    const names = columns.map((column) => column.name);

    expect(names).toContain('climb_uuid');
    expect(names).toContain('foreign_username');
    for (const excluded of CATALOG_SNAPSHOT_EXCLUDED_COLUMNS.board_beta_links ?? []) {
      expect(names).not.toContain(excluded);
    }
  });

  it('builds an artifact carrying every contract table plus snapshot_meta', async () => {
    await seedMinimalCatalog();

    const workDir = mkdtempSync(join(tmpdir(), 'catalog-export-test-'));
    const filePath = join(workDir, 'catalog.db');
    try {
      const tables = await buildCatalogArtifact({ sqlClient: createPool(), filePath, builtAt: BUILT_AT });

      expect(Object.keys(tables).sort()).toEqual(CATALOG_SNAPSHOT_TABLES.map((table) => table.name).sort());
      expect(tables.board_products.rowCount).toBe(1);
      expect(tables.board_kits.rowCount).toBe(1);
      expect(tables.board_climb_aliases.rowCount).toBe(1);

      const artifact = new DatabaseSync(filePath, { readOnly: true });
      try {
        // Every row count the loader verifies must match the file it verifies.
        const meta = artifact
          .prepare('SELECT table_name, row_count, built_at, format_version FROM snapshot_meta')
          .all() as {
          table_name: string;
          row_count: number;
          built_at: string;
          format_version: number;
        }[];
        expect(meta).toHaveLength(CATALOG_SNAPSHOT_TABLES.length);
        for (const row of meta) {
          const actual = artifact.prepare(`SELECT count(*) AS n FROM ${row.table_name}`).get() as { n: number };
          expect(actual.n).toBe(row.row_count);
          expect(row.built_at).toBe(BUILT_AT);
          expect(row.format_version).toBe(1);
        }

        // SQLite has no boolean: the loader reads 0/1 back through booleanToPg.
        const kit = artifact.prepare('SELECT is_autoconnect, name FROM board_kits').get() as {
          is_autoconnect: number;
          name: string;
        };
        expect(kit.is_autoconnect).toBe(1);
        expect(kit.name).toBe('A kit');

        const betaLinkColumns = (
          artifact.prepare('PRAGMA table_info(board_beta_links)').all() as { name: string }[]
        ).map((column) => column.name);
        expect(betaLinkColumns).not.toContain('created_by_user_id');
        expect(betaLinkColumns).not.toContain('tick_uuid');
        expect(betaLinkColumns).not.toContain('board_id');
      } finally {
        artifact.close();
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // The artifact is written in load order, and the loader replays it in that
  // order. A table appearing before one its foreign keys point at would fail the
  // image build, not the export.
  it('orders the contract so no table precedes one it references', () => {
    const order: string[] = CATALOG_SNAPSHOT_TABLES.map((table) => table.name);
    const dependencies: Record<string, readonly string[]> = {
      board_layouts: ['board_products'],
      board_product_sizes: ['board_products'],
      board_placement_roles: ['board_products'],
      board_holes: ['board_products'],
      board_placements: ['board_holes', 'board_layouts', 'board_sets', 'board_placement_roles'],
      board_leds: ['board_holes', 'board_product_sizes'],
      board_product_sizes_layouts_sets: ['board_layouts', 'board_product_sizes', 'board_sets'],
    };

    for (const [table, needs] of Object.entries(dependencies)) {
      for (const need of needs) {
        expect(order.indexOf(need)).toBeLessThan(order.indexOf(table));
      }
    }
  });

  it('defers exactly the tables whose rows reference board_climbs', () => {
    expect(catalogSnapshotDeferredTables()).toEqual(['board_climb_aliases', 'board_beta_links']);
    expect(catalogSnapshotBaseTables()).not.toContain('board_climb_aliases');
  });
});
