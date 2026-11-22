import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsChange } from '../../settings/hooks';
import { SHARED_EVENTS } from '@boardsesh/analytics';

const fixture = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  listeners: new Set<(change: SettingsChange) => void>(),
  track: vi.fn(),
  uuid: 0,
  writeFails: false,
  measurement: vi.fn(
    (): { databaseBytes: number; artifactBytes: number; photoBytes: number; totalBytes: number } | null => ({
      databaseBytes: 100,
      artifactBytes: 200,
      photoBytes: 30,
      totalBytes: 330,
    }),
  ),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => `random-${++fixture.uuid}` }));
vi.mock('../../settings/hooks', () => ({
  getSetting: (key: string) => fixture.settings.get(key),
  setSetting: (key: string, setting: unknown) => {
    if (fixture.writeFails) throw new Error('storage unavailable');
    fixture.settings.set(key, setting);
    for (const listener of fixture.listeners) listener({ kind: 'setting', key } as SettingsChange);
  },
  subscribeSettings: (listener: (change: SettingsChange) => void) => {
    fixture.listeners.add(listener);
    return () => fixture.listeners.delete(listener);
  },
}));
vi.mock('../../lib/analytics', () => ({ track: fixture.track }));
vi.mock('../../lib/release-context', () => ({
  readMobileReleaseContext: () => ({
    updateId: 'eligible-ota',
    runtimeVersion: 'eligible-runtime',
    isEmbeddedLaunch: false,
    branch: 'production',
    channel: 'production',
  }),
}));
vi.mock('../download-storage-measurement', () => ({ measureOfflineDownloadStorage: fixture.measurement }));

import { setSetting } from '../../settings/hooks';
import {
  clearDownloadRequestAttribution,
  downloadFunnelProperties,
  downloadRequestProperties,
  downloadTransferProperties,
  getDownloadRequestContext,
  observeDownloadScope,
  recordDownloadCompleted,
  recordDownloadRequests,
  recordDownloadStarted,
  sampleDownloadStorage,
} from '../download-request-telemetry';

const scopeKey = 'kilter:1:10';
const options = { trigger: 'auto-download-all', source: 'more' };
function events(name: string): Record<string, unknown>[] {
  return fixture.track.mock.calls
    .filter(([event]) => event === name)
    .map(([, properties]) => properties as Record<string, unknown>);
}
function request(scopes: string[] = [scopeKey]) {
  setSetting('syncEnabledBoards', scopes);
  recordDownloadRequests(scopes, options);
  const context = getDownloadRequestContext(scopes[0]);
  if (!context) throw new Error('request context missing');
  return context;
}

beforeEach(() => {
  fixture.settings.clear();
  fixture.settings.set('syncEnabledBoards', []);
  fixture.settings.set('offlineDownloadRequestsV1', {});
  fixture.writeFails = false;
  fixture.uuid = 0;
  fixture.track.mockReset();
  fixture.measurement.mockClear();
  fixture.measurement.mockReturnValue({ databaseBytes: 100, artifactBytes: 200, photoBytes: 30, totalBytes: 330 });
  clearDownloadRequestAttribution();
});

