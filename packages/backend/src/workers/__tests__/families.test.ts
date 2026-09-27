import type { PgBoss } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import { createDb } from '@boardsesh/db/client';
import { BACKGROUND_WORKER_ROLES } from '@boardsesh/db/background-jobs';
import { allFamilies, familiesForRole, requireFamily } from '../families';
import { enqueueBackgroundJob, requireFamilyRole } from '../jobs';

describe('family registry', () => {
  it('serves the probe on every role and refuses unknown names', () => {
    for (const role of BACKGROUND_WORKER_ROLES) {
      expect(familiesForRole(role).map((family) => family.name)).toContain('worker-probe');
    }
    expect(allFamilies().map((family) => family.name)).toEqual([
      'worker-probe',
      'refresh-recommendations',
      'refresh-hold-features',
      'refresh-climb-grades',
    ]);
    expect(() => requireFamily('no-such-family')).toThrow('UNKNOWN_FAMILY');
  });
});

describe('requireFamilyRole', () => {
  const singleRole = { roles: ['batch'] as const };
  const multiRole = { roles: ['batch', 'routine-provider'] as const };

  it("defaults to a single-role family's role and accepts it explicitly", () => {
    expect(requireFamilyRole(singleRole, undefined)).toBe('batch');
    expect(requireFamilyRole(singleRole, 'batch')).toBe('batch');
    expect(requireFamilyRole(multiRole, 'routine-provider')).toBe('routine-provider');
  });

  it('throws FAMILY_ROLE_REQUIRED when a multi-role family gets no role', () => {
    expect(() => requireFamilyRole(multiRole, undefined)).toThrow('FAMILY_ROLE_REQUIRED');
  });

  it('throws FAMILY_ROLE_MISMATCH for a role the family does not serve', () => {
    expect(() => requireFamilyRole(singleRole, 'interactive-import')).toThrow('FAMILY_ROLE_MISMATCH');
    expect(() => requireFamilyRole(multiRole, 'maintenance-delivery')).toThrow('FAMILY_ROLE_MISMATCH');
  });

  it('refuses to enqueue the multi-role probe without a role, before touching pg-boss', async () => {
    const untouchedBoss = {} as unknown as PgBoss;
    await expect(
      enqueueBackgroundJob(createDb(), untouchedBoss, { family: 'worker-probe', payload: {} }),
    ).rejects.toThrow('FAMILY_ROLE_REQUIRED');
  });
});
