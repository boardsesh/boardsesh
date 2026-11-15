import { ClientError, GraphQLClient } from 'graphql-request';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { createBrowserHttpClientFacade } from '../../lib/graphql/http-client-facade.web';
import { createBrowserHttpOperations } from '../../lib/graphql/http-operation-client.web';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginGlobalPurge,
  beginImmediateWrite,
  configureMainConnection,
  enqueue,
  ensureMutationQueueTable,
  markScopeDownloadComplete,
  runMigrations,
  setBackgrounded,
  setPullWriteSettledReporter,
  stampLocalUserId,
} from '@boardsesh/offline-sync';
import { createTestDatabase } from '@boardsesh/offline-sync/testing';
import { createScopedHttpFixture } from '../../lib/graphql/__tests__/fixtures/scoped-http';
import { createWriterWorkerDatabase } from './fixtures/sqlite-writer-worker';

const host = vi.hoisted(() => ({
  capture: null as null | ((reader: () => Promise<string | undefined>) => unknown),
  generation: 0,
  legacyToken: null as string | null,
  status: vi.fn(),
  telemetry: vi.fn(),
  report: vi.fn(),
  offline: false,
}));
vi.mock('../offline-network-context', () => ({
  captureOfflineNetworkContext: (reader: () => Promise<string | undefined>) => host.capture?.(reader),
}));
vi.mock('../../lib/auth-store', () => ({
  getAuthToken: async () => {
    if (host.legacyToken) return host.legacyToken;
    throw new Error('Selected work must not read a JWT');
  },
  captureAuthCredentialGeneration: () => host.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === host.generation,
}));
vi.mock('../../lib/auth-store.web', () => ({
  captureAuthCredentialGeneration: () => 0,
  isAuthCredentialGenerationCurrent: () => true,
  isRequiredBrowserDispatch: () => false,
}));
vi.mock('../../lib/browser-backend-client.web', () => ({ expoBrowserBackendClient: {} }));
vi.mock('../../lib/graphql/client.web', () => ({
  browserHttpClients: { captureRequestView: vi.fn(), isCurrentView: vi.fn(), queryKey: vi.fn() },
}));
vi.mock('../../lib/graphql/http-operation.web', () => ({ createHttpOperation: vi.fn() }));
vi.mock('../../lib/client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: host.offline, reason: host.offline ? 'offline' : null }),
  reportBackendOutcome: vi.fn(),
  confirmBackendAvailability: async () => true,
  refreshDeviceState: async () => {},
  subscribeConnectivity: () => () => {},
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
}));
vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({ getString: () => undefined, set: vi.fn(), remove: vi.fn(), clearAll: vi.fn() }),
}));
vi.mock('../../lib/error-reporting', () => ({
  reportHandledError: (...parameters: unknown[]) => host.report(...parameters),
  addErrorBreadcrumb: vi.fn(),
}));
vi.mock('../../lib/analytics', () => ({ track: (...parameters: unknown[]) => host.telemetry(...parameters) }));
// These unrelated pull-only/native-asset bindings are never consumed by a drain.
vi.mock('../spray-photo-sink', () => ({ createSprayWallDeletedSink: () => vi.fn(), sprayWallPhotoSink: vi.fn() }));

import { createOfflineNetworkCapture } from '../offline-network-context.web';
import { drainMutationQueue, subscribeMutationDelivery } from '../offline-sync-adapter';
import { processMutation } from '../../../../shared/offline-sync/src/mutation-queue/handlers';
import type { PendingMutation } from '@boardsesh/offline-sync';
import { __resetDrainerStateForTests } from '../../../../shared/offline-sync/src/mutation-queue/drainer';

const close: (() => Promise<void>)[] = [];
beforeEach(() => {
  host.generation = 0;
  host.legacyToken = null;
  host.offline = false;
  host.status.mockReset();
  host.telemetry.mockReset();
  host.report.mockReset();
  __resetDrainerStateForTests();
});
afterEach(async () => {
  host.capture = null;
  for (const dispose of close.splice(0).reverse()) await dispose();
  __resetDrainerStateForTests();
});

