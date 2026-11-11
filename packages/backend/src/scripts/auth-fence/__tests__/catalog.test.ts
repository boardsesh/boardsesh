import { describe, expect, it } from 'vite-plus/test';
import { fencePlan, protectedIdentityTable } from '../catalog';
import { operatorConnectionOptions, parseOperatorArguments } from '../operator';
import { assertAuthorityActivationGates, AUTHORITY_ACTIVATION_BLOCKERS } from '../../auth-authority';

describe('authority operator safety', () => {
  it('defaults to read-only status and requires explicit host and dedicated URL', () => {
    expect(parseOperatorArguments(['--confirm-host', 'localhost'], ['status', 'prepare', 'activate']).command).toBe(
      'status',
    );
    expect(() => operatorConnectionOptions({ DATABASE_URL: 'postgres://ignored' }, 'localhost', false)).toThrow();
    expect(() =>
      operatorConnectionOptions(
        { AUTH_OPERATOR_DATABASE_URL: 'postgres://operator:synthetic@localhost/example' },
        'other',
        false,
      ),
    ).toThrow();
    expect(
      operatorConnectionOptions(
        { AUTH_OPERATOR_DATABASE_URL: 'postgres://operator:synthetic@localhost/example' },
        'localhost',
        false,
      ).connection.default_transaction_read_only,
    ).toBe(true);
  });
  it('does not accept activation-gate bypass switches', () => {
    expect(() =>
      parseOperatorArguments(
        ['activate', '--confirm-host', 'localhost', '--force', 'true'],
        ['status', 'prepare', 'activate'],
      ),
    ).toThrow();
    expect(() => assertAuthorityActivationGates()).toThrow('ACTIVATION_CODE_GATES_OPEN');
    expect(AUTHORITY_ACTIVATION_BLOCKERS).toEqual([
      'GARMIN_OFFLINE_TICK_QUEUE_PRESERVATION',
      'STAGED_WEB_PROOF_GENERATION_STAMP',
      'NATIVE_REVOKE_RESET_LOCK_ORDER',
    ]);
  });
  it('denies future auth tables, preserves cutoff reads and prints rollback', () => {
    const plan = fencePlan({
      schemas: ['public'],
      owners: ['boardsesh_owner'],
      routines: [],
      relations: [
        { schema: 'public', name: 'auth_session', kind: 'r', columns: ['token'] },
        { schema: 'public', name: 'auth_subject_cutoffs', kind: 'r', columns: ['generation'] },
        { schema: 'public', name: 'auth_future_identity', kind: 'r', columns: ['id'] },
        { schema: 'public', name: 'gyms', kind: 'r', columns: ['name'] },
      ],
    });
    expect(protectedIdentityTable('auth_future_identity')).toBe(true);
    expect(plan.sql).toContain('GRANT SELECT ON TABLE "public"."auth_subject_cutoffs"');
    expect(plan.sql).not.toContain('GRANT SELECT ON TABLE "public"."auth_session"');
    expect(plan.sql).not.toContain('GRANT INSERT, UPDATE, DELETE ON TABLE "public"."auth_future_identity"');
    expect(plan.sql).toContain('GRANT INSERT, UPDATE, DELETE ON TABLE "public"."gyms"');
    expect(plan.sql).toContain('ALTER DEFAULT PRIVILEGES');
    expect(plan.rollbackSql).toContain('GRANT INSERT, UPDATE, DELETE ON TABLE "public"."auth_subject_cutoffs"');
    expect(plan.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
