import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  captureFixedSystemOwnerOrderMode,
  lockCooperativeFixedSystemOwnerTransaction,
  lockFixedSystemOwnerTransaction,
  lockSharedFixedSystemOwnerTransaction,
  FixedSystemOwnerOrderError,
  type FixedSystemOwnerTransaction,
} from '../fixed-system-owner-order';

function transactionReturning(rows: unknown) {
  const statements: SQL[] = [];
  const transaction = {
    rollback: () => {
      throw new Error('The caller owns rollback.');
    },
    execute: async (query: SQL) => {
      statements.push(query);
      return rows;
    },
  } as unknown as FixedSystemOwnerTransaction;
  return { transaction, statements };
}

function hasCode(code: FixedSystemOwnerOrderError['code']) {
  return (error: unknown) => error instanceof FixedSystemOwnerOrderError && error.code === code;
}

void describe('fixed system-owner staging configuration', () => {
  void it('keeps absent, empty and explicit legacy configuration off', () => {
    for (const mode of [undefined, '', 'legacy']) {
      assert.equal(captureFixedSystemOwnerOrderMode({ CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE: mode }), 'legacy');
    }
    assert.equal(captureFixedSystemOwnerOrderMode({}), 'legacy');
  });

  void it('accepts only the exact cooperative staging selector', () => {
    assert.equal(
      captureFixedSystemOwnerOrderMode({ CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE: 'cooperative-staging' }),
      'cooperative-staging',
    );
    for (const mode of ['true', 'on', 'COOPERATIVE-STAGING', ' cooperative-staging', 'legacy ', 'reserved-staging']) {
      assert.throws(
        () => captureFixedSystemOwnerOrderMode({ CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE: mode }),
        hasCode('invalid_mode'),
      );
    }
  });
});

void describe('borrowed fixed system-owner transaction', () => {
  void it('performs no SQL for legacy content adoption', async () => {
    const { transaction, statements } = transactionReturning([{ acquired: false }]);
    await lockCooperativeFixedSystemOwnerTransaction(transaction, 'legacy');
    assert.equal(statements.length, 0);
  });

  void it('rejects an unknown runtime mode before SQL', async () => {
    const { transaction, statements } = transactionReturning([{ acquired: true }]);
    await assert.rejects(
      lockCooperativeFixedSystemOwnerTransaction(transaction, 'typo' as 'cooperative-staging'),
      hasCode('invalid_mode'),
    );
    assert.equal(statements.length, 0);
  });

  void it('uses one nonblocking catalog-qualified acquisition without timeout or transaction control', async () => {
    const { transaction, statements } = transactionReturning([{ acquired: true }]);
    await lockFixedSystemOwnerTransaction(transaction);
    assert.equal(statements.length, 1);
    const query = new PgDialect().sqlToQuery(statements[0]);
    assert.match(query.sql, /^SELECT pg_catalog\.pg_try_advisory_xact_lock\(/);
    assert.doesNotMatch(query.sql, /\b(?:SET|BEGIN|COMMIT|ROLLBACK|pg_advisory_xact_lock)\b/i);
    assert.equal(query.params.length, 2);
    assert.ok(query.params.every((parameter) => typeof parameter === 'number' && Number.isSafeInteger(parameter)));
  });

  void it('rejects contention without retrying or owning rollback', async () => {
    const { transaction, statements } = transactionReturning([{ acquired: false }]);
    await assert.rejects(lockFixedSystemOwnerTransaction(transaction), hasCode('busy'));
    assert.equal(statements.length, 1);
  });

  void it('shares the key for cooperative content and reports contention as busy', async () => {
    const { transaction, statements } = transactionReturning([{ acquired: false }]);
    await assert.rejects(
      lockCooperativeFixedSystemOwnerTransaction(transaction, 'cooperative-staging'),
      hasCode('busy'),
    );
    assert.equal(statements.length, 1);
    assert.match(
      new PgDialect().sqlToQuery(statements[0]).sql,
      /^SELECT pg_catalog\.pg_try_advisory_xact_lock_shared\(/,
    );
  });

  void it('shares the key for the unconditional shared helper', async () => {
    const { transaction, statements } = transactionReturning([{ acquired: true }]);
    await lockSharedFixedSystemOwnerTransaction(transaction);
    assert.equal(statements.length, 1);
    assert.match(
      new PgDialect().sqlToQuery(statements[0]).sql,
      /^SELECT pg_catalog\.pg_try_advisory_xact_lock_shared\(/,
    );
  });

  void it('rejects missing and non-boolean acquisition records', async () => {
    for (const rows of [
      [],
      null,
      { rows: [{ acquired: true }] },
      [null],
      [{}],
      [{ acquired: null }],
      [{ acquired: 'true' }],
      [{ acquired: 1 }],
      [{ acquired: true }, { acquired: true }],
    ]) {
      const { transaction, statements } = transactionReturning(rows);
      await assert.rejects(lockFixedSystemOwnerTransaction(transaction), hasCode('invalid_result'));
      assert.equal(statements.length, 1);
    }
  });

  void it('rejects a root database or malformed transaction before SQL', async () => {
    let executed = false;
    const rootDatabase = {
      execute: async () => {
        executed = true;
        return [{ acquired: true }];
      },
    };
    for (const candidate of [rootDatabase, {}, null, undefined]) {
      await assert.rejects(
        lockFixedSystemOwnerTransaction(candidate as unknown as FixedSystemOwnerTransaction),
        hasCode('invalid_transaction'),
      );
    }
    assert.equal(executed, false);
  });

  void it('preserves driver failures for the caller without retrying', async () => {
    const failure = new Error('fixture driver unavailable');
    let attempts = 0;
    const transaction = {
      rollback: () => undefined,
      execute: async () => {
        attempts += 1;
        throw failure;
      },
    } as unknown as FixedSystemOwnerTransaction;
    await assert.rejects(lockFixedSystemOwnerTransaction(transaction), (error: unknown) => error === failure);
    assert.equal(attempts, 1);
  });
});
