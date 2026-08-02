import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { acquireUserTickMutationLock } from '../user-tick-mutation-lock';

const USER_TICK_MUTATION_LOCK_NAMESPACE = 0x5449434b;
const dialect = new PgDialect();

void describe('acquireUserTickMutationLock', () => {
  void test('acquires the legacy key before the extended 64-bit key', async () => {
    const statements: SQL[] = [];
    const fakeDb = {
      execute: async (statement: SQL) => {
        statements.push(statement);
        return [];
      },
    };

    await acquireUserTickMutationLock(
      fakeDb as unknown as Parameters<typeof acquireUserTickMutationLock>[0],
      'rollout-user',
    );

    assert.equal(statements.length, 2);
    const renderedStatements = statements.map((statement) => dialect.sqlToQuery(statement));
    assert.match(renderedStatements[0].sql, /pg_advisory_xact_lock\(\$1, hashtext\(\$2\)\)/);
    assert.deepEqual(renderedStatements[0].params, [USER_TICK_MUTATION_LOCK_NAMESPACE, 'rollout-user']);
    assert.match(renderedStatements[1].sql, /pg_advisory_xact_lock\(hashtextextended\(\$1, \$2::bigint\)\)/);
    assert.deepEqual(renderedStatements[1].params, ['rollout-user', USER_TICK_MUTATION_LOCK_NAMESPACE]);
  });
});
