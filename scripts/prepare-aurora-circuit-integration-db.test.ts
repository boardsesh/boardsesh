import { describe, expect, it } from 'vitest';

import {
  columnMatchesCanonical,
  indexMatchesCanonical,
  ledgerSnapshotsMatch,
  requireCompatibilityOptIn,
  requireLocalDatabaseUrl,
  type PlaylistColumnDefinition,
  type PlaylistIndexDefinition,
} from './prepare-aurora-circuit-integration-db';

const canonicalColumn: PlaylistColumnDefinition = {
  columnName: 'kilter_id',
  dataType: 'text',
  underlyingTypeSchema: 'pg_catalog',
  underlyingTypeName: 'text',
  formattedType: 'text',
  nullable: true,
};

const canonicalIndex: PlaylistIndexDefinition = {
  indexName: 'playlists_kilter_id_idx',
  relationSchema: 'public',
  relationName: 'playlists',
  relationKind: 'i',
  accessMethod: 'btree',
  unique: true,
  ready: true,
  valid: true,
  nullsNotDistinct: false,
  predicate: null,
  expressions: null,
  keyColumnCount: 1,
  attributeCount: 1,
  keyColumns: ['kilter_id'],
  keyOpclasses: ['pg_catalog.text_ops'],
  keyCollations: ['pg_catalog.default'],
  keyOptions: [0],
};

describe('Aurora circuit schema compatibility guards', () => {
  it('requires an explicit opt-in', () => {
    expect(() => requireCompatibilityOptIn({})).toThrow('ALLOW_AURORA_CIRCUIT_SCHEMA_COMPAT=1');
    expect(() => requireCompatibilityOptIn({ ALLOW_AURORA_CIRCUIT_SCHEMA_COMPAT: '1' })).not.toThrow();
  });

  it('allows only local PostgreSQL URLs', () => {
    expect(requireLocalDatabaseUrl('postgresql://postgres:password@localhost:5433/main')).toContain('localhost');
    expect(requireLocalDatabaseUrl('postgres://postgres:password@127.0.0.1/main')).toContain('127.0.0.1');
    expect(() => requireLocalDatabaseUrl('postgresql://postgres:password@example.com/main')).toThrow('non-local');
    expect(() => requireLocalDatabaseUrl('https://localhost/main')).toThrow('postgres');
  });

  it('rejects wrong playlist column types or nullability', () => {
    expect(columnMatchesCanonical(canonicalColumn, canonicalColumn)).toBe(true);
    expect(columnMatchesCanonical({ ...canonicalColumn, nullable: false }, canonicalColumn)).toBe(false);
    expect(columnMatchesCanonical({ ...canonicalColumn, dataType: 'uuid' }, canonicalColumn)).toBe(false);
    expect(columnMatchesCanonical({ ...canonicalColumn, underlyingTypeSchema: 'custom' }, canonicalColumn)).toBe(false);
    expect(columnMatchesCanonical({ ...canonicalColumn, underlyingTypeName: 'varchar' }, canonicalColumn)).toBe(false);
    expect(columnMatchesCanonical({ ...canonicalColumn, formattedType: 'character varying' }, canonicalColumn)).toBe(
      false,
    );
  });

  it('rejects noncanonical timestamp precision', () => {
    const canonicalTimestamp: PlaylistColumnDefinition = {
      columnName: 'kilter_synced_at',
      dataType: 'timestamp without time zone',
      underlyingTypeSchema: 'pg_catalog',
      underlyingTypeName: 'timestamp',
      formattedType: 'timestamp without time zone',
      nullable: true,
    };

    expect(columnMatchesCanonical(canonicalTimestamp, canonicalTimestamp)).toBe(true);
    expect(
      columnMatchesCanonical(
        { ...canonicalTimestamp, formattedType: 'timestamp(0) without time zone' },
        canonicalTimestamp,
      ),
    ).toBe(false);
  });

  it('requires the exact canonical unique single-column index', () => {
    const expectedIndex = { indexName: 'playlists_kilter_id_idx', columnName: 'kilter_id' } as const;
    expect(indexMatchesCanonical(canonicalIndex, expectedIndex)).toBe(true);
    expect(indexMatchesCanonical({ ...canonicalIndex, unique: false }, expectedIndex)).toBe(false);
    expect(indexMatchesCanonical({ ...canonicalIndex, predicate: 'kilter_id IS NOT NULL' }, expectedIndex)).toBe(false);
    expect(indexMatchesCanonical({ ...canonicalIndex, expressions: 'lower(kilter_id)' }, expectedIndex)).toBe(false);
    expect(indexMatchesCanonical({ ...canonicalIndex, keyColumns: ['kilter_id', 'uuid'] }, expectedIndex)).toBe(false);
    expect(indexMatchesCanonical({ ...canonicalIndex, attributeCount: 2 }, expectedIndex)).toBe(false);
    expect(indexMatchesCanonical({ ...canonicalIndex, nullsNotDistinct: true }, expectedIndex)).toBe(false);
    expect(indexMatchesCanonical({ ...canonicalIndex, accessMethod: 'hash' }, expectedIndex)).toBe(false);
    expect(indexMatchesCanonical({ ...canonicalIndex, ready: false }, expectedIndex)).toBe(false);
    expect(indexMatchesCanonical({ ...canonicalIndex, valid: false }, expectedIndex)).toBe(false);
    expect(
      indexMatchesCanonical({ ...canonicalIndex, keyOpclasses: ['pg_catalog.text_pattern_ops'] }, expectedIndex),
    ).toBe(false);
    expect(indexMatchesCanonical({ ...canonicalIndex, keyCollations: ['public.custom'] }, expectedIndex)).toBe(false);
    expect(indexMatchesCanonical({ ...canonicalIndex, keyOptions: [1] }, expectedIndex)).toBe(false);
    expect(indexMatchesCanonical({ ...canonicalIndex, keyOptions: [2] }, expectedIndex)).toBe(false);
  });

  it('detects changes to complete ledger rows even when created_at is null', () => {
    const before = {
      row_count: '1',
      ordered_rows: '[{"id":1,"hash":"original","created_at":null}]',
    };

    expect(ledgerSnapshotsMatch(before, before)).toBe(true);
    expect(
      ledgerSnapshotsMatch(before, {
        row_count: '1',
        ordered_rows: '[{"id":1,"hash":"changed","created_at":null}]',
      }),
    ).toBe(false);
    expect(
      ledgerSnapshotsMatch(before, {
        row_count: '1',
        ordered_rows: '[{"id":2,"hash":"original","created_at":null}]',
      }),
    ).toBe(false);
  });
});