async function fixture(busyTimeoutMs?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'boardsesh-offline-owned-'));
  const location = join(directory, 'owned.db');
  const seed = createTestDatabase(location);
  await configureMainConnection(seed);
  await runMigrations(seed);
  await ensureMutationQueueTable(seed);
  await stampLocalUserId(seed, 'owned-A');
  await seed.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    'checkpoint:owned-proof',
    'original-checkpoint',
  ]);
  const worker = createWriterWorkerDatabase(location, busyTimeoutMs);
  const holder = createTestDatabase(location);
  const http = createScopedHttpFixture();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidations = vi.spyOn(queryClient, 'invalidateQueries');
  const operations = createBrowserHttpOperations({
    captureScope: http.facade.captureRequestView,
    isCurrentView: http.facade.isCurrentView,
    captureResult: http.facade.captureResult,
    captureErrorDelivery: http.facade.captureErrorDelivery,
    resolveClient: (scope, mode) =>
      mode === 'offline' ? http.facade.getOfflineSyncHttpClient(scope) : http.facade.getHttpClient(scope),
  });
  const capture = createOfflineNetworkCapture({
    backendClient: http.backend,
    captureGeneration: () => host.generation,
    isGenerationCurrent: (generation) => generation === host.generation,
    required: () => true,
    captureView: http.facade.captureRequestView,
    isCurrentView: http.facade.isCurrentView,
    prefix: (scope) => http.facade.queryKey([], scope),
    createOperation: (scope) => operations.create(scope, { mode: 'offline' }),
  });
  host.capture = capture;
  const unsubscribe = subscribeMutationDelivery((event) => host.status(event));
  close.push(async () => {
    await holder.execAsync('ROLLBACK').catch(() => {});
    holder.close();
    await worker.close();
    seed.close();
    unsubscribe();
    queryClient.clear();
    http.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  const add = async (index = 1) =>
    enqueue(
      seed,
      'user_favorites',
      'create',
      { boardName: 'kilter', climbUuid: `owned-${index}`, angle: 40 },
      `owned-favorite-${index}`,
    );
  const snapshot = async () => ({
    pending: await seed.getAllAsync('SELECT * FROM pending_mutations ORDER BY id'),
    meta: await seed.getAllAsync('SELECT * FROM sync_meta ORDER BY key'),
  });
  const fallback = vi.fn(async () => {
    throw new Error('Latest-client fallback must not run');
  });
  const drain = (options = {}) =>
    drainMutationQueue(worker.db, queryClient, fallback, {
      isOnline: () => !host.offline,
      maxCycleAttempts: 0,
      ...options,
    });
  http.performFetch.mockImplementation(async () => Response.json({ data: { addFavorite: true } }));
  return {
    ...http,
    operations,
    worker,
    holder,
    seed,
    queryClient,
    invalidations,
    add,
    snapshot,
    fallback,
    drain,
    capture,
  };
}
function reply(kind: 'success' | 'permanent' | 'retryable' | 'exhausted') {
  const retryable = kind === 'retryable' || kind === 'exhausted';
  return kind === 'success'
    ? Response.json({ data: { addFavorite: true } })
    : Response.json(
        {
          errors: [
            {
              message: 'Owned server verdict',
              extensions: { code: retryable ? 'INTERNAL_SERVER_ERROR' : 'BAD_USER_INPUT' },
            },
          ],
        },
        { status: retryable ? 500 : 422 },
      );
}

describe('consumed selected SDK drain with real worker SQLite', () => {
  it('ACKs current owned intent and invalidates only its original scoped cache', async () => {
    const current = await fixture();
    await current.add();
    const scope = current.facade.captureRequestView();
    const prefix = current.facade.queryKey([], scope);
    const ownKey = [...prefix, 'favoriteStatus', 'owned'];
    const otherKey = ['browser-view', 'unowned-view', 'favoriteStatus', 'other'];
    const rawKey = ['favoriteStatus', 'raw-A'];
    for (const key of [ownKey, otherKey, rawKey]) current.queryClient.setQueryData(key, 'cached');
    await current.drain();
    expect((await current.snapshot()).pending).toEqual([]);
    expect(host.status).toHaveBeenCalledOnce();
    expect(current.fallback).not.toHaveBeenCalled();
    expect(current.queryClient.getQueryState(ownKey)?.isInvalidated).toBe(true);
    expect(current.queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
    expect(current.queryClient.getQueryState(rawKey)?.isInvalidated).toBe(false);
  });

  it.each(['success', 'permanent', 'retryable'] as const)(
    'retains a current %s verdict under its actual writer transaction',
    async (kind) => {
      const current = await fixture();
      await current.add();
      current.performFetch.mockResolvedValueOnce(reply(kind));
      await current.drain();
      const rows = (await current.snapshot()).pending as { status: string; retry_count: number }[];
      if (kind === 'success') expect(rows).toEqual([]);
      else if (kind === 'permanent') {
        expect(rows[0].status).toBe('dead_letter');
        expect(rows[0].retry_count).toBe(0);
      } else {
        expect(rows[0].status).toBe('pending');
        expect(rows[0].retry_count).toBe(1);
      }
    },
  );

  for (const verdict of ['success', 'permanent', 'retryable', 'exhausted'] as const) {
    it.each(['B', 'ABA', 'expiry', 'purge', 'background'] as const)(
      `rolls back ${verdict} after a real held writer and %s`,
      async (change) => {
        const current = await fixture();
        await current.add();
        if (verdict === 'exhausted') await current.seed.runAsync('UPDATE pending_mutations SET max_retries = 1');
        const original = await current.snapshot();
        await current.holder.execAsync('BEGIN IMMEDIATE');
        current.performFetch.mockResolvedValueOnce(reply(verdict));
        const pending = current.drain();
        await current.worker.waiting;
        let acquired = false;
        void current.worker.acquired.then(() => {
          acquired = true;
        });
        expect(acquired).toBe(false);
        if (change === 'expiry') {
          current.clock(90_000);
          current.performFetch.mockResolvedValueOnce(Response.json({ data: { viewer: { id: 'owned-A' } } }));
          await current.operations.capture().request('{ viewer { id } }');
          current.clock(120_001);
        } else if (change === 'purge') beginGlobalPurge();
        else if (change === 'background') setBackgrounded(true);
        else {
          current.switchAccount('owned-B');
          if (change === 'ABA') current.switchAccount('owned-A');
        }
        expect(acquired).toBe(false);
        await current.holder.execAsync('COMMIT');
        await pending;
        await current.worker.acquired;
        expect(await current.snapshot()).toEqual(original);
        expect(host.status).not.toHaveBeenCalled();
        expect(host.telemetry).not.toHaveBeenCalled();
        expect(host.report).not.toHaveBeenCalled();
        expect(current.invalidations).not.toHaveBeenCalled();
        expect(current.fallback).not.toHaveBeenCalled();
        expect(current.performFetch).toHaveBeenCalledTimes(change === 'expiry' ? 2 : 1);
      },
    );
  }

  it.each(['success', 'permanent', 'retryable', 'exhausted'] as const)(
    'rolls back an actual %s statement after an awaited write and ABA',
    async (kind) => {
      const current = await fixture();
      await current.add();
      if (kind === 'exhausted') await current.seed.runAsync('UPDATE pending_mutations SET max_retries = 1');
      const original = await current.snapshot();
      current.performFetch.mockResolvedValueOnce(reply(kind));
      const pause = current.worker.pauseAfter(
        kind === 'success' ? /^DELETE FROM pending_mutations/ : /UPDATE pending_mutations/,
      );
      const pending = current.drain();
      await pause.reached;
      current.switchAccount('owned-B');
      current.switchAccount('owned-A');
      pause.release();
      await pending;
      expect(await current.snapshot()).toEqual(original);
      expect(host.status).not.toHaveBeenCalled();
      expect(host.telemetry).not.toHaveBeenCalled();
      expect(current.invalidations).not.toHaveBeenCalled();
    },
  );

  it('keeps offline durable enqueue available without acquiring any network lease', async () => {
    const current = await fixture();
    host.offline = true;
    await current.add();
    await current.drain();
    expect((await current.snapshot()).pending).toHaveLength(1);
    expect(current.issueLease).not.toHaveBeenCalled();
    expect(current.performFetch).not.toHaveBeenCalled();
  });

  it('uses a fresh bounded operation for more than 64 queued writes', async () => {
    const current = await fixture();
    for (let index = 0; index < 65; index++) await current.add(index);
    await current.drain();
    expect((await current.snapshot()).pending).toEqual([]);
    expect(current.performFetch).toHaveBeenCalledTimes(65);
    expect(host.status).toHaveBeenCalledTimes(65);
    expect(current.invalidations.mock.calls.length).toBeLessThanOrEqual(7 * 6);
  });
});

describe('selected drain authority, phase and replay boundaries', () => {
  it.each(['anonymous', 'unavailable', 'wrong-owner'] as const)(
    'holds %s authority without any replacement-client send',
    async (kind) => {
      const current = await fixture();
      await current.add();
      const original = await current.snapshot();
      if (kind === 'anonymous') current.confirmAnonymous();
      else if (kind === 'unavailable')
        current.issueLease.mockResolvedValueOnce(Response.json({ status: 'unavailable' }, { status: 503 }));
      else
        current.issueLease.mockResolvedValueOnce(
          Response.json({
            status: 'admitted',
            token: 'bsbd1_OWNED_WRONG',
            usableForMs: 120_000,
            owner: { ...current.backend.getSnapshot().owner!, userId: 'owned-B' },
          }),
        );
      await current.drain();
      expect(await current.snapshot()).toEqual(original);
      expect(current.performFetch).not.toHaveBeenCalled();
      expect(current.fallback).not.toHaveBeenCalled();
      expect(host.status).not.toHaveBeenCalled();
      expect(host.telemetry).not.toHaveBeenCalled();
    },
  );
  it('captures the purge generation before admission rather than rebaselining afterward', async () => {
    const current = await fixture();
    await current.add();
    const original = await current.snapshot();
    const start = current.capture(async () => 'must-not-be-used');
    beginGlobalPurge();
    await expect(start.resolve()).rejects.toThrow();
    expect(await current.snapshot()).toEqual(original);
    expect(current.issueLease).not.toHaveBeenCalled();
  });
  it.each(['SID', 'version'] as const)('refuses a held writer after the same UID gets a new %s', async (kind) => {
    const current = await fixture();
    await current.add();
    const original = await current.snapshot();
    await current.holder.execAsync('BEGIN IMMEDIATE');
    const pending = current.drain();
    await current.worker.waiting;
    const owner = current.backend.getSnapshot().owner!;
    const replacement = {
      ...owner,
      ...(kind === 'SID'
        ? { authSessionId: 'owned-new-SID' }
        : { cursor: { ...owner.cursor, version: owner.cursor.version + 1 } }),
    };
    current.backend.acceptSession({
      user: { id: owner.userId },
      authSessionId: replacement.authSessionId,
      authGeneration: replacement.generation,
      expires: '2099-01-01T00:00:00Z',
      browserSelection: replacement,
    });
    await current.holder.execAsync('COMMIT');
    await pending;
    expect(await current.snapshot()).toEqual(original);
    expect(host.status).not.toHaveBeenCalled();
    expect(current.performFetch).toHaveBeenCalledOnce();
  });
  it.each(['retry_count', 'max_retries', 'payload'] as const)(
    'does not ACK an intent whose %s changed while waiting',
    async (column) => {
      const current = await fixture();
      await current.add();
      await current.seed.runAsync('UPDATE pending_mutations SET retry_count = 2');
      await current.holder.execAsync('BEGIN IMMEDIATE');
      const pending = current.drain();
      await current.worker.waiting;
      const changed = column === 'payload' ? '{"boardName":"kilter","climbUuid":"new-intent","angle":40}' : 7;
      await current.holder.runAsync(`UPDATE pending_mutations SET ${column} = ?`, [changed]);
      await current.holder.execAsync('COMMIT');
      await pending;
      const row = (await current.snapshot()).pending[0] as Record<string, unknown>;
      expect(row[column]).toBe(changed);
      expect(row.status).toBe('pending');
      expect(host.status).not.toHaveBeenCalled();
      expect(current.invalidations).not.toHaveBeenCalled();
    },
  );
  it('does not spend a strike when reconciliation replays a real local error from another dispatch', async () => {
    const current = await fixture();
    await current.add();
    const original = await current.snapshot();
    const other = { ...(original.pending[0] as PendingMutation), id: 999, payload: '{broken' };
    let prior: unknown;
    try {
      await processMutation(other, async () => {
        throw new Error('Must not send');
      });
    } catch (error) {
      prior = error;
    }
    await current.drain({
      beforeMutationAcknowledged: async () => {
        throw prior;
      },
    });
    expect(await current.snapshot()).toEqual(original);
    expect(current.performFetch).toHaveBeenCalledOnce();
    expect(host.status).not.toHaveBeenCalled();
    expect(host.telemetry).not.toHaveBeenCalled();
  });
  it('checks again between an external status callback and its event publication', async () => {
    const current = await fixture();
    await current.add();
    const callback = vi.fn(() => current.switchAccount('owned-B'));
    await current.drain({ onMutationStatus: callback });
    expect(callback).toHaveBeenCalledOnce();
    expect((await current.snapshot()).pending).toEqual([]);
    expect(host.status).not.toHaveBeenCalled();
    expect(current.invalidations).not.toHaveBeenCalled();
  });
  it('checks again between an external dead-letter callback and its telemetry publication', async () => {
    const current = await fixture();
    await current.add();
    current.performFetch.mockResolvedValueOnce(reply('permanent'));
    const callback = vi.fn(() => current.switchAccount('owned-B'));
    await current.drain({ onMutationDeadLettered: callback });
    expect(callback).toHaveBeenCalledOnce();
    expect((await current.snapshot()).pending).toHaveLength(1);
    expect(host.telemetry).not.toHaveBeenCalled();
    expect(host.report).not.toHaveBeenCalled();
    expect(current.invalidations).not.toHaveBeenCalled();
  });
  it('holds unknown network errors without spending their persistent retry budget', async () => {
    const current = await fixture();
    await current.add();
    const original = await current.snapshot();
    current.performFetch.mockRejectedValueOnce(new Error('Unknown owned transport failure'));
    await current.drain();
    expect(await current.snapshot()).toEqual(original);
    expect(current.performFetch).toHaveBeenCalledOnce();
    expect(host.status).not.toHaveBeenCalled();
    expect(host.telemetry).not.toHaveBeenCalled();
  });
});

describe('selected fallback requires a real pre-execution validation packet', () => {
  it.each(['validation', 'partial-data', 'data-null', 'execution'] as const)(
    'handles %s without mistaking partial execution for safe resend',
    async (kind) => {
      const current = await fixture();
      await current.add();
      await current.seed.runAsync('UPDATE pending_mutations SET table_name = ?, payload = ?', [
        'boardsesh_ticks',
        JSON.stringify({
          uuid: 'owned-tick',
          boardName: 'kilter',
          climbUuid: 'owned-climb',
          angle: 40,
          status: 'send',
          climbRevision: 7,
        }),
      ]);
      const original = await current.snapshot();
      current.performFetch
        .mockResolvedValueOnce(
          Response.json({
            ...(kind === 'partial-data'
              ? { data: { saveTick: { uuid: 'possibly-executed' } } }
              : kind === 'data-null'
                ? { data: null }
                : {}),
            errors: [
              {
                message: 'Field "climbRevision" is not defined by type "SaveTickInput".',
                extensions: { code: kind === 'execution' ? 'INTERNAL_SERVER_ERROR' : 'GRAPHQL_VALIDATION_FAILED' },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(Response.json({ data: { saveTick: { uuid: 'owned-tick' } } }));
      await current.drain();
      if (kind === 'validation') {
        expect((await current.snapshot()).pending).toEqual([]);
        expect(current.performFetch).toHaveBeenCalledTimes(2);
        const second = JSON.parse((current.performFetch.mock.calls[1][1] as RequestInit).body as string) as {
          variables: { input: Record<string, unknown> };
        };
        expect(second.variables.input).not.toHaveProperty('climbRevision');
      } else {
        expect(await current.snapshot()).toEqual(original);
        expect(current.performFetch).toHaveBeenCalledOnce();
        expect(host.status).not.toHaveBeenCalled();
        expect(host.telemetry).not.toHaveBeenCalled();
      }
    },
  );
});

describe('durable owned intent and canonical reconciliation', () => {
  it('holds A for B and lets a newly admitted independent A cycle deliver the same intent', async () => {
    const current = await fixture();
    await current.add();
    const original = await current.snapshot();
    current.switchAccount('owned-B');
    await current.drain();
    expect(await current.snapshot()).toEqual(original);
    expect(current.performFetch).not.toHaveBeenCalled();
    current.switchAccount('owned-A');
    await current.drain();
    expect((await current.snapshot()).pending).toEqual([]);
    expect(current.performFetch).toHaveBeenCalledOnce();
  });
  it('records a current authenticated terminal retry exactly once', async () => {
    const current = await fixture();
    await current.add();
    await current.seed.runAsync('UPDATE pending_mutations SET max_retries = 1');
    current.performFetch.mockResolvedValueOnce(reply('exhausted'));
    await current.drain();
    const row = (await current.snapshot()).pending[0] as { status: string; retry_count: number };
    expect(row).toMatchObject({ status: 'dead_letter', retry_count: 1 });
    expect(host.status).toHaveBeenCalledOnce();
    expect(host.telemetry).toHaveBeenCalledOnce();
  });
  it('keeps genuine owned structural corruption separate from a server error receipt', async () => {
    const current = await fixture();
    await current.add();
    await current.seed.runAsync('UPDATE pending_mutations SET payload = ?', ['{broken']);
    await current.drain();
    expect((await current.snapshot()).pending[0]).toMatchObject({ status: 'dead_letter', retry_count: 0 });
    expect(current.performFetch).not.toHaveBeenCalled();
    expect(current.issueLease).toHaveBeenCalledOnce();
  });
  it.each(['current', 'current-lock-loss', 'ABA-after-climb-write', 'B-during-lock-loss'] as const)(
    'guards canonical spray tables and ACK for %s',
    async (change) => {
      const current = await fixture(change.includes('lock-loss') ? 60 : undefined);
      const settled = vi.fn();
      const unreport = setPullWriteSettledReporter(settled);
      close.push(async () => unreport());
      await current.seed.runAsync(
        'INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, updated_at, sync_seq) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['owned-spray', 'spray', 123, 'Local name', '11', '2026-01-01T00:00:00Z', '1'],
      );
      await markScopeDownloadComplete(current.seed, 'spray:123:123');
      await enqueue(
        current.seed,
        'board_climbs',
        'create',
        { uuid: 'owned-spray', boardType: 'spray', name: 'Local name' },
        'owned-spray-create',
      );
      const original = await current.snapshot();
      current.performFetch
        .mockResolvedValueOnce(Response.json({ data: { saveClimb: { uuid: 'owned-spray' } } }))
        .mockResolvedValueOnce(
          Response.json({
            data: {
              syncClimbDocuments: {
                viewerId: 'owned-A',
                climb: {
                  uuid: 'owned-spray',
                  board_type: 'spray',
                  layout_id: 123,
                  name: 'Canonical name',
                  frames: '11',
                  compatible_size_ids: [123],
                  updated_at: '2026-01-01T00:00:20Z',
                  sync_seq: '100',
                },
                stats: [
                  {
                    board_type: 'spray',
                    climb_uuid: 'owned-spray',
                    angle: 40,
                    display_difficulty: 12,
                    updated_at: '2026-01-01T00:00:20Z',
                    sync_seq: '101',
                  },
                ],
              },
            },
          }),
        );
      const pause = change === 'ABA-after-climb-write' ? current.worker.pauseAfter(/^INSERT INTO board_climbs/) : null;
      if (change.includes('lock-loss')) await current.holder.execAsync('BEGIN IMMEDIATE');
      const pending = current.drain();
      if (change.includes('lock-loss')) {
        await current.worker.waiting;
        await current.worker.lockFailed;
        if (change === 'B-during-lock-loss') current.switchAccount('owned-B');
        else await current.holder.execAsync('COMMIT');
      }
      if (pause) {
        await pause.reached;
        current.switchAccount('owned-B');
        current.switchAccount('owned-A');
        pause.release();
      }
      await pending;
      const climb = await current.seed.getFirstAsync<{ name: string }>('SELECT name FROM board_climbs WHERE uuid = ?', [
        'owned-spray',
      ]);
      if (change === 'current' || change === 'current-lock-loss') {
        expect(climb?.name).toBe('Canonical name');
        expect((await current.snapshot()).pending).toEqual([]);
        expect(
          await current.seed.getFirstAsync('SELECT display_difficulty FROM board_climb_stats WHERE climb_uuid = ?', [
            'owned-spray',
          ]),
        ).toMatchObject({ display_difficulty: 12 });
      } else {
        expect(climb?.name).toBe('Local name');
        expect(await current.snapshot()).toEqual(original);
        expect(
          await current.seed.getAllAsync('SELECT * FROM board_climb_stats WHERE climb_uuid = ?', ['owned-spray']),
        ).toEqual([]);
        expect(host.status).not.toHaveBeenCalled();
        expect(current.invalidations).not.toHaveBeenCalled();
      }
      expect(current.performFetch).toHaveBeenCalledTimes(2);
      if (change.includes('lock-loss')) {
        expect(await current.worker.lockFailed).toBeGreaterThanOrEqual(40);
        if (change === 'B-during-lock-loss') expect(settled).not.toHaveBeenCalled();
        else
          expect(settled).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ site: 'saved-climb-mirror', outcome: 'committed' }),
          );
      }
    },
  );
});

describe('before-await ownership and original fallback causality', () => {
  it('holds a purge that lands during the actual lease issuer await before any queue read', async () => {
    const current = await fixture();
    await current.add();
    const original = await current.snapshot();
    let release!: (response: Response) => void;
    current.issueLease.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const reads = vi.spyOn(current.worker.db, 'getFirstAsync');
    const pending = current.drain();
    await vi.waitFor(() => expect(current.issueLease).toHaveBeenCalledOnce());
    beginGlobalPurge();
    release(
      Response.json({
        status: 'admitted',
        token: 'bsbd1_OWNED_DELAYED',
        usableForMs: 120_000,
        owner: current.backend.getSnapshot().owner,
      }),
    );
    await pending;
    expect(reads).not.toHaveBeenCalled();
    expect(current.performFetch).not.toHaveBeenCalled();
    expect(await current.snapshot()).toEqual(original);
  });
  it('does not resend after the genuine original validation error expires during its own DB await', async () => {
    const current = await fixture();
    await current.add();
    await current.seed.runAsync('UPDATE pending_mutations SET table_name = ?, payload = ?', [
      'boardsesh_ticks',
      JSON.stringify({
        uuid: 'owned-tick',
        boardName: 'kilter',
        climbUuid: 'owned-climb',
        angle: 40,
        status: 'send',
        climbRevision: 7,
      }),
    ]);
    const original = await current.snapshot();
    current.performFetch
      .mockResolvedValueOnce(
        Response.json({
          errors: [
            {
              message: 'Field "climbRevision" is not defined by type "SaveTickInput".',
              extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ data: { viewer: { id: 'owned-A' } } }))
      .mockResolvedValueOnce(Response.json({ data: { saveTick: { uuid: 'forbidden-resend' } } }));
    let ownerReads = 0;
    const originalRead = current.worker.db.getFirstAsync.bind(current.worker.db);
    current.worker.db.getFirstAsync = new Proxy(originalRead, {
      async apply(target, receiver, parameters: unknown[]) {
        const result: unknown = await Reflect.apply(target, receiver, parameters);
        if (
          typeof parameters[0] === 'string' &&
          parameters[0].includes('SELECT value FROM sync_meta') &&
          ++ownerReads === 3
        ) {
          current.clock(90_000);
          await current.operations.capture().request('{ viewer { id } }');
          current.clock(120_001);
        }
        return result;
      },
    });
    await current.drain();
    expect(current.performFetch).toHaveBeenCalledTimes(2);
    expect(await current.snapshot()).toEqual(original);
    expect(host.status).not.toHaveBeenCalled();
    expect(current.invalidations).not.toHaveBeenCalled();
  });
});

let legacyNamespace = 0;
async function legacyFixture(busyTimeoutMs?: number) {
  const current = await fixture(busyTimeoutMs);
  host.legacyToken = 'e30.eyJzdWIiOiJvd25lZC1BIn0.signature';
  let required = false;
  const issueLease = vi.fn(async () => {
    throw new Error('Legacy must not acquire a selected lease');
  });
  const backend = createBrowserBackendClient({
    ready: () => true,
    fetch: issueLease,
    endpoint: '/owned-legacy-lease',
    now: () => 0,
    schedule: () => () => {},
  });
  const legacyFetch = vi.fn(async () => Response.json({ data: { addFavorite: true } }));
  const legacy = new GraphQLClient('https://owned-legacy.test/graphql', { fetch: legacyFetch });
  const facade = createBrowserHttpClientFacade({
    backendClient: backend,
    captureGeneration: () => host.generation,
    isGenerationCurrent: (generation) => generation === host.generation,
    captureIdentity: () => ({ userId: 'owned-A', authSessionId: 'owned-legacy-SID' }),
    confirmedAnonymous: () => false,
    required: () => required,
    namespace: () => `owned_legacy_${++legacyNamespace}`,
    url: 'https://owned-legacy.test/graphql',
    fetch: legacyFetch,
    legacyFetch,
    timeoutMs: () => null,
    clientIdentity: () => 'owned-legacy-test',
    legacy: { get: () => legacy, reset: () => {} },
  });
  const operations = createBrowserHttpOperations({
    captureScope: facade.captureRequestView,
    isCurrentView: facade.isCurrentView,
    captureResult: facade.captureResult,
    captureErrorDelivery: facade.captureErrorDelivery,
    resolveClient: (scope) => facade.getOfflineSyncHttpClient(scope),
  });
  host.capture = createOfflineNetworkCapture({
    backendClient: backend,
    captureGeneration: () => host.generation,
    isGenerationCurrent: (generation) => generation === host.generation,
    required: () => required,
    captureView: facade.captureRequestView,
    isCurrentView: facade.isCurrentView,
    prefix: (scope) => facade.queryKey([], scope),
    createOperation: (scope) => operations.create(scope, { mode: 'offline' }),
  });
  close.push(async () => {
    facade.dispose();
    backend.dispose();
  });
  return {
    ...current,
    issueLegacyLease: issueLease,
    legacyFetch,
    requireSelected: () => {
      required = true;
    },
  };
}
describe('wholly legacy capture remains separate from selected authority', () => {
  it.each(['current', 'required-during-writer'] as const)('preserves original legacy policy for %s', async (change) => {
    const current = await legacyFixture();
    await current.add();
    const original = await current.snapshot();
    if (change === 'required-during-writer') await current.holder.execAsync('BEGIN IMMEDIATE');
    const pending = current.drain();
    if (change === 'required-during-writer') {
      await current.worker.waiting;
      current.requireSelected();
      await current.holder.execAsync('COMMIT');
    }
    await pending;
    expect(current.issueLegacyLease).not.toHaveBeenCalled();
    expect(current.issueLease).not.toHaveBeenCalled();
    expect(current.legacyFetch).toHaveBeenCalledOnce();
    expect(current.fallback).not.toHaveBeenCalled();
    if (change === 'current') expect((await current.snapshot()).pending).toEqual([]);
    else {
      expect(await current.snapshot()).toEqual(original);
      expect(host.status).not.toHaveBeenCalled();
      expect(current.invalidations).not.toHaveBeenCalled();
    }
  });

  it.each(['parse', 'unknown-operation', 'unknown-table', 'reconcile-error'] as const)(
    'retains the original retryable legacy %s classification',
    async (kind) => {
      const current = await legacyFixture();
      await current.add();
      if (kind === 'parse') await current.seed.runAsync('UPDATE pending_mutations SET payload = ?', ['{broken']);
      if (kind === 'unknown-operation')
        await current.seed.runAsync('UPDATE pending_mutations SET operation = ?', ['unknown']);
      if (kind === 'unknown-table')
        await current.seed.runAsync('UPDATE pending_mutations SET table_name = ?', ['unknown']);
      const original = await current.snapshot();
      const reconciliation = vi.fn(async () => {
        throw new Error('Owned legacy reconciliation failed');
      });
      await current.drain(kind === 'reconcile-error' ? { beforeMutationAcknowledged: reconciliation } : {});
      const after = await current.snapshot();
      expect(after.meta).toEqual(original.meta);
      expect(after.pending).toHaveLength(1);
      expect(after.pending[0]).toMatchObject({ status: 'pending', retry_count: 1, max_retries: 10 });
      expect(after.pending[0]).toMatchObject({
        payload: (original.pending[0] as PendingMutation).payload,
        operation: (original.pending[0] as PendingMutation).operation,
        table_name: (original.pending[0] as PendingMutation).table_name,
      });
      expect(current.legacyFetch).toHaveBeenCalledTimes(kind === 'reconcile-error' ? 1 : 0);
      expect(reconciliation).toHaveBeenCalledTimes(kind === 'reconcile-error' ? 1 : 0);
      expect(current.issueLegacyLease).not.toHaveBeenCalled();
      expect(current.issueLease).not.toHaveBeenCalled();
      expect(host.status).not.toHaveBeenCalled();
      expect(host.telemetry).not.toHaveBeenCalled();
    },
  );

  it.each([0, 1])(
    'retries real legacy reconciliation SQLITE_BUSY within the %s cycle budget without a strike',
    async (budget) => {
      const current = await legacyFixture(40);
      await current.add();
      const original = await current.snapshot();
      await current.holder.execAsync('BEGIN IMMEDIATE');
      const reconciliation = vi.fn(async () => {
        await current.worker.db.withExclusiveTransactionAsync((transaction) => beginImmediateWrite(transaction, 40));
      });
      const pending = current.drain({
        maxCycleAttempts: budget,
        baseDelayMs: 1,
        beforeMutationAcknowledged: reconciliation,
      });
      await current.worker.waiting;
      expect(await current.worker.lockFailed).toBeGreaterThanOrEqual(20);
      if (budget) await current.holder.execAsync('COMMIT');
      await pending;
      if (!budget) await current.holder.execAsync('COMMIT');
      expect(current.legacyFetch).toHaveBeenCalledTimes(budget + 1);
      expect(reconciliation).toHaveBeenCalledTimes(budget + 1);
      if (budget) {
        expect((await current.snapshot()).pending).toEqual([]);
        expect(host.status).toHaveBeenCalledOnce();
      } else {
        expect(await current.snapshot()).toEqual(original);
        expect(host.status).not.toHaveBeenCalled();
      }
      expect(host.telemetry).not.toHaveBeenCalled();
      expect(current.issueLegacyLease).not.toHaveBeenCalled();
      expect(current.issueLease).not.toHaveBeenCalled();
    },
  );
});

describe('authentic failure identity cannot authorize a later queued request', () => {
  it.each(['original', 'copied-headers-error'] as const)(
    'holds replay of an %s from an earlier SDK invocation',
    async (kind) => {
      const current = await fixture();
      await current.add();
      const originalRow = await current.snapshot();
      const proof = current.operations.capture({ mode: 'offline' });
      current.performFetch.mockResolvedValueOnce(reply('permanent'));
      let original: unknown;
      try {
        await proof.request('mutation OwnedPrior { ownedPrior }');
      } catch (error) {
        original = error;
      }
      expect(original).toBeInstanceOf(ClientError);
      expect(() => proof.assertErrorDeliveries(original)).not.toThrow();
      const replay =
        kind === 'original'
          ? original
          : new ClientError(
              {
                ...(original as ClientError).response,
                headers: new Headers((original as ClientError).response.headers),
              },
              (original as ClientError).request,
            );
      current.facade.getOfflineSyncHttpClient(proof.scope).requestConfig.requestMiddleware = () => {
        throw replay;
      };
      await current.drain();
      expect(await current.snapshot()).toEqual(originalRow);
      expect(current.performFetch).toHaveBeenCalledOnce();
      expect(host.status).not.toHaveBeenCalled();
      expect(host.telemetry).not.toHaveBeenCalled();
      expect(() => proof.assertErrorDeliveries(original)).not.toThrow();
      proof.dispose();
    },
  );
});

describe('individual failure publications keep their original cause', () => {
  it('rechecks between an owner-refusal callback and the adapter diagnostic', async () => {
    const current = await fixture();
    await current.add();
    await stampLocalUserId(current.seed, 'unowned-B');
    const original = await current.snapshot();
    await current.drain({ onOutboxOwnerRefused: () => current.switchAccount('owned-B') });
    expect(await current.snapshot()).toEqual(original);
    expect(current.performFetch).not.toHaveBeenCalled();
    expect(host.report).not.toHaveBeenCalled();
  });
  it('rechecks between the Sentry and analytics publications of a permanent rejection', async () => {
    const current = await fixture();
    await current.add();
    current.performFetch.mockResolvedValueOnce(reply('permanent'));
    host.report.mockImplementationOnce(() => current.switchAccount('owned-B'));
    await current.drain();
    expect(host.report).toHaveBeenCalledOnce();
    expect(host.telemetry).not.toHaveBeenCalled();
    expect(current.invalidations).not.toHaveBeenCalled();
  });
});

describe('actual subscribed delivery fanout retains the original selected cause', () => {
  it.each(['B', 'ABA', 'expiry'] as const)(
    'stops later listeners and error reporting after the first listener retires by %s',
    async (change) => {
      const current = await fixture();
      await current.add();
      const first = vi.fn(() => {
        if (change === 'expiry') current.clock(200_000);
        else {
          current.switchAccount('owned-B');
          if (change === 'ABA') current.switchAccount('owned-A');
        }
      });
      const later = vi.fn();
      const unsubscribeFirst = subscribeMutationDelivery(first);
      const unsubscribeLater = subscribeMutationDelivery(later);
      close.push(async () => {
        unsubscribeFirst();
        unsubscribeLater();
      });
      await current.drain();
      expect((await current.snapshot()).pending).toEqual([]);
      expect(host.status).toHaveBeenCalledOnce();
      expect(first).toHaveBeenCalledOnce();
      expect(later).not.toHaveBeenCalled();
      expect(host.report).not.toHaveBeenCalled();
      expect(host.telemetry).not.toHaveBeenCalled();
      expect(current.invalidations).not.toHaveBeenCalled();
    },
  );

  it.each(['B', 'ABA', 'expiry'] as const)(
    'does not publish a listener failure after the throwing listener retires by %s',
    async (change) => {
      const current = await fixture();
      await current.add();
      const first = vi.fn(() => {
        if (change === 'expiry') current.clock(200_000);
        else {
          current.switchAccount('owned-B');
          if (change === 'ABA') current.switchAccount('owned-A');
        }
        throw new Error('Owned first-listener failure');
      });
      const later = vi.fn();
      const unsubscribeFirst = subscribeMutationDelivery(first);
      const unsubscribeLater = subscribeMutationDelivery(later);
      close.push(async () => {
        unsubscribeFirst();
        unsubscribeLater();
      });
      await current.drain();
      expect((await current.snapshot()).pending).toEqual([]);
      expect(first).toHaveBeenCalledOnce();
      expect(later).not.toHaveBeenCalled();
      expect(host.report).not.toHaveBeenCalled();
      expect(host.telemetry).not.toHaveBeenCalled();
      expect(current.invalidations).not.toHaveBeenCalled();
    },
  );

  it('reports a current listener failure and continues to another current listener', async () => {
    const current = await fixture();
    await current.add();
    const failure = new Error('Owned current-listener failure');
    const unsubscribeFirst = subscribeMutationDelivery(() => {
      throw failure;
    });
    const later = vi.fn();
    const unsubscribeLater = subscribeMutationDelivery(later);
    close.push(async () => {
      unsubscribeFirst();
      unsubscribeLater();
    });
    await current.drain();
    expect((await current.snapshot()).pending).toEqual([]);
    expect(host.report).toHaveBeenCalledExactlyOnceWith(
      failure,
      expect.objectContaining({
        tags: { source: 'offline-sync', kind: 'mutation-status-listener' },
      }),
    );
    expect(later).toHaveBeenCalledOnce();
    expect(host.telemetry).not.toHaveBeenCalled();
    expect(current.invalidations).toHaveBeenCalled();
  });

  it('stops after a listener error reporter switches account and throws', async () => {
    const current = await fixture();
    await current.add();
    const unsubscribeFirst = subscribeMutationDelivery(() => {
      throw new Error('Owned listener failure');
    });
    const later = vi.fn();
    const unsubscribeLater = subscribeMutationDelivery(later);
    close.push(async () => {
      unsubscribeFirst();
      unsubscribeLater();
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    close.push(async () => warning.mockRestore());
    host.report.mockImplementationOnce(() => {
      current.switchAccount('owned-B');
      throw new Error('Owned reporter failure');
    });
    await current.drain();
    expect((await current.snapshot()).pending).toEqual([]);
    expect(host.report).toHaveBeenCalledOnce();
    expect(later).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    expect(host.telemetry).not.toHaveBeenCalled();
    expect(current.invalidations).not.toHaveBeenCalled();
  });
});
