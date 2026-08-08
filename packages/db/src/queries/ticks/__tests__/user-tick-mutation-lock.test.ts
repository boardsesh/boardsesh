import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { acquireUserTickMutationLock } from '../user-tick-mutation-lock';

const USER_TICK_MUTATION_LOCK_SEED = 0x5449434b;
const dialect = new PgDialect();

void describe('acquireUserTickMutationLock', () => {
  void test('takes exactly one transaction-scoped 64-bit key seeded on the user id', async () => {
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

    assert.equal(statements.length, 1);
    const rendered = dialect.sqlToQuery(statements[0]);
    assert.match(rendered.sql, /pg_advisory_xact_lock\(hashtextextended\(\$1, \$2::bigint\)\)/);
    assert.deepEqual(rendered.params, ['rollout-user', USER_TICK_MUTATION_LOCK_SEED]);
  });
});
