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
vi.mock('../catalog-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../catalog-access')>();
  return { ...actual, canReadPrivateCatalog: vi.fn(actual.canReadPrivateCatalog) };
});
import { startCatalogAuthorization } from '../catalog-authorization';
import { CATALOG_VIEWER_KEY, canReadPrivateCatalog, getAuthorizedCatalogViewerId } from '../catalog-access';

const SCOPE_KEY = 'kilter:1:1';
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

async function viewerMarker(): Promise<unknown> {
  const marker = await database.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    CATALOG_VIEWER_KEY,
  ]);
  return marker ? JSON.parse(marker.value) : null;
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
  state.token = 'first-token';
  state.generation = 1;
  state.viewer = 'first-viewer';
  state.request.mockReset().mockImplementation(async () => ({ profile: { id: state.viewer } }));
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

    await vi.waitFor(async () => expect(await canReadPrivateCatalog(database)).toBe(true));
    expect(await viewerMarker()).toEqual({ viewerId: 'first-viewer', credentialDigest: 'digest-first-token' });
    expect(await getAuthorizedCatalogViewerId(database)).toBe('first-viewer');
    expect(state.request).toHaveBeenCalledOnce();
  });

  it('leaves a stamped catalogue and its finished downloads alone on the next launch', async () => {
    signIn();
    await vi.waitFor(async () => expect(await canReadPrivateCatalog(database)).toBe(true));
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
    await vi.waitFor(() => expect(vi.mocked(canReadPrivateCatalog).mock.results.length).toBeGreaterThan(reads));
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
    await vi.waitFor(async () => expect(await canReadPrivateCatalog(database)).toBe(true));
    signOut();
    await insertClimb('manufacturer-climb', null);
    await insertClimb('followers-only-climb', 'someone-the-first-viewer-follows');
    state.token = 'second-token';
    state.generation += 1;
    state.viewer = 'second-viewer';
    expect(await canReadPrivateCatalog(database)).toBe(false);

    signIn();

    await vi.waitFor(async () => expect(await getAuthorizedCatalogViewerId(database)).toBe('second-viewer'));
    expect(await viewerMarker()).toEqual({ viewerId: 'second-viewer', credentialDigest: 'digest-second-token' });
    expect(await database.getAllAsync('SELECT uuid FROM board_climbs ORDER BY uuid')).toEqual([
      { uuid: 'manufacturer-climb' },
    ]);
  });
});
