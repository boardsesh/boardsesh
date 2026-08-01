import { describe, expect, it } from 'vitest';

import {
  columnMatchesCanonical,
  indexMatchesCanonical,
  requireCompatibilityOptIn,
  requireLocalDatabaseUrl,
  type PlaylistColumnDefinition,
  type PlaylistIndexDefinition,
} from './prepare-aurora-circuit-integration-db';

const canonicalColumn: PlaylistColumnDefinition = {
  columnName: 'kilter_id',
  dataType: 'text',
  nullable: true,
};

const canonicalIndex: PlaylistIndexDefinition = {
  indexName: 'playlists_kilter_id_idx',
  relationSchema: 'public',
  relationName: 'playlists',
  relationKind: 'i',
  unique: true,
  valid: true,
  predicate: null,
  expressions: null,
  keyColumnCount: 1,
  attributeCount: 1,
  keyColumns: ['kilter_id'],
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
  });

  it('requires the exact canonical unique single-column index', () => {
    const expectedIndex = { indexName: 'playlists_kilter_id_idx', columnName: 'kilter_id' } as const;
    expect(indexMatchesCanonical(canonicalIndex, expectedIndex)).toBe(true);
    expect(indexMatchesCanonical({ ...canonicalIndex, unique: false }, expectedIndex)).toBe(false);
    expect(indexMatchesCanonical({ ...canonicalIndex, predicate: 'kilter_id IS NOT NULL' }, expectedIndex)).toBe(false);
    expect(indexMatchesCanonical({ ...canonicalIndex, keyColumns: ['kilter_id', 'uuid'] }, expectedIndex)).toBe(false);
  });
});
