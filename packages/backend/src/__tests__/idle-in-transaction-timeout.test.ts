import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  applyRequestPoolDefaults,
  createDedicatedPool,
  REQUEST_POOL_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  withConnectRetry,
} from '@boardsesh/db/client';
import { PARTNER_IDLE_IN_TRANSACTION_TIMEOUT_MS, partnerPoolOverrides } from '../auth/partner/transaction';
import { db } from '../db/client';
import { getWorkerDatabaseUrl } from './worker-db';

const runFile = promisify(execFile);
const backendRoot = fileURLToPath(new URL('../..', import.meta.url));

/** A short timeout so the test waits seconds, not the production minute. */
const TEST_TIMEOUT_MS = 1_000;
/** Comfortably past the timeout: Postgres checks it on a timer, not to the millisecond. */
const IDLE_FOR_MS = 2_500;

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Opens a transaction, sits idle inside it, then sends one more statement. The
 * returned `pid` is the backend that served the transaction, `settledAfterMs`
 * how long the transaction took to settle, and `lateStatement` how the
 * statement sent after the idle wait ended.
 */
async function idleInsideTransaction(pool: ReturnType<typeof createDedicatedPool>) {
  const database = drizzle(withConnectRetry(pool));
  let pid: number | undefined;
  let lateStatement: Promise<'ran' | 'rejected'> | undefined;
  const startedAt = Date.now();
  try {
    await database.transaction(async (transaction) => {
      const [row] = (await transaction.execute(sql`SELECT pg_backend_pid() AS pid`)) as unknown as Array<{
        pid: number;
      }>;
      pid = row.pid;
      lateStatement = sleep(IDLE_FOR_MS).then(() =>
        transaction.execute(sql`SELECT 1`).then(
          () => 'ran' as const,
          () => 'rejected' as const,
        ),
      );
      if ((await lateStatement) === 'rejected') throw new Error('the late statement was rejected');
    });
    return { pid, error: undefined, settledAfterMs: Date.now() - startedAt, lateStatement: await lateStatement };
  } catch (error) {
    return { pid, error, settledAfterMs: Date.now() - startedAt, lateStatement: await lateStatement };
  }
}

async function backendIsAlive(pid: number | undefined): Promise<boolean> {
  const rows = (await db.execute(sql`SELECT 1 FROM pg_stat_activity WHERE pid = ${pid ?? -1}`)) as unknown as unknown[];
  return rows.length > 0;
}

describe('idle_in_transaction_session_timeout on request pools', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ends a session left idle inside a transaction on a covered pool, and the pool recovers', async () => {
    vi.stubEnv('DATABASE_URL', getWorkerDatabaseUrl());
    vi.stubEnv('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', String(TEST_TIMEOUT_MS));
    const pool = createDedicatedPool(1);
    try {
      expect(pool.options.connection.idle_in_transaction_session_timeout).toBe(TEST_TIMEOUT_MS);

      const { pid, error, settledAfterMs, lateStatement } = await idleInsideTransaction(pool);

      // What the caller sees. Postgres sends 25P03 and closes the socket while
      // no statement is in flight, so the driver reports the closed connection.
      // The transaction rejects as soon as the socket closes, before its
      // callback has finished waiting; the callback keeps running, and the
      // statement it sends afterwards is rejected.
      const { code, message } = error as { code?: string; message?: string };
      expect(code).toBe('CONNECTION_CLOSED');
      expect(message).toMatch(/CONNECTION_CLOSED/);
      expect(settledAfterMs).toBeLessThan(IDLE_FOR_MS);
      expect(lateStatement).toBe('rejected');
      expect(await backendIsAlive(pid)).toBe(false);

      // The pool opens a new connection for the next caller.
      const [row] = await pool<{ ok: number }[]>`SELECT 1 AS ok`;
      expect(row.ok).toBe(1);
    } finally {
      await pool.end();
    }
  }, 15_000);

  it('leaves an idle transaction alone on a pool built without it', async () => {
    vi.stubEnv('DATABASE_URL', getWorkerDatabaseUrl());
    vi.stubEnv('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', '');
    const pool = createDedicatedPool(1);
    try {
      expect(pool.options.connection.idle_in_transaction_session_timeout).toBeUndefined();
      const [setting] = await pool<
        { timeout: string }[]
      >`SELECT current_setting('idle_in_transaction_session_timeout') AS timeout`;
      expect(setting.timeout).toBe('0');

      const { pid, error, lateStatement } = await idleInsideTransaction(pool);

      expect(error).toBeUndefined();
      expect(lateStatement).toBe('ran');
      expect(await backendIsAlive(pid)).toBe(true);
    } finally {
      await pool.end();
    }
  }, 15_000);

  it('refuses to run after a shared pool was built without it', () => {
    // This file's shared pool was built at import, as a worker's is.
    expect(db).toBeDefined();
    vi.stubEnv('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', undefined);
    expect(() => applyRequestPoolDefaults()).toThrow(/before anything that calls createDb/);
  });

  it('gives the partner pool the same ten seconds its transactions set', async () => {
    vi.stubEnv('DATABASE_URL', getWorkerDatabaseUrl());
    vi.stubEnv('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', String(REQUEST_POOL_IDLE_IN_TRANSACTION_TIMEOUT_MS));
    const pool = createDedicatedPool(1, partnerPoolOverrides());
    try {
      const [setting] = await pool<
        { timeout: string }[]
      >`SELECT current_setting('idle_in_transaction_session_timeout') AS timeout`;
      expect(setting.timeout).toBe('10s');
      expect(PARTNER_IDLE_IN_TRANSACTION_TIMEOUT_MS).toBe(10_000);
    } finally {
      await pool.end();
    }
  });
});

describe('which processes get the timeout', () => {
  /** Runs a module graph in a fresh Node process, the way an entry point would. */
  async function sessionTimeoutAfterImporting(imports: string[]): Promise<string> {
    const script = `${imports.map((path) => `await import(${JSON.stringify(path)});`).join('\n')}
const { createPool, closePool } = await import('@boardsesh/db/client');
const [row] = await createPool()\`SHOW idle_in_transaction_session_timeout\`;
process.stdout.write(row.idle_in_transaction_session_timeout);
await closePool();`;
    const environment: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: getWorkerDatabaseUrl() };
    delete environment.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS;
    const { stdout } = await runFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: backendRoot,
      env: environment,
      timeout: 60_000,
    });
    return stdout.trim();
  }

  it('the backend server entry sends 60 s on its shared pool', async () => {
    expect(await sessionTimeoutAfterImporting(['./src/request-pool-defaults.ts', './src/db/client.ts'])).toBe('1min');
  }, 70_000);

  it('a worker or script that never imports the defaults keeps the server default, off', async () => {
    expect(await sessionTimeoutAfterImporting(['./src/db/client.ts'])).toBe('0');
  }, 70_000);

  it('imports the defaults before anything else in the server entry, after Sentry', () => {
    const entry = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const importedPaths = [...entry.matchAll(/^import\s+(?:[^'"]+from\s+)?['"]([^'"]+)['"]/gm)].map(
      (match) => match[1],
    );
    expect(importedPaths.slice(0, 2)).toEqual(['./instrument', './request-pool-defaults']);
  });
});
