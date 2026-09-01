/// <reference types="node" />

import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_SNAPSHOT_TABLES } from '../packages/db/src/catalog-snapshot';
import {
  MIGRATION_OWNER_ROLE,
  PRODUCTION_MANAGED_SCHEMAS,
  PRODUCTION_TASK_RELATION_GRANTS,
  PRODUCTION_TASK_ROLES,
} from './lib/production-db-task-role-contract.mjs';
import {
  ALLOWED_DATABASE_PRIVILEGES,
  ALLOWED_RELATION_PRIVILEGES,
  ALLOWED_SCHEMA_PRIVILEGES,
  assertContractSqlSafety,
  connectionLimitSql,
  privilegeListSql,
  quoteIdentifier,
} from './lib/production-db-task-role-sql.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const temporaryDirectory of temporaryDirectories.splice(0)) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

describe('production database task-role contract', () => {
  it('pins the exact six activation identities and isolated credentials', () => {
    expect(
      PRODUCTION_TASK_ROLES.map(({ name, applicationName, githubSecret, connectionLimit }) => ({
        name,
        applicationName,
        githubSecret,
        connectionLimit,
      })),
    ).toEqual([
      {
        name: 'boardsesh_migrator',
        applicationName: 'boardsesh-ci-migrate',
        githubSecret: 'MIGRATION_DATABASE_DIRECT_URL',
        connectionLimit: 2,
      },
      {
        name: 'boardsesh_snapshot_exporter',
        applicationName: 'boardsesh-ci-snapshot-export',
        githubSecret: 'SNAPSHOT_DATABASE_DIRECT_URL',
        connectionLimit: 10,
      },
      {
        name: 'boardsesh_climb_grades_refresh',
        applicationName: 'boardsesh-ci-climb-grades',
        githubSecret: 'CLIMB_GRADES_DATABASE_DIRECT_URL',
        connectionLimit: 2,
      },
      {
        name: 'boardsesh_content_model_refresh',
        applicationName: 'boardsesh-ci-content-model',
        githubSecret: 'CONTENT_MODEL_DATABASE_DIRECT_URL',
        connectionLimit: 2,
      },
      {
        name: 'boardsesh_hold_features_refresh',
        applicationName: 'boardsesh-ci-hold-features',
        githubSecret: 'HOLD_FEATURES_DATABASE_DIRECT_URL',
        connectionLimit: 2,
      },
      {
        name: 'boardsesh_recommendations_refresh',
        applicationName: 'boardsesh-ci-recommendations',
        githubSecret: 'RECOMMENDATIONS_DATABASE_DIRECT_URL',
        connectionLimit: 2,
      },
    ]);

    expect(new Set(PRODUCTION_TASK_ROLES.map(({ name }) => name)).size).toBe(6);
    expect(new Set(PRODUCTION_TASK_ROLES.map(({ applicationName }) => applicationName)).size).toBe(6);
    expect(new Set(PRODUCTION_TASK_ROLES.map(({ githubSecret }) => githubSecret)).size).toBe(6);
    expect(PRODUCTION_TASK_ROLES.find(({ name }) => name === 'boardsesh_migrator')?.setOnlyRole).toBe(
      MIGRATION_OWNER_ROLE,
    );
    expect(PRODUCTION_TASK_ROLES.find(({ name }) => name === 'boardsesh_snapshot_exporter')?.readOnly).toBe(true);
    expect(PRODUCTION_MANAGED_SCHEMAS).toEqual(['public', 'drizzle']);
    expect(PRODUCTION_TASK_ROLES.find(({ name }) => name === 'boardsesh_migrator')).toMatchObject({
      databasePrivileges: ['CONNECT'],
      schemaPrivileges: [],
    });
    expect(PRODUCTION_TASK_ROLES.find(({ name }) => name === 'boardsesh_climb_grades_refresh')).toMatchObject({
      databasePrivileges: ['CONNECT', 'TEMPORARY'],
      schemaPrivileges: ['USAGE'],
    });
  });

  it('pins the workflow-derived relation privileges without duplicates', () => {
    const grantKeys = PRODUCTION_TASK_RELATION_GRANTS.map(
      ({ role, relation, privileges }) => `${role}|${relation}|${privileges.join(',')}`,
    );
    expect(grantKeys).toEqual([
      'boardsesh_climb_grades_refresh|board_climb_aliases|SELECT',
      'boardsesh_climb_grades_refresh|board_climb_embeddings|SELECT',
      'boardsesh_climb_grades_refresh|board_climb_grades|DELETE,INSERT,SELECT,UPDATE',
      'boardsesh_climb_grades_refresh|board_climb_stats|SELECT',
      'boardsesh_climb_grades_refresh|board_climb_stats_history|SELECT',
      'boardsesh_climb_grades_refresh|board_climbs|SELECT',
      'boardsesh_climb_grades_refresh|board_grade_coefficients|INSERT,SELECT,UPDATE',
      'boardsesh_climb_grades_refresh|boardsesh_ticks|SELECT',
      'boardsesh_climb_grades_refresh|user_boards|SELECT',
      'boardsesh_content_model_refresh|board_climb_embeddings|INSERT,SELECT,UPDATE',
      'boardsesh_content_model_refresh|board_climb_holds|SELECT',
      'boardsesh_content_model_refresh|board_climb_similar|DELETE,INSERT,SELECT',
      'boardsesh_content_model_refresh|board_climb_stats|SELECT',
      'boardsesh_content_model_refresh|board_climbs|SELECT',
      'boardsesh_content_model_refresh|board_hold_features|SELECT',
      'boardsesh_content_model_refresh|board_placements|SELECT',
      'boardsesh_hold_features_refresh|board_climb_holds|SELECT',
      'boardsesh_hold_features_refresh|board_climb_stats|SELECT',
      'boardsesh_hold_features_refresh|board_climbs|SELECT',
      'boardsesh_hold_features_refresh|board_hold_features|INSERT,SELECT,UPDATE',
      'boardsesh_hold_features_refresh|board_holes|SELECT',
      'boardsesh_hold_features_refresh|board_placements|SELECT',
      'boardsesh_hold_features_refresh|board_product_sizes_layouts_sets|SELECT',
      'boardsesh_hold_features_refresh|board_sets|SELECT',
      'boardsesh_hold_features_refresh|user_hold_classifications|INSERT,SELECT,UPDATE',
      'boardsesh_hold_features_refresh|users|INSERT',
      'boardsesh_recommendations_refresh|board_climb_send_stats|DELETE,INSERT,SELECT',
      'boardsesh_recommendations_refresh|board_climb_stats|SELECT',
      'boardsesh_recommendations_refresh|board_climb_stats_history|INSERT',
      'boardsesh_recommendations_refresh|board_climbs|SELECT',
      'boardsesh_recommendations_refresh|board_setter_stats|INSERT,SELECT,UPDATE',
      'boardsesh_recommendations_refresh|board_shared_syncs|INSERT,SELECT,UPDATE',
      'boardsesh_recommendations_refresh|playlist_climbs|DELETE,INSERT,SELECT',
      'boardsesh_recommendations_refresh|playlist_ownership|INSERT,SELECT',
      'boardsesh_recommendations_refresh|playlists|INSERT,SELECT,UPDATE',
      'boardsesh_recommendations_refresh|sync_deletions|INSERT',
      'boardsesh_recommendations_refresh|users|INSERT',
      'boardsesh_snapshot_exporter|board_attempts|SELECT',
      'boardsesh_snapshot_exporter|board_beta_links|SELECT',
      'boardsesh_snapshot_exporter|board_climb_aliases|SELECT',
      'boardsesh_snapshot_exporter|board_climb_grades|SELECT',
      'boardsesh_snapshot_exporter|board_climb_stats|SELECT',
      'boardsesh_snapshot_exporter|board_climbs|SELECT',
      'boardsesh_snapshot_exporter|board_difficulty_grades|SELECT',
      'boardsesh_snapshot_exporter|board_holes|SELECT',
      'boardsesh_snapshot_exporter|board_kits|SELECT',
      'boardsesh_snapshot_exporter|board_layouts|SELECT',
      'boardsesh_snapshot_exporter|board_leds|SELECT',
      'boardsesh_snapshot_exporter|board_placement_roles|SELECT',
      'boardsesh_snapshot_exporter|board_placements|SELECT',
      'boardsesh_snapshot_exporter|board_product_sizes|SELECT',
      'boardsesh_snapshot_exporter|board_product_sizes_layouts_sets|SELECT',
      'boardsesh_snapshot_exporter|board_products|SELECT',
      'boardsesh_snapshot_exporter|board_sets|SELECT',
    ]);
    expect(new Set(PRODUCTION_TASK_RELATION_GRANTS.map(({ role, relation }) => `${role}|${relation}`)).size).toBe(
      PRODUCTION_TASK_RELATION_GRANTS.length,
    );
  });

  it('keeps snapshot SELECT grants synchronized with the catalog exporter', () => {
    const snapshotRelations = new Set(
      PRODUCTION_TASK_RELATION_GRANTS.filter(({ role }) => role === 'boardsesh_snapshot_exporter').map(
        ({ relation }) => relation,
      ),
    );
    expect(snapshotRelations).toEqual(
      new Set([
        'board_climbs',
        'board_climb_stats',
        'board_climb_grades',
        ...CATALOG_SNAPSHOT_TABLES.map(({ name }) => name),
      ]),
    );
  });

  it('keeps every least-privilege grant tied to checked-in query evidence', () => {
    for (const roleContract of PRODUCTION_TASK_ROLES) {
      expect(roleContract.evidence.length).toBeGreaterThan(0);
      for (const evidencePath of roleContract.evidence) expect(existsSync(evidencePath)).toBe(true);
    }
    for (const grantContract of PRODUCTION_TASK_RELATION_GRANTS) {
      for (const evidencePath of grantContract.evidence.split(' + ')) expect(existsSync(evidencePath)).toBe(true);
    }
  });

  it('proves application type values and defaults need no extra task-role grants', () => {
    const latestSnapshotName = readdirSync('packages/db/drizzle/meta')
      .filter((fileName) => /^\d+_snapshot\.json$/.test(fileName))
      .sort((left, right) => left.localeCompare(right))
      .at(-1);
    expect(latestSnapshotName).toBeDefined();
    const snapshot = JSON.parse(readFileSync(join('packages/db/drizzle/meta', latestSnapshotName!), 'utf8')) as {
      enums: Record<string, { name: string }>;
      tables: Record<
        string,
        { columns: Record<string, { name: string; type: string; default?: string | number | boolean }> }
      >;
    };
    const enumNames = new Set(Object.values(snapshot.enums).map(({ name }) => name));
    const taskTypeValueDependencies: string[] = [];
    const taskDefaultRoutineNames = new Set<string>();
    for (const { role, relation } of PRODUCTION_TASK_RELATION_GRANTS) {
      const table = snapshot.tables[`public.${relation}`];
      expect(table, `latest schema snapshot is missing public.${relation}`).toBeDefined();
      for (const column of Object.values(table.columns)) {
        if (enumNames.has(column.type)) {
          taskTypeValueDependencies.push(`${role}|${relation}|${column.name}:${column.type}`);
        }
        if (typeof column.default === 'string') {
          const routineMatch = /^([a-z_][a-z0-9_.]*)\(/i.exec(column.default);
          if (routineMatch) taskDefaultRoutineNames.add(routineMatch[1]);
        }
      }
    }
    expect(taskTypeValueDependencies.sort((left, right) => left.localeCompare(right))).toEqual([
      'boardsesh_climb_grades_refresh|boardsesh_ticks|aurora_type:aurora_table_type',
      'boardsesh_climb_grades_refresh|boardsesh_ticks|kilter_type:kilter_table_type',
      'boardsesh_climb_grades_refresh|boardsesh_ticks|origin:tick_origin',
      'boardsesh_climb_grades_refresh|boardsesh_ticks|status:tick_status',
      'boardsesh_hold_features_refresh|user_hold_classifications|hold_type:hold_type',
    ]);
    expect(taskDefaultRoutineNames).toEqual(new Set(['now']));
  });

  it('generates a protected off-repository credential bundle without logging secrets', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-role-contract-'));
    temporaryDirectories.push(temporaryDirectory);
    const credentialsFile = join(temporaryDirectory, 'roles.json');
    const result = spawnSync(process.execPath, ['scripts/production-db-task-roles.mjs', 'generate'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ROLE_CREDENTIALS_FILE: credentialsFile,
        POSTGRES_FORWARDER_HOST: 'boardsesh-db-forwarder.test.tailnet.ts.net',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(credentialsFile).mode & 0o077).toBe(0);

    const credentials = JSON.parse(readFileSync(credentialsFile, 'utf8')) as {
      roles: Record<string, { password: string; databaseUrl: string }>;
    };
    expect(Object.keys(credentials.roles)).toHaveLength(6);
    for (const credential of Object.values(credentials.roles)) {
      expect(credential.password).toMatch(/^[a-f0-9]{64}$/);
      expect(`${result.stdout}${result.stderr}`).not.toContain(credential.password);
      expect(`${result.stdout}${result.stderr}`).not.toContain(credential.databaseUrl);
    }
  });

  it('refuses repository credential files and secret argv', () => {
    const repositoryCredentialPath = resolve('.boardsesh-production-task-roles.json');
    const repositoryFileResult = spawnSync(process.execPath, ['scripts/production-db-task-roles.mjs', 'generate'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ROLE_CREDENTIALS_FILE: repositoryCredentialPath,
        POSTGRES_FORWARDER_HOST: 'boardsesh-db-forwarder.test.tailnet.ts.net',
      },
    });
    expect(repositoryFileResult.status).toBe(1);
    expect(repositoryFileResult.stderr).toContain('must be outside the repository');
    expect(existsSync(repositoryCredentialPath)).toBe(false);

    const sentinelSecret = 'must-not-echo-this-secret';
    const argvResult = spawnSync(
      process.execPath,
      ['scripts/production-db-task-roles.mjs', 'generate', sentinelSecret],
      { encoding: 'utf8' },
    );
    expect(argvResult.status).toBe(1);
    expect(`${argvResult.stdout}${argvResult.stderr}`).not.toContain(sentinelSecret);
  });

  it('resolves credential parents and rejects unsafe parent or linked-file boundaries', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-role-path-boundary-'));
    temporaryDirectories.push(temporaryDirectory);

    const repositoryLink = join(temporaryDirectory, 'repository-link');
    symlinkSync(resolve('.'), repositoryLink, 'dir');
    const repositoryLinkResult = spawnSync(process.execPath, ['scripts/production-db-task-roles.mjs', 'generate'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ROLE_CREDENTIALS_FILE: join(repositoryLink, 'roles.json'),
        POSTGRES_FORWARDER_HOST: 'boardsesh-db-forwarder.test.tailnet.ts.net',
      },
    });
    expect(repositoryLinkResult.status).toBe(1);
    expect(repositoryLinkResult.stderr).toContain('must be outside the repository');

    chmodSync(temporaryDirectory, 0o755);
    const permissiveParentResult = spawnSync(process.execPath, ['scripts/production-db-task-roles.mjs', 'generate'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ROLE_CREDENTIALS_FILE: join(temporaryDirectory, 'permissive-parent.json'),
        POSTGRES_FORWARDER_HOST: 'boardsesh-db-forwarder.test.tailnet.ts.net',
      },
    });
    expect(permissiveParentResult.status).toBe(1);
    expect(permissiveParentResult.stderr).toContain('parent must not be accessible by group or other users');
    chmodSync(temporaryDirectory, 0o700);

    const linkedTarget = join(temporaryDirectory, 'linked-target.json');
    writeFileSync(linkedTarget, '{}\n', { mode: 0o600 });
    const symbolicCredentialFile = join(temporaryDirectory, 'symbolic-roles.json');
    symlinkSync(linkedTarget, symbolicCredentialFile);
    const symbolicFileResult = spawnSync(process.execPath, ['scripts/production-db-task-roles.mjs', 'apply'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        APPLY_TASK_ROLE_CHANGES: 'APPLY_EXACT_SIX_TASK_ROLES',
        ROLE_CREDENTIALS_FILE: symbolicCredentialFile,
      },
    });
    expect(symbolicFileResult.status).toBe(1);
    expect(symbolicFileResult.stderr).toContain('existing regular non-symlink file');

    const hardLinkedCredentialFile = join(temporaryDirectory, 'hard-linked-roles.json');
    linkSync(linkedTarget, hardLinkedCredentialFile);
    const hardLinkResult = spawnSync(process.execPath, ['scripts/production-db-task-roles.mjs', 'apply'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        APPLY_TASK_ROLE_CHANGES: 'APPLY_EXACT_SIX_TASK_ROLES',
        ROLE_CREDENTIALS_FILE: hardLinkedCredentialFile,
      },
    });
    expect(hardLinkResult.status).toBe(1);
    expect(hardLinkResult.stderr).toContain('must be one regular, non-linked file');
  });

  it('rejects OTA, public, and unconfirmed loopback administrator targets before connecting', () => {
    const wrongServiceResult = spawnSync(process.execPath, ['scripts/production-db-task-roles.mjs', 'plan'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ADMIN_DATABASE_URL: 'postgresql://postgres:sentinel@postgres.railway.internal:5432/railway?sslmode=require',
        POSTGRES_FORWARDER_HOST: 'boardsesh-db-forwarder.test.tailnet.ts.net',
      },
    });
    expect(wrongServiceResult.status).toBe(1);
    expect(wrongServiceResult.stderr).toContain('must use the exact PostGIS forwarder host:5432');
    expect(`${wrongServiceResult.stdout}${wrongServiceResult.stderr}`).not.toContain('sentinel');

    const loopbackResult = spawnSync(process.execPath, ['scripts/production-db-task-roles.mjs', 'plan'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ADMIN_DATABASE_URL: 'postgresql://postgres:sentinel@127.0.0.1:1/railway',
      },
    });
    expect(loopbackResult.status).toBe(1);
    expect(loopbackResult.stderr).toContain('allowed only by the disposable-smoke confirmation');
    expect(`${loopbackResult.stdout}${loopbackResult.stderr}`).not.toContain('sentinel');
  });

  it('keeps the disposable smoke credential-free on process argv', () => {
    const smokeSource = readFileSync('scripts/production-db-task-roles-smoke.sh', 'utf8');
    expect(statSync('scripts/production-db-task-roles-smoke.sh').mode & 0o111).not.toBe(0);
    expect(smokeSource).toContain(
      'postgres:18.6-bookworm@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af',
    );
    expect(smokeSource).not.toMatch(/--env\s+PGPASSWORD/);
    expect(smokeSource).not.toMatch(/postgresql:\/\/[^"']+\$\{?[^"']*password/i);
    expect(smokeSource).toContain("ROLLBACK_TASK_ROLES='DROP_EXACT_SIX_TASK_ROLES'");
    expect(smokeSource).toContain('GRANT SELECT ON role_forbidden_probe TO PUBLIC');
    expect(smokeSource).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE boardsesh_owner GRANT EXECUTE ON ROUTINES TO PUBLIC',
    );
    expect(smokeSource).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE boardsesh_owner GRANT CREATE ON SCHEMAS TO PUBLIC',
    );
    expect(smokeSource).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE boardsesh_owner GRANT SELECT ON LARGE OBJECTS TO PUBLIC',
    );
    expect(smokeSource).toContain('GRANT SELECT ON LARGE OBJECT 918273 TO PUBLIC');
    expect(smokeSource).toContain('GRANT SET ON PARAMETER statement_timeout TO PUBLIC');
    expect(smokeSource).toContain('boardsesh-ci-migrate-rollback-race');
  });

  it('audits effective PUBLIC and owner-default boundaries without applying broad revokes', () => {
    const provisionerSource = readFileSync('scripts/production-db-task-roles.mjs', 'utf8');
    expect(provisionerSource).toContain('collectClusterWideBoundaryDifferences');
    expect(provisionerSource).toContain("pg_catalog.acldefault('d', database.datdba)");
    expect(provisionerSource).toContain('WHERE database.datallowconn');
    expect(provisionerSource).not.toContain('WHERE database.datname = ${quoteLiteral(PRODUCTION_DATABASE_NAME)}');
    expect(provisionerSource).toContain("pg_catalog.acldefault('n', namespace.nspowner)");
    expect(provisionerSource).toContain("pg_catalog.acldefault('f', procedure.proowner)");
    expect(provisionerSource).toContain("pg_catalog.acldefault('T', type_row.typowner)");
    expect(provisionerSource).toContain("pg_catalog.acldefault('n', namespace.nspowner)");
    expect(provisionerSource).toContain("pg_catalog.acldefault('L', large_object.lomowner)");
    expect(provisionerSource).toContain("('n'::\"char\", 'n'::\"char\", 'SCHEMAS'::text)");
    expect(provisionerSource).toContain("('L'::\"char\", 'L'::\"char\", 'LARGE OBJECTS'::text)");
    expect(provisionerSource).toContain('FROM pg_catalog.pg_parameter_acl AS parameter');
    expect(provisionerSource).toContain('cluster prerequisite unexpected schema');
    expect(provisionerSource).toContain("CASE WHEN relation.relkind = 'S' THEN 's'::\"char\"");
    expect(provisionerSource).toContain("('S'::\"char\", 's'::\"char\", 'SEQUENCES'::text)");
    expect(provisionerSource).toContain('AND privilege.grantee = 0');
    expect(provisionerSource).toContain(
      'cluster-wide PUBLIC/default ACL prerequisites require separate reviewed remediation; apply never changes them',
    );
  });

  it('uses a durable two-phase rollback fence before session drain and drop', () => {
    const provisionerSource = readFileSync('scripts/production-db-task-roles.mjs', 'utf8');
    const rollbackStart = provisionerSource.indexOf('async function rollbackContract');
    const rollbackSource = provisionerSource.slice(rollbackStart);
    const noLoginIndex = rollbackSource.indexOf('ALTER ROLE ${quoteIdentifier(roleContract.name)} NOLOGIN');
    const sessionProofIndex = rollbackSource.indexOf('collectManagedSessionRows(sqlClient)');
    const dropIndex = rollbackSource.indexOf('DROP ROLE ${quoteIdentifier(roleContract.name)}');
    expect(noLoginIndex).toBeGreaterThan(0);
    expect(sessionProofIndex).toBeGreaterThan(noLoginIndex);
    expect(dropIndex).toBeGreaterThan(sessionProofIndex);
    expect(rollbackSource).toContain("managedRoleLoginState: 'nologin'");
    expect(rollbackSource).toContain('roles remain fenced for recovery');
    expect(rollbackSource).toContain('pg_catalog.pg_advisory_unlock');
  });

  it('reads and writes credentials only through verified no-follow descriptors', () => {
    const provisionerSource = readFileSync('scripts/production-db-task-roles.mjs', 'utf8');
    expect(provisionerSource).toContain('fileConstants.O_NOFOLLOW');
    expect(provisionerSource).toContain('fileConstants.O_EXCL');
    expect(provisionerSource).toContain("readFileSync(fileDescriptor, 'utf8')");
    expect(provisionerSource).toContain('assertCredentialsParentStable(fileTarget)');
    expect(provisionerSource).toContain('fileStats.nlink !== 1');
  });
});

