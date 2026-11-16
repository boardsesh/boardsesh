import { describe, expect, it } from 'vite-plus/test';
import { fencePlan, protectedIdentityTable } from '../catalog';
import { operatorConnectionOptions, parseOperatorArguments } from '../operator';
import { assertAuthorityActivationGates, AUTHORITY_ACTIVATION_BLOCKERS } from '../../auth-authority';
import { authFenceRefusalCode, runAuthFence } from '../../auth-fence';
import { ExplicitConnectionConfigurationError } from '../../../auth/email-audit/connection';

describe('auth-fence command line', () => {
  it('defaults to the read-only plan and accepts verify', () => {
    expect(parseOperatorArguments(['--confirm-host', 'localhost'], ['plan', 'apply', 'verify']).command).toBe('plan');
    expect(parseOperatorArguments(['verify', '--confirm-host', 'localhost'], ['plan', 'apply', 'verify']).command).toBe(
      'verify',
    );
  });
  it('accepts the argument boundary `vp run auth:fence -- …` forwards, once', () => {
    expect(
      parseOperatorArguments(['--', 'verify', '--confirm-host', 'localhost'], ['plan', 'apply', 'verify']),
    ).toMatchObject({ command: 'verify', confirmHost: 'localhost' });
    expect(parseOperatorArguments(['--', '--confirm-host', 'localhost'], ['plan', 'apply', 'verify']).command).toBe(
      'plan',
    );
    expect(() => parseOperatorArguments(['--', '--', 'verify', '--confirm-host', 'localhost'], ['plan'])).toThrow(
      'INVALID_ARGUMENTS',
    );
  });
  it('refuses a plan hash outside apply and apply without one, before connecting', async () => {
    const environment = { AUTH_OPERATOR_DATABASE_URL: 'postgres://operator:synthetic@127.0.0.1:1/example' };
    for (const command of ['plan', 'verify'])
      await expect(
        runAuthFence([command, '--confirm-host', '127.0.0.1', '--plan-sha256', 'a'.repeat(64)], environment),
      ).rejects.toThrow('INVALID_ARGUMENTS');
    await expect(runAuthFence(['apply', '--confirm-host', '127.0.0.1'], environment)).rejects.toThrow(
      'PLAN_SHA256_REQUIRED',
    );
    await expect(runAuthFence(['grant', '--confirm-host', '127.0.0.1'], environment)).rejects.toThrow(
      'INVALID_ARGUMENTS',
    );
  });
  it('never verifies through DATABASE_URL', async () => {
    await expect(
      runAuthFence(['verify', '--confirm-host', '127.0.0.1'], { DATABASE_URL: 'postgres://web:synthetic@127.0.0.1/x' }),
    ).rejects.toBeInstanceOf(ExplicitConnectionConfigurationError);
  });
  it('prints only fixed refusal codes, never driver text', () => {
    expect(authFenceRefusalCode(new Error('IDENTITY_WRITE_PATH'))).toBe('IDENTITY_WRITE_PATH');
    expect(authFenceRefusalCode(new ExplicitConnectionConfigurationError())).toBe('CONNECTION_CONFIGURATION_REJECTED');
    expect(authFenceRefusalCode(Object.assign(new Error('permission denied for table users'), { code: '42501' }))).toBe(
      'SQLSTATE_42501',
    );
    expect(authFenceRefusalCode(new Error('password authentication failed for user "operator"'))).toBe(
      'UNEXPECTED_ERROR',
    );
    expect(authFenceRefusalCode(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(
      'UNEXPECTED_ERROR',
    );
    expect(authFenceRefusalCode('postgres://operator:secret@db.example/x')).toBe('UNEXPECTED_ERROR');
  });
});

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
