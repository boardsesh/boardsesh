import { readdirSync } from 'node:fs';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vite-plus/test';
import {
  BACKEND_ONLY_PARTNER_TABLES,
  fencePlan,
  protectedIdentityTable,
  WEB_WRITABLE_AUTH_SCHEMA_TABLES,
} from '../catalog';
import { operatorConnectionOptions, parseOperatorArguments } from '../operator';
import { assertAuthorityActivationGates, AUTHORITY_ACTIVATION_BLOCKERS } from '../../auth-authority';
import { authFenceRefusalCode, runAuthFence } from '../../auth-fence';
import { ExplicitConnectionConfigurationError } from '../../../auth/email-audit/connection';

const FENCE_COMMANDS = ['plan', 'apply', 'verify'];

describe('backend-owned partner state', () => {
  it('denies every direct web read/write, including sealed webhook credentials and proof hashes', () => {
    const plan = fencePlan({
      schemas: ['public'],
      owners: ['boardsesh_owner'],
      routines: [],
      relations: BACKEND_ONLY_PARTNER_TABLES.map((name) => ({
        schema: 'public',
        name,
        kind: 'r',
        columns: ['id', 'secret'],
      })),
    });
    expect(BACKEND_ONLY_PARTNER_TABLES).toEqual(
      expect.arrayContaining([
        'partner_developer_emails',
        'app_workouts',
        'app_workout_requests',
        'oauth_client_webhooks',
        'partner_webhook_outbox',
        'webhook_deliveries',
      ]),
    );
    for (const name of BACKEND_ONLY_PARTNER_TABLES) {
      expect(protectedIdentityTable(name)).toBe(true);
      expect(plan.sql).toContain(`REVOKE ALL ON TABLE "public"."${name}" FROM PUBLIC, "boardsesh_web";`);
      expect(plan.sql).not.toContain(`GRANT SELECT ON TABLE "public"."${name}"`);
      expect(plan.sql).not.toContain(`GRANT INSERT, UPDATE, DELETE ON TABLE "public"."${name}"`);
      expect(plan.rollbackSql).not.toContain(`GRANT INSERT, UPDATE, DELETE ON TABLE "public"."${name}"`);
    }
  });

  it('keeps a partner audit sequence closed even in the emergency rollback plan', () => {
    const plan = fencePlan({
      schemas: ['public'],
      owners: ['boardsesh_owner'],
      routines: [],
      relations: [
        {
          schema: 'public',
          name: 'partner_app_cap_audit_id_seq',
          kind: 'S',
          columns: [],
          sequenceOwner: 'partner_app_cap_audit',
        },
      ],
    });
    expect(plan.sql).toContain('REVOKE ALL ON SEQUENCE "public"."partner_app_cap_audit_id_seq"');
    expect(plan.sql).not.toContain('GRANT USAGE ON SEQUENCE');
    expect(plan.rollbackSql).not.toContain('GRANT USAGE ON SEQUENCE');
  });
});