describe('download request attribution', () => {
  it('records every unique requested scope before any sync and samples one batch', () => {
    const context = request([scopeKey, scopeKey, 'tension:2:11']);
    const requested = events(SHARED_EVENTS.OfflineBoardDownloadRequested);
    expect(requested).toHaveLength(2);
    expect(requested[0]).toMatchObject({
      ...context,
      requestedScopeCount: 2,
      trigger: 'auto-download-all',
      ota_update_id: 'eligible-ota',
    });
    expect(requested[1].batchId).toBe(context.batchId);
    expect(requested[1].requestId).not.toBe(context.requestId);
    expect(events(SHARED_EVENTS.OfflineDownloadStorageSampled)).toHaveLength(1);
  });

  it('reads persisted attribution for later calls and does not count retry as another request', () => {
    const context = request();
    recordDownloadRequests([scopeKey], { trigger: 'retry', source: 'manage' });
    recordDownloadStarted(scopeKey, context);
    expect(getDownloadRequestContext(scopeKey)).toEqual(context);
    expect(downloadRequestProperties(scopeKey, context)).toMatchObject({ trigger: 'auto-download-all' });
    expect(events(SHARED_EVENTS.OfflineBoardDownloadRequested)).toHaveLength(1);
  });

  it('keeps bulk correlation separate from operational request and attempt IDs', () => {
    const bulk = request();
    const properties = {
      requestId: 'operational-request',
      attemptId: 'operational-attempt',
      ...downloadFunnelProperties(scopeKey, bulk),
    };
    expect(properties).toMatchObject({
      requestId: 'operational-request',
      attemptId: 'operational-attempt',
      bulkRequestId: bulk.requestId,
      batchId: bulk.batchId,
    });
  });

  it('resolves cached data without inventing a download start', () => {
    const context = request();
    observeDownloadScope({ scopeKey, complete: true, downloadRequest: context });
    observeDownloadScope({ scopeKey, complete: true, downloadRequest: context });
    expect(events(SHARED_EVENTS.OfflineBoardDownloadRequestResolved)).toEqual([
      expect.objectContaining({
        requestId: context.requestId,
        outcome: 'already_available',
        resolvedAt: expect.any(String),
      }),
    ]);
  });

  it('observes a committed completion after a restart without backdating it', () => {
    const context = request();
    recordDownloadStarted(scopeKey, context);
    const observedAfter = Date.now();
    observeDownloadScope({ scopeKey, complete: true, downloadRequest: context });
    const [resolved] = events(SHARED_EVENTS.OfflineBoardDownloadRequestResolved);
    expect(resolved.outcome).toBe('completed');
    expect(Date.parse(resolved.resolvedAt as string)).toBeGreaterThanOrEqual(observedAfter);
  });

  it('starts resumed work once per request even when the legacy Started marker survived', () => {
    const previous = request();
    fixture.settings.set('syncEnabledBoards', []);
    setSetting('syncEnabledBoards', [scopeKey]);
    recordDownloadRequests([scopeKey], { ...options, replaceDisabled: true });
    const current = getDownloadRequestContext(scopeKey);
    if (!current) throw new Error('re-enabled request missing');
    observeDownloadScope({ scopeKey, complete: false, downloadRequest: current });
    observeDownloadScope({ scopeKey, complete: false, downloadRequest: current });
    recordDownloadStarted(scopeKey, current);
    expect(events(SHARED_EVENTS.OfflineBoardDownloadRequestStarted)).toEqual([
      expect.objectContaining({ requestId: current.requestId }),
    ]);
    recordDownloadCompleted(scopeKey, previous);
    recordDownloadCompleted(scopeKey, current);
    expect(events(SHARED_EVENTS.OfflineBoardDownloadRequestResolved)).toContainEqual(
      expect.objectContaining({ requestId: current.requestId, outcome: 'completed' }),
    );
  });

  it('cancels before start and gives re-enabled cached data a new request identity', () => {
    const first = request();
    setSetting('syncEnabledBoards', []);
    expect(events(SHARED_EVENTS.OfflineBoardDownloadRequestResolved)).toContainEqual(
      expect.objectContaining({ requestId: first.requestId, outcome: 'cancelled' }),
    );
    expect(getDownloadRequestContext(scopeKey)).toBeUndefined();
    const second = request();
    expect(second.requestId).not.toBe(first.requestId);
    recordDownloadCompleted(scopeKey, first);
    expect(events(SHARED_EVENTS.OfflineBoardDownloadRequestResolved)).toHaveLength(1);
    recordDownloadCompleted(scopeKey, second);
    expect(events(SHARED_EVENTS.OfflineBoardDownloadRequestResolved)).toHaveLength(2);
  });

  it('replaces an old request after a crash persisted disable without ledger cleanup', () => {
    const previous = request();
    // Model process death between the durable preference and the subscriber.
    fixture.settings.set('syncEnabledBoards', []);
    setSetting('syncEnabledBoards', [scopeKey]);
    recordDownloadRequests([scopeKey], { ...options, replaceDisabled: true });
    const next = getDownloadRequestContext(scopeKey);
    expect(next?.requestId).not.toBe(previous.requestId);
    expect(events(SHARED_EVENTS.OfflineBoardDownloadRequested)).toHaveLength(2);
    expect(events(SHARED_EVENTS.OfflineBoardDownloadRequestResolved)).toContainEqual(
      expect.objectContaining({ requestId: previous.requestId, outcome: 'cancelled' }),
    );
    recordDownloadCompleted(scopeKey, previous);
    expect(events(SHARED_EVENTS.OfflineBoardDownloadRequestResolved)).toHaveLength(1);
  });

  it('removes completed scope attribution on disable so a new request is measurable', () => {
    const first = request();
    recordDownloadCompleted(scopeKey, first);
    setSetting('syncEnabledBoards', []);
    const second = request();
    expect(second.requestId).not.toBe(first.requestId);
    expect(events(SHARED_EVENTS.OfflineBoardDownloadRequestResolved)).toHaveLength(1);
  });

  it('does not attach an old account or batch to late callbacks', () => {
    const first = request();
    clearDownloadRequestAttribution();
    const second = request();
    recordDownloadCompleted(scopeKey, first);
    expect(downloadRequestProperties(scopeKey, first)).toEqual({});
    expect(downloadTransferProperties(first)).toEqual({});
    expect(downloadRequestProperties(scopeKey, { ...second, batchId: 'other-batch' })).toEqual({});
    const samples = events(SHARED_EVENTS.OfflineDownloadStorageSampled).length;
    sampleDownloadStorage(first, 'late-transfer');
    expect(events(SHARED_EVENTS.OfflineDownloadStorageSampled)).toHaveLength(samples);
    expect(events(SHARED_EVENTS.OfflineBoardDownloadRequestResolved)).toHaveLength(0);
  });

  it('does not resolve pending requests or decorate legacy uncorrelated events', () => {
    request();
    observeDownloadScope({ scopeKey, complete: false });
    recordDownloadCompleted(scopeKey);
    expect(downloadRequestProperties(scopeKey)).toEqual({});
    expect(events(SHARED_EVENTS.OfflineBoardDownloadRequestResolved)).toHaveLength(0);
  });

  it('keeps the download flow usable when persistence or analytics throws', () => {
    fixture.writeFails = true;
    expect(() => recordDownloadRequests([scopeKey], options)).not.toThrow();
    expect(events(SHARED_EVENTS.OfflineBoardDownloadRequested)).toHaveLength(0);
    fixture.writeFails = false;
    fixture.track.mockImplementation(() => {
      throw new Error('SDK unavailable');
    });
    expect(() => request()).not.toThrow();
    expect(getDownloadRequestContext(scopeKey)).toBeDefined();
    expect(clearDownloadRequestAttribution).not.toThrow();
  });

  it('quarantines prior attribution when account cleanup cannot write', () => {
    const previous = request();
    fixture.writeFails = true;
    clearDownloadRequestAttribution();
    expect(getDownloadRequestContext(scopeKey)).toBeUndefined();
    expect(downloadRequestProperties(scopeKey, previous)).toEqual({});
    fixture.writeFails = false;
    const current = request();
    expect(current.requestId).not.toBe(previous.requestId);
  });

  it('reports unknown storage and never presents a lifecycle sample as the peak', () => {
    fixture.measurement.mockReturnValue(null);
    request();
    expect(events(SHARED_EVENTS.OfflineDownloadStorageSampled)).toEqual([
      expect.objectContaining({ measurementAvailable: false, peakCoverage: 'incomplete' }),
    ]);
    expect(events(SHARED_EVENTS.OfflineDownloadStorageSampled)[0]).not.toHaveProperty('totalBytes');
  });
});
