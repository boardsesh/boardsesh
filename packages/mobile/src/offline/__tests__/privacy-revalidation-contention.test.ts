import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureMainConnection, isDatabaseLockedError, runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';

const auth = vi.hoisted(() => ({ token: 'accepted-token', generation: 1, viewer: 'viewer' }));
const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-store', () => ({
  getAuthToken: async () => auth.token,
  captureAuthCredentialGeneration: () => auth.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === auth.generation,
}));
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, token: string) => `digest-${token}`,
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request }) }));

let directory: string;
let database: TestSqliteDb;
let interloper: TestSqliteDb;
let privacy: typeof import('../privacy-revalidation');
let catalog: typeof import('../catalog-access');

beforeEach(async () => {
  vi.resetModules();
  auth.token = 'accepted-token';
  auth.generation = 1;
  auth.viewer = 'viewer';
  request.mockReset().mockImplementation(async () => ({ profile: { id: auth.viewer } }));
  privacy = await import('../privacy-revalidation');
  catalog = await import('../catalog-access');
  directory = mkdtempSync(join(tmpdir(), 'bs-privacy-contention-'));
  const path = join(directory, 'catalog.db');
  database = createTestDatabase(path);
  await configureMainConnection(database);
  await runMigrations(database);
  interloper = createTestDatabase(path);
  await interloper.execAsync('PRAGMA busy_timeout = 0');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await interloper?.execAsync('ROLLBACK').catch(() => {});
  interloper?.close();
  database?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function contendNextPurge(onFirstFailure: () => void = () => {}) {
  request.mockImplementation(async () => {
    expect(
      await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [catalog.CATALOG_VIEWER_KEY]),
    ).toBeNull();
    await interloper.execAsync('BEGIN IMMEDIATE');
    await interloper.runAsync("INSERT INTO sync_meta (key, value) VALUES ('purge-holder', 'uncommitted')");
    return { profile: { id: 'viewer' } };
  });
  const exclusive = database.withExclusiveTransactionAsync.bind(database);
  const attempts = { connections: new Set<unknown>(), firstFailure: null as unknown };
  vi.spyOn(database, 'withExclusiveTransactionAsync').mockImplementation(async (task) => {
    try {
      await exclusive(async (transaction) => {
        attempts.connections.add(transaction);
        await task(transaction);
      });
    } catch (error) {
      if (attempts.firstFailure === null) {
        attempts.firstFailure = error;
        onFirstFailure();
        await interloper.execAsync('ROLLBACK');
      }
      throw error;
    }
  });
  return attempts;
}

describe('privacy revalidation under real SQLite WAL contention', () => {
  it('recovers a contended marker withdrawal before contacting the server', async () => {
    await privacy.revalidatePrivateCatalog(database, 'viewer', []);
    request.mockClear();
    // The real main connection waits five seconds before returning this lock.
    await interloper.execAsync('BEGIN IMMEDIATE');
    await interloper.runAsync("INSERT INTO sync_meta (key, value) VALUES ('holder', 'uncommitted')");
    const run = database.runAsync.bind(database);
    let lockFailure: unknown;
    let withdrawalAttempts = 0;
    vi.spyOn(database, 'runAsync').mockImplementation(async (query, ...params) => {
      if (query === 'DELETE FROM sync_meta WHERE key = ?') withdrawalAttempts += 1;
      try {
        return await run(query, ...params);
      } catch (error) {
        lockFailure = error;
        // node:sqlite is synchronous: release after the failed attempt rather
        // than relying on a timer while the busy handler blocks this thread.
        await interloper.execAsync('ROLLBACK');
        throw error;
      }
    });
    request.mockImplementation(async () => {
      expect(
        await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [catalog.CATALOG_VIEWER_KEY]),
      ).toBeNull();
      // Authorization happens outside a transaction and after withdrawal commits.
      await interloper.runAsync("INSERT INTO sync_meta (key, value) VALUES ('during-http', 'allowed')");
      return { profile: { id: 'viewer' } };
    });

    await expect(privacy.revalidatePrivateCatalog(database, 'viewer', [])).resolves.toBeUndefined();
    expect(isDatabaseLockedError(lockFailure)).toBe(true);
    expect(withdrawalAttempts).toBe(2);
    expect(request).toHaveBeenCalledOnce();
    expect(await catalog.canReadPrivateCatalog(database)).toBe(true);
  }, 15000);

  it('takes the writer lock before reading a catalogue snapshot', async () => {
    await database.runAsync(
      "INSERT INTO board_climbs (uuid, board_type, layout_id, user_id) VALUES ('withdrawn', 'kilter', 1, 'other')",
    );
    const exclusive = database.withExclusiveTransactionAsync.bind(database);
    let interloperError: unknown;
    let interloperCommitted = false;
    vi.spyOn(database, 'withExclusiveTransactionAsync').mockImplementation((task) =>
      exclusive(async (transaction) => {
        const read = transaction.getAllAsync.bind(transaction);
        vi.spyOn(transaction, 'getAllAsync').mockImplementation(async (query, ...params) => {
          const rows = await read(query, ...params);
          if (query.startsWith('SELECT DISTINCT board_type, layout_id')) {
            try {
              await interloper.runAsync(
                "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('snapshot-interloper', 'committed')",
              );
              interloperCommitted = true;
            } catch (error) {
              interloperError = error;
            }
          }
          return rows;
        });
        await task(transaction);
      }),
    );

    await expect(privacy.revalidatePrivateCatalog(database, 'viewer', [])).resolves.toBeUndefined();
    expect(interloperCommitted).toBe(false);
    expect(isDatabaseLockedError(interloperError)).toBe(true);
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs')).toEqual([]);
    expect(await catalog.canReadPrivateCatalog(database)).toBe(true);
  });

  it('retries acquisition on a fresh transaction after a competing writer releases', async () => {
    const attempts = await contendNextPurge();

    await expect(privacy.revalidatePrivateCatalog(database, 'viewer', [])).resolves.toBeUndefined();
    expect(isDatabaseLockedError(attempts.firstFailure)).toBe(true);
    expect(attempts.connections.size).toBe(2);
    expect(request).toHaveBeenCalledOnce();
    expect(await catalog.canReadPrivateCatalog(database)).toBe(true);
    expect(privacy.needsPrivacyRevalidation()).toBe(false);
  }, 15000);

  it('does not stamp a changed credential after waiting for the writer lock', async () => {
    await database.runAsync(
      "INSERT INTO board_climbs (uuid, board_type, layout_id, user_id) VALUES ('withdrawn', 'kilter', 1, 'other')",
    );
    const attempts = await contendNextPurge(() => {
      auth.token = 'new-account-token';
      auth.generation += 1;
    });

    await expect(privacy.revalidatePrivateCatalog(database, 'viewer', [])).rejects.toThrow('Account changed');
    expect(attempts.connections.size).toBe(2);
    expect(request).toHaveBeenCalledOnce();
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs')).toEqual([{ uuid: 'withdrawn' }]);
    expect(
      await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [catalog.CATALOG_VIEWER_KEY]),
    ).toBeNull();
    expect(await catalog.canReadPrivateCatalog(database)).toBe(false);
    await expect(privacy.waitForPrivacyRevalidation()).rejects.toThrow('Privacy revalidation is required');
  }, 15000);

  it('keeps reads blocked and avoids HTTP after exhausted marker withdrawal retries', async () => {
    await privacy.revalidatePrivateCatalog(database, 'viewer', []);
    request.mockClear();
    const failure = new Error('database is locked');
    const run = database.runAsync.bind(database);
    let withdrawalAttempts = 0;
    vi.spyOn(database, 'runAsync').mockImplementation(async (query, ...params) => {
      if (query === 'DELETE FROM sync_meta WHERE key = ?') {
        withdrawalAttempts += 1;
        throw failure;
      }
      return run(query, ...params);
    });
    const transaction = vi.spyOn(database, 'withExclusiveTransactionAsync');

    await expect(privacy.revalidatePrivateCatalog(database, 'viewer', [])).rejects.toBe(failure);
    expect(withdrawalAttempts).toBe(3);
    expect(request).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(await catalog.canReadPrivateCatalog(database)).toBe(false);
    expect(privacy.needsPrivacyRevalidation()).toBe(true);
  });

  it.each([
    { reason: 'exhausted lock retries', message: 'database is locked', attempts: 3 },
    { reason: 'a non-lock failure', message: 'disk I/O error', attempts: 1 },
  ])('preserves withdrawal and rolls back purge after $reason', async ({ message, attempts }) => {
    await privacy.revalidatePrivateCatalog(database, 'viewer', []);
    request.mockClear();
    await database.runAsync(
      "INSERT INTO board_climbs (uuid, board_type, layout_id, user_id) VALUES ('withdrawn', 'kilter', 1, 'other')",
    );
    const failure = new Error(message);
    const exclusive = database.withExclusiveTransactionAsync.bind(database);
    const connections = new Set<unknown>();
    vi.spyOn(database, 'withExclusiveTransactionAsync').mockImplementation((task) =>
      exclusive(async (transaction) => {
        connections.add(transaction);
        await task(transaction);
        // A failed commit must retry the whole rolled-back purge, not a statement
        // on the stale connection or the already verified HTTP request.
        throw failure;
      }),
    );

    await expect(privacy.revalidatePrivateCatalog(database, 'viewer', [])).rejects.toBe(failure);
    expect(connections.size).toBe(attempts);
    expect(request).toHaveBeenCalledOnce();
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs')).toEqual([{ uuid: 'withdrawn' }]);
    expect(
      await database.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [catalog.CATALOG_VIEWER_KEY]),
    ).toBeNull();
    expect(await catalog.canReadPrivateCatalog(database)).toBe(false);
    await expect(privacy.waitForPrivacyRevalidation()).rejects.toThrow('Privacy revalidation is required');
  });
});
