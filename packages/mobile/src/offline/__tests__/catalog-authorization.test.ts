// Catalogue authorization against a real SQLite catalogue: real marker reads,
// the real revalidation and its server check. Only platform edges are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCheckpoint,
  getCheckpointKey,
  isScopeDownloadComplete,
  markScopeDownloadComplete,
  runMigrations,
  setCheckpoint,
} from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';

const state = vi.hoisted(() => ({
  token: 'first-token',
  generation: 1,
  viewer: 'first-viewer',
  database: null as unknown,
  request: vi.fn(),
  deliveryListeners: new Set<() => void>(),
}));
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('../../db/connection', () => ({
  getDatabaseHandle: () => state.database,
  subscribeDatabaseHandle: () => () => {},
}));
vi.mock('../../lib/auth-store', () => ({
  getAuthToken: async () => state.token,
  captureAuthCredentialGeneration: () => state.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === state.generation,
}));
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, token: string) => `digest-${token}`,
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: state.request }) }));
vi.mock('../../lib/spray/spray-privacy-cleanup', () => ({ clearSprayWallPrivateCaches: vi.fn() }));
vi.mock('../../lib/spray/spray-photo-store', () => ({ clearStoredSprayPhotos: vi.fn() }));
vi.mock('../../settings', () => ({ getSetting: () => [] }));
vi.mock('../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../offline-sync-adapter', () => ({
  subscribeMutationDelivery: (listener: () => void) => {
    state.deliveryListeners.add(listener);
    return () => state.deliveryListeners.delete(listener);
  },
}));
vi.mock('../privacy-revalidation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../privacy-revalidation')>();
  return { ...actual, reopenHeldCatalog: vi.fn(actual.reopenHeldCatalog) };
});
vi.mock('../catalog-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../catalog-access')>();
  return { ...actual, canReadPrivateCatalog: vi.fn(actual.canReadPrivateCatalog) };
});
import { startCatalogAuthorization } from '../catalog-authorization';
import { reopenHeldCatalog } from '../privacy-revalidation';
import {
  CATALOG_HELD_KEY,
  CATALOG_VIEWER_KEY,
  canReadPrivateCatalog,
  getAuthorizedCatalogViewerId,
} from '../catalog-access';

const SCOPE_KEY = 'kilter:1:1';
// The first authorization pays for cold dynamic imports (auth store, crypto,
// GraphQL client); under a full parallel run that alone can pass a second.
const SETTLED = { timeout: 15_000, interval: 20 };
vi.setConfig({ testTimeout: 30_000 });
let database: TestSqliteDb;
let stop: (() => void) | undefined;

async function insertClimb(uuid: string, userId: string | null): Promise<void> {
  await database.runAsync('INSERT INTO board_climbs (uuid, board_type, layout_id, user_id) VALUES (?, ?, ?, ?)', [
    uuid,
    'kilter',
    1,
    userId,
  ]);
}

async function syncMetaRecord(key: string): Promise<unknown> {
  const record = await database.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [key]);
  return record ? JSON.parse(record.value) : null;
}

const viewerMarker = () => syncMetaRecord(CATALOG_VIEWER_KEY);

async function queueWrite(idempotencyKey: string, climbUuid: string, status: 'pending' | 'dead_letter'): Promise<void> {
  await database.runAsync(
    "INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key, status) VALUES ('boardsesh_ticks', 'create', ?, ?, ?)",
    [JSON.stringify({ climbUuid }), idempotencyKey, status],
  );
}

/** A downloaded board whose crawl has finished. */
async function finishDownload(): Promise<string> {
  await markScopeDownloadComplete(database, SCOPE_KEY);
  const checkpointKey = getCheckpointKey('board_climbs', SCOPE_KEY);
  await setCheckpoint(database, checkpointKey, { updatedAt: '2026-10-12T00:00:00Z', syncSeq: '10' });
  return checkpointKey;
}

/** Wait for the next held-catalogue check to finish and return whether it reopened reads. */
async function nextReopen(after: number): Promise<boolean | undefined> {
  await vi.waitFor(() => expect(vi.mocked(reopenHeldCatalog).mock.results.length).toBeGreaterThan(after), SETTLED);
  return vi.mocked(reopenHeldCatalog).mock.results.at(-1)?.value;
}

/** The app reaching a signed-in session for `state.viewer`. */
function signIn(): void {
  const viewerId = state.viewer;
  stop = startCatalogAuthorization(viewerId, () => state.viewer === viewerId);
}

function signOut(): void {
  stop?.();
  stop = undefined;
}

beforeEach(async () => {
  vi.mocked(canReadPrivateCatalog).mockClear();
  vi.mocked(reopenHeldCatalog).mockClear();
  state.token = 'first-token';
  state.generation = 1;
  state.viewer = 'first-viewer';
  state.request.mockReset().mockImplementation(async () => ({ profile: { id: state.viewer } }));
  state.deliveryListeners.clear();
  database = createTestDatabase();
  await runMigrations(database);
  state.database = database;
});
afterEach(() => {
  signOut();
  database.close();
});