describe('auth-fence command line', () => {
  it('defaults to the read-only plan and accepts verify', () => {
    expect(parseOperatorArguments(['--confirm-host', 'localhost'], FENCE_COMMANDS, [], ['apply']).command).toBe('plan');
    expect(
      parseOperatorArguments(['verify', '--confirm-host', 'localhost'], FENCE_COMMANDS, [], ['apply']).command,
    ).toBe('verify');
  });
  it('accepts the argument boundary `vp run auth:fence -- …` forwards, once', () => {
    expect(
      parseOperatorArguments(['--', 'verify', '--confirm-host', 'localhost'], FENCE_COMMANDS, [], ['apply']),
    ).toMatchObject({ command: 'verify', confirmHost: 'localhost' });
    expect(parseOperatorArguments(['--', '--confirm-host', 'localhost'], FENCE_COMMANDS, [], ['apply']).command).toBe(
      'plan',
    );
    expect(() =>
      parseOperatorArguments(['--', '--', 'verify', '--confirm-host', 'localhost'], ['plan'], [], []),
    ).toThrow('INVALID_ARGUMENTS');
  });
  it('never defaults to a write command, with or without the forwarded `--`', () => {
    for (const unnamed of [
      ['--confirm-host', 'localhost'],
      ['--', '--confirm-host', 'localhost'],
    ])
      expect(() => parseOperatorArguments(unnamed, ['import'], [], ['import'])).toThrow('WRITE_COMMAND_REQUIRED');
    expect(
      parseOperatorArguments(['--', 'import', '--confirm-host', 'localhost'], ['import'], [], ['import']),
    ).toMatchObject({ command: 'import' });
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

describe('operator tools sharing the parser', () => {
  it('declare their write modes, so a reorder can never make one the default', async () => {
    // auth-authority and auth-revoke-sessions pass these exact write sets.
    expect(() => parseOperatorArguments(['--confirm-host', 'h'], ['prepare', 'status'], [], ['prepare'])).toThrow(
      'WRITE_COMMAND_REQUIRED',
    );
    expect(() => parseOperatorArguments(['--confirm-host', 'h'], ['apply', 'plan'], [], ['apply'])).toThrow(
      'WRITE_COMMAND_REQUIRED',
    );
    // The fence's apply still needs its verb and its hash, before any connection.
    await expect(
      runAuthFence(['--', '--confirm-host', '127.0.0.1', '--plan-sha256', 'a'.repeat(64)], {
        AUTH_OPERATOR_DATABASE_URL: 'postgres://operator:synthetic@127.0.0.1:1/example',
      }),
    ).rejects.toThrow('INVALID_ARGUMENTS');
  });
});

describe('identity table coverage of packages/db/src/schema/auth', () => {
  // Independent of the fence predicate's own patterns: enumerate what the
  // schema folder declares, then require each table to be fenced or exempted.
  it('fences every auth-schema table unless it is a reviewed web-writable exemption', async () => {
    const folder = new URL('../../../../../db/src/schema/auth/', import.meta.url);
    const tables = new Set<string>();
    for (const file of readdirSync(folder).filter((name) => name.endsWith('.ts'))) {
      const module = (await import(new URL(file, folder).href)) as Record<string, unknown>;
      for (const value of Object.values(module)) if (is(value, PgTable)) tables.add(getTableName(value));
    }
    // Positive control: the folder walk found the tables it must.
    expect([...tables]).toEqual(expect.arrayContaining(['users', 'user_credentials', 'auth_session', 'user_profiles']));
    const unfenced = [...tables].filter(
      (name) => !protectedIdentityTable(name) && !WEB_WRITABLE_AUTH_SCHEMA_TABLES[name],
    );
    expect(unfenced).toEqual([]);
    for (const [name, reason] of Object.entries(WEB_WRITABLE_AUTH_SCHEMA_TABLES)) {
      expect(tables.has(name), `${name} is no longer declared under schema/auth`).toBe(true);
      expect(protectedIdentityTable(name), `${name} is both fenced and exempt`).toBe(false);
      expect(reason.trim().length).toBeGreaterThan(20);
      expect(reason).not.toContain('\n');
    }
  });
  it('fences the board-account tables the web only reads', () => {
    for (const name of ['aurora_credentials', 'user_board_mappings'])
      expect(protectedIdentityTable(name), name).toBe(true);
  });
});

describe('authority operator safety', () => {
  it('defaults to read-only status and requires explicit host and dedicated URL', () => {
    expect(
      parseOperatorArguments(['--confirm-host', 'localhost'], ['status', 'prepare', 'activate'], [], ['prepare'])
        .command,
    ).toBe('status');
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
        [],
        ['prepare', 'activate'],
      ),
    ).toThrow();
    expect(() => assertAuthorityActivationGates()).toThrow('ACTIVATION_CODE_GATES_OPEN');
    // STAGED_WEB_PROOF_GENERATION_STAMP closed in code (#7596 B2c); only the owner's confirmation remains.
    expect(AUTHORITY_ACTIVATION_BLOCKERS).toEqual([
      'GARMIN_OFFLINE_TICK_QUEUE_PRESERVATION',
      'HISTORICAL_WEB_ISSUER_RETIREMENT',
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
        { schema: 'public', name: 'gyms_id_seq', kind: 'S', columns: [], sequenceOwner: 'gyms' },
        {
          schema: 'public',
          name: 'aurora_credentials_id_seq',
          kind: 'S',
          columns: [],
          sequenceOwner: 'aurora_credentials',
        },
      ],
    });
    expect(protectedIdentityTable('auth_future_identity')).toBe(true);
    expect(plan.sql).toContain('GRANT SELECT ON TABLE "public"."auth_subject_cutoffs"');
    expect(plan.sql).not.toContain('GRANT SELECT ON TABLE "public"."auth_session"');
    expect(plan.sql).not.toContain('GRANT INSERT, UPDATE, DELETE ON TABLE "public"."auth_future_identity"');
    expect(plan.sql).toContain('GRANT INSERT, UPDATE, DELETE ON TABLE "public"."gyms"');
    expect(plan.sql).toContain('GRANT USAGE ON SEQUENCE "public"."gyms_id_seq"');
    expect(plan.sql).toContain('REVOKE ALL ON SEQUENCE "public"."aurora_credentials_id_seq"');
    expect(plan.sql).not.toContain('GRANT USAGE ON SEQUENCE "public"."aurora_credentials_id_seq"');
    expect(plan.rollbackSql).toContain('GRANT USAGE ON SEQUENCE "public"."aurora_credentials_id_seq"');
    expect(plan.sql).toContain('ALTER DEFAULT PRIVILEGES');
    expect(plan.rollbackSql).toContain('GRANT INSERT, UPDATE, DELETE ON TABLE "public"."auth_subject_cutoffs"');
    expect(plan.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
