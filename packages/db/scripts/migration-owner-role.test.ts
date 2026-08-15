import assert from 'node:assert/strict';
import test from 'node:test';
import { migrationExecutionContractFromEnvironment, migrationOwnerRoleStatement } from './migration-owner-role.js';

void test('quotes a validated migration owner role', () => {
  assert.equal(migrationOwnerRoleStatement('boardsesh_owner'), 'SET ROLE "boardsesh_owner"');
});

void test('rejects SQL and non-identifier role names', () => {
  for (const roleName of ['', 'boardsesh-owner', 'boardsesh owner', 'owner"; RESET ROLE; --', '1_owner']) {
    assert.throws(() => migrationOwnerRoleStatement(roleName), /simple PostgreSQL identifier/);
  }
});

void test('keeps the owner contract optional only when subscriber allowance is absent', () => {
  assert.equal(migrationExecutionContractFromEnvironment({}), undefined);
  assert.throws(
    () =>
      migrationExecutionContractFromEnvironment({
        MIGRATION_SUBSCRIBER_ROLE: 'boardsesh_pg18_subscriber',
        MIGRATION_SUBSCRIPTION_NAME: 'boardsesh_pg18_sub',
      }),
    /require the full migration owner contract/,
  );
});

void test('requires every core and subscriber setting atomically', () => {
  assert.throws(
    () => migrationExecutionContractFromEnvironment({ MIGRATION_OWNER_ROLE: 'boardsesh_owner' }),
    /must be set together/,
  );
  assert.throws(
    () =>
      migrationExecutionContractFromEnvironment({
        MIGRATION_SUBSCRIBER_ROLE: 'boardsesh_pg18_subscriber',
      }),
    /MIGRATION_SUBSCRIBER_ROLE and MIGRATION_SUBSCRIPTION_NAME must be set together/,
  );
});

void test('returns the exact active-subscriber migration contract', () => {
  assert.deepEqual(
    migrationExecutionContractFromEnvironment({
      MIGRATION_OWNER_ROLE: 'boardsesh_owner',
      MIGRATION_LOGIN_ROLE: 'boardsesh_migrator',
      EXPECTED_MIGRATION_DATABASE: 'railway',
      MIGRATION_RUNTIME_ROLE: 'boardsesh_runtime',
      MIGRATION_RUNTIME_SCHEMAS: 'public  drizzle',
      MIGRATION_SUBSCRIBER_ROLE: 'boardsesh_pg18_subscriber',
      MIGRATION_SUBSCRIPTION_NAME: 'boardsesh_pg18_sub',
    }),
    {
      owner: {
        databaseName: 'railway',
        loginRole: 'boardsesh_migrator',
        ownerRole: 'boardsesh_owner',
        subscriberRole: 'boardsesh_pg18_subscriber',
        subscriptionName: 'boardsesh_pg18_sub',
      },
      runtimeRole: 'boardsesh_runtime',
      runtimeSchemas: ['public', 'drizzle'],
    },
  );
});

void test('rejects empty, duplicate, and malformed runtime scope before database work', () => {
  const baseEnvironment = {
    MIGRATION_OWNER_ROLE: 'boardsesh_owner',
    MIGRATION_LOGIN_ROLE: 'boardsesh_migrator',
    EXPECTED_MIGRATION_DATABASE: 'railway',
    MIGRATION_RUNTIME_ROLE: 'boardsesh_runtime',
    MIGRATION_RUNTIME_SCHEMAS: 'public drizzle',
  };
  assert.throws(
    () =>
      migrationExecutionContractFromEnvironment({
        ...baseEnvironment,
        MIGRATION_RUNTIME_SCHEMAS: '   ',
      }),
    /must list at least one schema/,
  );
  assert.throws(
    () =>
      migrationExecutionContractFromEnvironment({
        ...baseEnvironment,
        MIGRATION_RUNTIME_SCHEMAS: 'public public',
      }),
    /must not contain duplicates/,
  );
  assert.throws(
    () =>
      migrationExecutionContractFromEnvironment({
        ...baseEnvironment,
        MIGRATION_RUNTIME_ROLE: 'boardsesh-runtime',
      }),
    /MIGRATION_RUNTIME_ROLE must be a simple PostgreSQL identifier/,
  );
});