describe('offline catalogue access without the privacy event', () => {
  it('stamps the viewer marker when a signed-in session finds none, then reads offline copies', async () => {
    await insertClimb('manufacturer-climb', null);
    expect(await canReadPrivateCatalog(database)).toBe(false);

    signIn();

    await vi.waitFor(async () => expect(await canReadPrivateCatalog(database)).toBe(true), SETTLED);
    expect(await viewerMarker()).toEqual({ viewerId: 'first-viewer', credentialDigest: 'digest-first-token' });
    expect(await getAuthorizedCatalogViewerId(database)).toBe('first-viewer');
    expect(state.request).toHaveBeenCalledOnce();
  });

  it('leaves a stamped catalogue and its finished downloads alone on the next launch', async () => {
    signIn();
    await vi.waitFor(async () => expect(await canReadPrivateCatalog(database)).toBe(true), SETTLED);
    signOut();
    // A download that finished after the marker was stamped.
    await insertClimb('another-setters-climb', 'another-setter');
    await markScopeDownloadComplete(database, SCOPE_KEY);
    const checkpointKey = getCheckpointKey('board_climbs', SCOPE_KEY);
    await setCheckpoint(database, checkpointKey, { updatedAt: '2026-10-12T00:00:00Z', syncSeq: '10' });
    state.request.mockClear();
    const reads = vi.mocked(canReadPrivateCatalog).mock.results.length;

    signIn();

    // The start-up check reads the marker; wait until that read has answered.
    await vi.waitFor(
      () => expect(vi.mocked(canReadPrivateCatalog).mock.results.length).toBeGreaterThan(reads),
      SETTLED,
    );
    expect(await vi.mocked(canReadPrivateCatalog).mock.results.at(-1)?.value).toBe(true);
    expect(state.request).not.toHaveBeenCalled();
    expect(await isScopeDownloadComplete(database, SCOPE_KEY)).toBe(true);
    expect(await getCheckpoint(database, checkpointKey)).not.toBeNull();
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs ORDER BY uuid')).toEqual([
      { uuid: 'another-setters-climb' },
    ]);
  });

  it("withdraws the previous account's authored copies and restamps after another account signs in", async () => {
    signIn();
    await vi.waitFor(async () => expect(await canReadPrivateCatalog(database)).toBe(true), SETTLED);
    signOut();
    await insertClimb('manufacturer-climb', null);
    await insertClimb('followers-only-climb', 'someone-the-first-viewer-follows');
    state.token = 'second-token';
    state.generation += 1;
    state.viewer = 'second-viewer';
    expect(await canReadPrivateCatalog(database)).toBe(false);

    signIn();

    await vi.waitFor(async () => expect(await getAuthorizedCatalogViewerId(database)).toBe('second-viewer'), SETTLED);
    expect(await viewerMarker()).toEqual({ viewerId: 'second-viewer', credentialDigest: 'digest-second-token' });
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs ORDER BY uuid')).toEqual([
      { uuid: 'manufacturer-climb' },
    ]);
  });
});

describe('a catalogue kept closed for a queued write', () => {
  it('withdraws once, then leaves the downloads alone on every later launch', async () => {
    await insertClimb('another-setters-climb', 'another-setter');
    await insertClimb('climb-with-a-queued-tick', 'another-setter');
    await queueWrite('queued-tick', 'climb-with-a-queued-tick', 'pending');

    signIn();
    await vi.waitFor(async () => expect(await syncMetaRecord(CATALOG_HELD_KEY)).not.toBeNull(), SETTLED);
    expect(await viewerMarker()).toBeNull();
    expect(state.request).toHaveBeenCalledOnce();
    // The replay after the withdrawal finishes the board again.
    const checkpointKey = await finishDownload();

    for (let launch = 2; launch <= 3; launch += 1) {
      signOut();
      const checks = vi.mocked(reopenHeldCatalog).mock.results.length;
      signIn();
      // The kept row is counted again, not withdrawn.
      expect(await nextReopen(checks), `launch ${launch}`).toBe(false);
      expect(state.request, `launch ${launch}`).toHaveBeenCalledOnce();
      expect(await getCheckpoint(database, checkpointKey), `launch ${launch}`).not.toBeNull();
      expect(await isScopeDownloadComplete(database, SCOPE_KEY), `launch ${launch}`).toBe(true);
      expect(await canReadPrivateCatalog(database), `launch ${launch}`).toBe(false);
    }
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs ORDER BY uuid')).toEqual([
      { uuid: 'climb-with-a-queued-tick' },
    ]);
  });

  it('reopens reads in the same launch once the queued write is delivered', async () => {
    await insertClimb('climb-with-a-queued-tick', 'another-setter');
    await queueWrite('queued-tick', 'climb-with-a-queued-tick', 'pending');
    signIn();
    await vi.waitFor(async () => expect(await syncMetaRecord(CATALOG_HELD_KEY)).not.toBeNull(), SETTLED);
    const checkpointKey = await finishDownload();
    state.request.mockClear();

    await database.runAsync("DELETE FROM pending_mutations WHERE idempotency_key = 'queued-tick'");
    const checks = vi.mocked(reopenHeldCatalog).mock.results.length;
    for (const listener of state.deliveryListeners) listener();

    expect(await nextReopen(checks)).toBe(true);
    expect(await canReadPrivateCatalog(database)).toBe(true);
    expect(await viewerMarker()).toEqual({ viewerId: 'first-viewer', credentialDigest: 'digest-first-token' });
    expect(await syncMetaRecord(CATALOG_HELD_KEY)).toBeNull();
    expect(state.request).not.toHaveBeenCalled();
    expect(await getCheckpoint(database, checkpointKey)).not.toBeNull();
  });

  it('does not let a dead-lettered write hold the catalogue', async () => {
    await insertClimb('climb-with-a-dead-letter', 'another-setter');
    await queueWrite('dead-tick', 'climb-with-a-dead-letter', 'dead_letter');

    signIn();

    await vi.waitFor(async () => expect(await canReadPrivateCatalog(database)).toBe(true), SETTLED);
    expect(await syncMetaRecord(CATALOG_HELD_KEY)).toBeNull();
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs')).toEqual([]);
    expect(await database.getAllAsync('SELECT idempotency_key FROM pending_mutations')).toEqual([
      { idempotency_key: 'dead-tick' },
    ]);
  });
});
