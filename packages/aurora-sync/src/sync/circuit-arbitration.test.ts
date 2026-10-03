import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  auroraCircuitAdvisoryLockStatement,
  getAuroraCircuitAdvisoryLockKey,
  normalizeAuroraCircuitItems,
} from './circuit-arbitration';

describe('Aurora circuit arbitration helpers', () => {
  it('rejects missing, non-string and blank UUIDs, de-duplicates last-row-wins, and sorts', () => {
    const normalized = normalizeAuroraCircuitItems([
      { uuid: 'z-circuit', name: 'old' },
      { name: 'missing' },
      { uuid: 42, name: 'numeric' },
      { uuid: '   ', name: 'blank' },
      { uuid: ' padded ', name: 'padded' },
      { uuid: 'a-circuit', name: 'first' },
      { uuid: 'z-circuit', name: 'new' },
    ]);

    expect(normalized.rejectedCount).toBe(4);
    expect(normalized.items).toEqual([
      { uuid: 'a-circuit', name: 'first' },
      { uuid: 'z-circuit', name: 'new' },
    ]);
  });

  it('renders the namespaced, server-side 64-bit advisory lock statement', () => {
    const rendered = new PgDialect().sqlToQuery(auroraCircuitAdvisoryLockStatement('tension', 'circuit-1'));

    expect(getAuroraCircuitAdvisoryLockKey('tension', 'circuit-1')).toBe('boardsesh:aurora-circuit|tension|circuit-1');
    expect(rendered.sql).toContain('pg_advisory_xact_lock');
    expect(rendered.sql).toContain('hashtextextended');
    expect(rendered.sql).toContain('0::bigint');
    expect(rendered.params).toEqual(['boardsesh:aurora-circuit|tension|circuit-1']);
  });
});
