import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Ensure the client factories have a connection string they can hand to
// postgres-js. The clients don't actually open a TCP connection until a query
// runs, so a fake URL is fine for these structural tests.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://postgres:password@localhost:5432/main';
}

void describe('postgres client', () => {
  void describe('closePool', () => {
    void it('should be a function export', async () => {
      const { closePool } = await import('../postgres');
      assert.equal(typeof closePool, 'function');
    });

    void it('should resolve without error when no pool exists', async () => {
      const { closePool } = await import('../postgres');
      await assert.doesNotReject(() => closePool());
    });

    void it('should reset db singleton so createDb creates a fresh instance', async () => {
      const { createDb, closePool } = await import('../postgres');

      const db1 = createDb();
      assert.ok(db1, 'createDb should return a db instance');

      await closePool();

      const db2 = createDb();
      assert.ok(db2, 'createDb should return a new db instance after closePool');

      await closePool();
    });
  });

  void describe('createPool configuration', () => {
    void it('should return the same pool instance on repeated calls', async () => {
      const { createPool } = await import('../postgres');
      const pool1 = createPool();
      const pool2 = createPool();
      assert.equal(pool1, pool2, 'createPool should return the same singleton');
    });
  });

  void describe('createDedicatedPool', () => {
    void it('builds a new pool with its own size on every call', async () => {
      const { createDedicatedPool, createPool } = await import('../postgres');
      const firstPool = createDedicatedPool(3);
      const secondPool = createDedicatedPool(3);
      try {
        assert.notEqual(firstPool, secondPool, 'each call must return its own pool');
        assert.notEqual(firstPool, createPool(), 'a dedicated pool is never the shared one');
        assert.equal(firstPool.options.max, 3);
      } finally {
        await Promise.all([firstPool.end(), secondPool.end()]);
      }
    });

    void it('applies its own connect timeout and startup parameters', async () => {
      const { createDedicatedPool } = await import('../postgres');
      const pool = createDedicatedPool(2, {
        connect_timeout: 2,
        connection: { statement_timeout: 1000, application_name: 'dedicated-test' },
      });
      try {
        assert.equal(pool.options.connect_timeout, 2);
        assert.equal(pool.options.connection.statement_timeout, 1000);
        assert.equal(pool.options.connection.application_name, 'dedicated-test');
      } finally {
        await pool.end();
      }
    });

    void it('wins over the same startup parameter in the URL and keeps the rest', async () => {
      const { createDedicatedPool } = await import('../postgres');
      const previousUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL =
        'postgres://postgres:password@localhost:5432/main?statement_timeout=45000&lock_timeout=5';
      const pool = createDedicatedPool(2, { connection: { statement_timeout: 1000 } });
      try {
        assert.equal(pool.options.connection.statement_timeout, 1000);
        assert.equal(pool.options.connection.lock_timeout, '5');
      } finally {
        process.env.DATABASE_URL = previousUrl;
        await pool.end();
      }
    });
  });

  void describe('per-deployment pool knobs', () => {
    // Asserts on the options postgres-js actually resolved, not on the source
    // text of postgres.ts. A source grep goes green-but-meaningless the moment
    // the value stops being a literal.
    async function poolOptionsWith(env: Record<string, string | undefined>) {
      const { createPool, closePool } = await import('../postgres');
      const previous: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(env)) {
        previous[name] = process.env[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await closePool();
      try {
        return createPool().options;
      } finally {
        await closePool();
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }

    void it('defaults to the connection-budget pool size and the 30 s idle timeout', async () => {
      const options = await poolOptionsWith({
        DB_POOL_MAX: undefined,
        DB_POOL_IDLE_TIMEOUT_S: undefined,
        VERCEL: undefined,
      });
      assert.equal(options.max, 5);
      assert.equal(options.idle_timeout, 30);
    });

    void it('shrinks the defaults on Vercel, where instance count is the term that grows', async () => {
      // A crawl burst scales lambda count; instances × held-idle connections
      // can exhaust the shared max_connections. See docs/db-connectivity.md.
      const options = await poolOptionsWith({
        DB_POOL_MAX: undefined,
        DB_POOL_IDLE_TIMEOUT_S: undefined,
        VERCEL: '1',
      });
      assert.equal(options.max, 3);
      assert.equal(options.idle_timeout, 5);
    });

    void it('lets explicit knobs override the serverless defaults', async () => {
      const options = await poolOptionsWith({ DB_POOL_MAX: '6', DB_POOL_IDLE_TIMEOUT_S: '20', VERCEL: '1' });
      assert.equal(options.max, 6);
      assert.equal(options.idle_timeout, 20);
    });

    void it('honours DB_POOL_MAX and DB_POOL_IDLE_TIMEOUT_S', async () => {
      const options = await poolOptionsWith({ DB_POOL_MAX: '4', DB_POOL_IDLE_TIMEOUT_S: '10' });
      assert.equal(options.max, 4);
      assert.equal(options.idle_timeout, 10);
    });

    void it('clamps DB_POOL_MAX to the two-connection floor', async () => {
      // getClimb issues two sequential statements; a pool of one serialises
      // every front-door render behind a single connection.
      const options = await poolOptionsWith({ DB_POOL_MAX: '1' });
      assert.equal(options.max, 2);
    });

    void it('falls back to the default when DB_POOL_MAX is not a number', async () => {
      const options = await poolOptionsWith({ DB_POOL_MAX: 'abc', VERCEL: undefined });
      assert.equal(options.max, 5);
    });

    void it('resolves DB_POOL_MAX for pools built outside createDb, with their own fallback', async () => {
      // The sync daemons build their own postgres.js pools through this.
      const { resolvePoolMax } = await import('../postgres');
      const previous = process.env.DB_POOL_MAX;
      try {
        delete process.env.DB_POOL_MAX;
        assert.equal(resolvePoolMax(), 5);
        assert.equal(resolvePoolMax(7), 7);
        process.env.DB_POOL_MAX = '3';
        assert.equal(resolvePoolMax(7), 3);
        process.env.DB_POOL_MAX = '1';
        assert.equal(resolvePoolMax(), 2);
        process.env.DB_POOL_MAX = 'abc';
        assert.equal(resolvePoolMax(7), 7);
      } finally {
        if (previous === undefined) delete process.env.DB_POOL_MAX;
        else process.env.DB_POOL_MAX = previous;
      }
    });

    void it('clamps DB_POOL_MAX to 100 with a warning, so a typo cannot exhaust the heap', async (context) => {
      // postgres.js allocates one connection object per slot: 100000 took 736 MB.
      const warn = context.mock.method(console, 'warn', () => {});
      const options = await poolOptionsWith({ DB_POOL_MAX: '100000' });
      assert.equal(options.max, 100);
      assert.ok(
        warn.mock.calls.some((call) => String(call.arguments[0]).includes('DB_POOL_MAX=100000 is above 100')),
        'the clamp must be logged',
      );
      const { resolvePoolMax } = await import('../postgres');
      const previous = process.env.DB_POOL_MAX;
      try {
        process.env.DB_POOL_MAX = '100';
        assert.equal(resolvePoolMax(), 100);
        process.env.DB_POOL_MAX = '1000000';
        assert.equal(resolvePoolMax(), 100);
      } finally {
        if (previous === undefined) delete process.env.DB_POOL_MAX;
        else process.env.DB_POOL_MAX = previous;
      }
    });

    void it('falls back to the serverless default when DB_POOL_MAX is not a number on Vercel', async () => {
      const options = await poolOptionsWith({ DB_POOL_MAX: 'abc', VERCEL: '1' });
      assert.equal(options.max, 3);
    });

    void it('falls back to the serverless default when DB_POOL_IDLE_TIMEOUT_S is not a number on Vercel', async () => {
      const options = await poolOptionsWith({ DB_POOL_IDLE_TIMEOUT_S: 'abc', VERCEL: '1' });
      assert.equal(options.idle_timeout, 5);
    });

    void it('keeps DB_POOL_IDLE_TIMEOUT_S=0 as "never close an idle connection"', async () => {
      // postgres.js treats a falsy idle_timeout as disabled, so 0 is meaningful
      // and must not be clamped up the way DB_POOL_MAX is.
      const options = await poolOptionsWith({ DB_POOL_IDLE_TIMEOUT_S: '0' });
      assert.equal(options.idle_timeout, 0);
    });

    void it('emits no statement_timeout startup parameter by default', async () => {
      // PgBouncer in transaction-pooling mode rejects unknown startup
      // parameters, so this must stay off until the Railway URL is confirmed
      // direct. See docs/db-connectivity.md.
      const options = await poolOptionsWith({ DB_STATEMENT_TIMEOUT_MS: undefined });
      assert.equal(options.connection.statement_timeout, undefined);
    });

    void it('emits statement_timeout when DB_STATEMENT_TIMEOUT_MS is set', async () => {
      const options = await poolOptionsWith({ DB_STATEMENT_TIMEOUT_MS: '8000' });
      assert.equal(options.connection.statement_timeout, 8000);
    });

    void it('emits no idle_in_transaction_session_timeout unless the process asks for one', async () => {
      // Workers, daemons and scripts keep the server default (off).
      const options = await poolOptionsWith({ DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: undefined });
      assert.equal(options.connection.idle_in_transaction_session_timeout, undefined);
    });

    void it('sends both session timeouts together', async () => {
      const options = await poolOptionsWith({
        DB_STATEMENT_TIMEOUT_MS: '45000',
        DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '60000',
      });
      assert.equal(options.connection.statement_timeout, 45000);
      assert.equal(options.connection.idle_in_transaction_session_timeout, 60000);
    });

    void it('treats DB_IDLE_IN_TRANSACTION_TIMEOUT_MS=0 as off', async () => {
      const options = await poolOptionsWith({ DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0' });
      assert.equal(options.connection.idle_in_transaction_session_timeout, undefined);
    });

    void it('reads DB_STATEMENT_TIMEOUT_MS with parseInt, as it always has', async () => {
      const options = await poolOptionsWith({ DB_STATEMENT_TIMEOUT_MS: '8000ms' });
      assert.equal(options.connection.statement_timeout, 8000);
    });

    void it('accepts the idle timeout at both ends of its range', async () => {
      const lowest = await poolOptionsWith({ DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '1000' });
      assert.equal(lowest.connection.idle_in_transaction_session_timeout, 1000);
      const highest = await poolOptionsWith({ DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '2147483647' });
      assert.equal(highest.connection.idle_in_transaction_session_timeout, 2_147_483_647);
    });

    void it('treats an empty DB_IDLE_IN_TRANSACTION_TIMEOUT_MS as unset', async () => {
      const options = await poolOptionsWith({ DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '' });
      assert.equal(options.connection.idle_in_transaction_session_timeout, undefined);
    });

    for (const [value, why] of [
      ['60', 'seconds typed as milliseconds would end nearly every transaction'],
      ['999', 'below a second'],
      ['99999999999', "above PostgreSQL's ceiling, so every connection would fail"],
      ['60s', 'a unit'],
      ['-1', 'negative'],
    ] as const) {
      void it(`refuses DB_IDLE_IN_TRANSACTION_TIMEOUT_MS=${value} at boot (${why})`, async () => {
        await assert.rejects(
          poolOptionsWith({ DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: value }),
          /DB_IDLE_IN_TRANSACTION_TIMEOUT_MS must be 0 \(off\) or whole milliseconds from 1000 to 2147483647/,
        );
      });
    }
  });

  void describe('applyRequestPoolDefaults', () => {
    async function withIdleTimeoutVariable(value: string | undefined, run: () => Promise<void>) {
      const previous = process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS;
      if (value === undefined) delete process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS;
      else process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS = value;
      const { closePool, closeReadPool } = await import('../postgres');
      await closePool();
      await closeReadPool();
      try {
        await run();
      } finally {
        await closePool();
        await closeReadPool();
        if (previous === undefined) delete process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS;
        else process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS = previous;
      }
    }

    void it('gives every pool built afterwards 60 s, and can run again once they exist', async () => {
      await withIdleTimeoutVariable(undefined, async () => {
        const { applyRequestPoolDefaults, createDedicatedPool, createPool } = await import('../postgres');
        applyRequestPoolDefaults();
        assert.equal(createPool().options.connection.idle_in_transaction_session_timeout, 60_000);
        const dedicatedPool = createDedicatedPool(2);
        try {
          assert.equal(dedicatedPool.options.connection.idle_in_transaction_session_timeout, 60_000);
        } finally {
          await dedicatedPool.end();
        }
        // Next.js re-evaluates the module that calls it; the pool already matches.
        assert.doesNotThrow(() => applyRequestPoolDefaults());
      });
    });

    void it('keeps an explicit value, and 0 turns it off', async () => {
      await withIdleTimeoutVariable('0', async () => {
        const { applyRequestPoolDefaults, createPool } = await import('../postgres');
        applyRequestPoolDefaults();
        assert.equal(createPool().options.connection.idle_in_transaction_session_timeout, undefined);
      });
      await withIdleTimeoutVariable('30000', async () => {
        const { applyRequestPoolDefaults, createPool } = await import('../postgres');
        applyRequestPoolDefaults();
        assert.equal(createPool().options.connection.idle_in_transaction_session_timeout, 30_000);
      });
    });

    void it('gives an empty variable the 60 s default', async () => {
      await withIdleTimeoutVariable('', async () => {
        const { applyRequestPoolDefaults, createPool } = await import('../postgres');
        applyRequestPoolDefaults();
        assert.equal(createPool().options.connection.idle_in_transaction_session_timeout, 60_000);
      });
    });

    void it('fails at boot on a value out of range', async () => {
      await withIdleTimeoutVariable('60', async () => {
        const { applyRequestPoolDefaults } = await import('../postgres');
        assert.throws(() => applyRequestPoolDefaults(), /must be 0 \(off\) or whole milliseconds/);
      });
    });

    void it('throws when a shared pool was built before it ran', async () => {
      await withIdleTimeoutVariable(undefined, async () => {
        const { applyRequestPoolDefaults, createPool } = await import('../postgres');
        createPool();
        assert.throws(() => applyRequestPoolDefaults(), /before anything that calls createDb/);
      });
    });
  });

  void describe('read replica fallback', () => {
    void it('createReadDb returns the primary db when READ_REPLICA_URL is unset', async () => {
      const previous = process.env.READ_REPLICA_URL;
      delete process.env.READ_REPLICA_URL;
      try {
        const { createDb, createReadDb, closePool, closeReadPool } = await import('../postgres');
        await closePool();
        await closeReadPool();
        const primary = createDb();
        const reader = createReadDb();
        assert.equal(reader, primary, 'createReadDb should fall back to the primary db');
        await closeReadPool();
        await closePool();
      } finally {
        if (previous !== undefined) process.env.READ_REPLICA_URL = previous;
      }
    });

    void it('createReadDb returns a separate instance when READ_REPLICA_URL is set', async () => {
      const previous = process.env.READ_REPLICA_URL;
      process.env.READ_REPLICA_URL = 'postgres://postgres:password@localhost:5432/main';
      try {
        const { createDb, createReadDb, closePool, closeReadPool } = await import('../postgres');
        await closePool();
        await closeReadPool();
        const primary = createDb();
        const reader = createReadDb();
        assert.notEqual(reader, primary, 'read db should be a separate drizzle instance');
        await closeReadPool();
        await closePool();
      } finally {
        if (previous === undefined) delete process.env.READ_REPLICA_URL;
        else process.env.READ_REPLICA_URL = previous;
      }
    });

    void it('closeReadPool resolves without error when no read pool exists', async () => {
      const { closeReadPool } = await import('../postgres');
      await assert.doesNotReject(() => closeReadPool());
    });
  });
});