describe('production task-role SQL construction', () => {
  const migratorContract = PRODUCTION_TASK_ROLES.find(({ name }) => name === 'boardsesh_migrator')!;

  const poisonedRole = (overrides: Record<string, unknown>) => [{ ...migratorContract, ...overrides }];

  const sortedKeywords = (keywords: Iterable<string>) => [...keywords].sort((left, right) => left.localeCompare(right));

  it('accepts the shipped contract and grants only the keywords it declares', () => {
    expect(() => assertContractSqlSafety(PRODUCTION_TASK_ROLES, PRODUCTION_TASK_RELATION_GRANTS)).not.toThrow();

    const declaredDatabasePrivileges = sortedKeywords(
      new Set(PRODUCTION_TASK_ROLES.flatMap(({ databasePrivileges }) => databasePrivileges)),
    );
    const declaredSchemaPrivileges = sortedKeywords(
      new Set(PRODUCTION_TASK_ROLES.flatMap(({ schemaPrivileges }) => schemaPrivileges)),
    );
    const declaredRelationPrivileges = sortedKeywords(
      new Set(PRODUCTION_TASK_RELATION_GRANTS.flatMap(({ privileges }) => privileges)),
    );
    expect(declaredDatabasePrivileges).toEqual(['CONNECT', 'TEMPORARY']);
    expect(declaredSchemaPrivileges).toEqual(['USAGE']);
    expect(declaredRelationPrivileges).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);

    // The allowlists stay exactly as wide as the contract needs; widening one is a review decision.
    expect(sortedKeywords(ALLOWED_DATABASE_PRIVILEGES)).toEqual(declaredDatabasePrivileges);
    expect(sortedKeywords(ALLOWED_SCHEMA_PRIVILEGES)).toEqual(declaredSchemaPrivileges);
    expect(sortedKeywords(ALLOWED_RELATION_PRIVILEGES)).toEqual(declaredRelationPrivileges);

    expect(privilegeListSql('database', ['CONNECT', 'TEMPORARY'], 'test')).toBe('CONNECT, TEMPORARY');
    expect(privilegeListSql('relation', ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], 'test')).toBe(
      'DELETE, INSERT, SELECT, UPDATE',
    );
  });

  it('rejects a privilege that smuggles a statement past the contract shape', () => {
    const injectedPrivilege = 'CONNECT; DROP ROLE boardsesh_owner --';
    expect(() => privilegeListSql('database', [injectedPrivilege], 'boardsesh_migrator')).toThrow(
      /unsafe database privilege/,
    );
    expect(() => assertContractSqlSafety(poisonedRole({ databasePrivileges: [injectedPrivilege] }), [])).toThrow(
      /unsafe database privilege/,
    );
    expect(() =>
      assertContractSqlSafety(poisonedRole({ schemaPrivileges: ['USAGE; DROP SCHEMA public'] }), []),
    ).toThrow(/unsafe schema privilege/);
    expect(() =>
      assertContractSqlSafety(
        [migratorContract],
        [{ role: 'boardsesh_migrator', relation: 'board_climbs', privileges: ['SELECT; DROP TABLE board_climbs --'] }],
      ),
    ).toThrow(/unsafe relation privilege/);
  });

  it('rejects whitespace, case, and separator tricks around an allowed keyword', () => {
    for (const disguisedPrivilege of [
      ' CONNECT',
      'CONNECT ',
      'CONNECT\n',
      'CONNECT\t',
      'CON NECT',
      'connect',
      'Connect',
      'CONNECT,TEMPORARY',
      'CONNECT, TEMPORARY',
      'CONNECT/*x*/',
    ]) {
      expect(() => privilegeListSql('database', [disguisedPrivilege], 'test'), disguisedPrivilege).toThrow(
        /unsafe database privilege/,
      );
    }
  });

  it('rejects unknown keywords, cross-scope keywords, and non-string privileges', () => {
    for (const unknownPrivilege of ['ALL', 'ALL PRIVILEGES', 'CREATE', 'EXECUTE', 'SUPERUSER', 'SELECT']) {
      expect(() => privilegeListSql('database', [unknownPrivilege], 'test'), unknownPrivilege).toThrow(
        /unsafe database privilege/,
      );
    }
    // USAGE is a schema privilege only; CONNECT is a database privilege only.
    expect(() => privilegeListSql('relation', ['USAGE'], 'test')).toThrow(/unsafe relation privilege/);
    expect(() => privilegeListSql('relation', ['CONNECT'], 'test')).toThrow(/unsafe relation privilege/);
    expect(() => privilegeListSql('schema', ['CREATE'], 'test')).toThrow(/unsafe schema privilege/);

    for (const nonString of [null, undefined, 7, ['CONNECT'], { toString: () => 'CONNECT' }]) {
      expect(() => privilegeListSql('database', [nonString], 'test')).toThrow(/unsafe database privilege/);
    }
    expect(() => privilegeListSql('database', 'CONNECT', 'test')).toThrow(
      /must declare database privileges as an array/,
    );
    expect(() => privilegeListSql('database', [], 'test')).toThrow(/must grant at least one database privilege/);
    expect(() => privilegeListSql('database', ['CONNECT', 'CONNECT'], 'test')).toThrow(/duplicate database privilege/);
    expect(() => privilegeListSql('cluster', ['CONNECT'], 'test')).toThrow(/unknown privilege scope/);
  });

  it('rejects a connection limit that is not a bounded non-negative integer', () => {
    expect(connectionLimitSql(2, 'test')).toBe('2');
    expect(connectionLimitSql(10, 'test')).toBe('10');
    expect(connectionLimitSql(0, 'test')).toBe('0');

    for (const unsafeLimit of [
      '2',
      '2; DROP ROLE boardsesh_owner --',
      '-1',
      2.5,
      -1,
      -0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      1000,
      null,
      undefined,
      true,
      [2],
    ]) {
      expect(() => connectionLimitSql(unsafeLimit, 'test'), String(unsafeLimit)).toThrow(/unsafe connection limit/);
      expect(() => assertContractSqlSafety(poisonedRole({ connectionLimit: unsafeLimit }), [])).toThrow(
        /unsafe connection limit/,
      );
    }
  });

  it('rejects identifiers that would break out of double quotes', () => {
    expect(quoteIdentifier('board_climbs')).toBe('"board_climbs"');
    for (const unsafeIdentifier of [
      'public"; DROP ROLE boardsesh_owner --',
      'board climbs',
      'Board_Climbs',
      '1_climbs',
      'board-climbs',
      'board.climbs',
      '',
      null,
      undefined,
    ]) {
      expect(() => quoteIdentifier(unsafeIdentifier), String(unsafeIdentifier)).toThrow(/unsafe PostgreSQL identifier/);
    }
    expect(() => assertContractSqlSafety(poisonedRole({ name: 'boardsesh_migrator"; DROP ROLE x --' }), [])).toThrow(
      /unsafe PostgreSQL identifier/,
    );
    expect(() =>
      assertContractSqlSafety(
        [migratorContract],
        [{ role: 'boardsesh_migrator', relation: 'board_climbs; DROP TABLE users', privileges: ['SELECT'] }],
      ),
    ).toThrow(/unsafe PostgreSQL identifier/);
  });

  it('refuses to run any command when the contract carries an injected privilege', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-role-injection-'));
    temporaryDirectories.push(temporaryDirectory);
    // Bare specifiers such as `postgres` resolve by walking up from the copied script.
    symlinkSync(resolve('node_modules'), join(temporaryDirectory, 'node_modules'), 'dir');
    const scriptDirectory = join(temporaryDirectory, 'scripts');
    mkdirSync(join(scriptDirectory, 'lib'), { recursive: true });
    copyFileSync('scripts/production-db-task-roles.mjs', join(scriptDirectory, 'production-db-task-roles.mjs'));
    copyFileSync(
      'scripts/lib/production-db-task-role-sql.mjs',
      join(scriptDirectory, 'lib', 'production-db-task-role-sql.mjs'),
    );

    const contractSource = readFileSync('scripts/lib/production-db-task-role-contract.mjs', 'utf8');
    const poisonedSource = contractSource.replace(
      "databasePrivileges: ['CONNECT'],",
      "databasePrivileges: ['CONNECT; DROP ROLE boardsesh_owner --'],",
    );
    expect(poisonedSource, 'contract poisoning must actually change the source').not.toBe(contractSource);
    writeFileSync(join(scriptDirectory, 'lib', 'production-db-task-role-contract.mjs'), poisonedSource);

    for (const command of ['plan', 'audit', 'apply', 'rollback']) {
      const result = spawnSync(process.execPath, [join(scriptDirectory, 'production-db-task-roles.mjs'), command], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ADMIN_DATABASE_URL: 'postgresql://postgres:sentinel@127.0.0.1:1/railway',
          ALLOW_DISPOSABLE_TASK_ROLE_SMOKE: 'ALLOW_EXACT_LOOPBACK_FIXTURE',
          APPLY_TASK_ROLE_CHANGES: 'APPLY_EXACT_SIX_TASK_ROLES',
          ROLLBACK_TASK_ROLES: 'DROP_EXACT_SIX_TASK_ROLES',
        },
      });
      expect(result.status, `${command}: ${result.stdout}${result.stderr}`).toBe(1);
      expect(result.stderr, command).toContain('unsafe database privilege');
    }
  });

  it('never interpolates a raw privilege list or connection limit into unsafe SQL', () => {
    const provisionerSource = readFileSync('scripts/production-db-task-roles.mjs', 'utf8');
    expect(provisionerSource).not.toMatch(/privileges\.join\(/);
    expect(provisionerSource).not.toContain('CONNECTION LIMIT ${roleContract.connectionLimit}');
    expect(provisionerSource).toContain(
      'assertContractSqlSafety(PRODUCTION_TASK_ROLES, PRODUCTION_TASK_RELATION_GRANTS)',
    );
    expect(provisionerSource).toContain("privilegeListSql('database'");
    expect(provisionerSource).toContain("privilegeListSql('schema'");
    expect(provisionerSource).toContain("privilegeListSql('relation'");
    expect(provisionerSource).toContain('connectionLimitSql(roleContract.connectionLimit');
  });
});
