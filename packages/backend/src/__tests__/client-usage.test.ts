import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { mockCaptureBackendEvent, mockLoggerInfo } = vi.hoisted(() => ({
  mockCaptureBackendEvent: vi.fn(() => true),
  mockLoggerInfo: vi.fn(),
}));

vi.mock('../services/analytics/posthog', () => ({ captureBackendEvent: mockCaptureBackendEvent }));
vi.mock('../utils/logger', () => ({
  logger: { info: mockLoggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  CLIENT_USAGE_FLUSH_INTERVAL_MS,
  CLIENT_USAGE_MAX_TRACKED_BUCKETS,
  CLIENT_USAGE_OVERFLOW_CLIENT,
  CLIENT_USAGE_REPORTED_BUCKETS,
  flushClientUsage,
  getClientUsageSnapshotForTests,
  recordClientOperation,
  recordContextOperation,
  resolveClientIdentity,
  startClientUsageReporter,
  stopClientUsageReporter,
} from '../services/client-usage';

const mobileIdentity = { name: 'boardsesh-mobile', version: '2.6.0', platform: 'ios', build: '45' };

type LoggedSummary = {
  buckets: { clientName: string; clientVersion: string; transport: string; operations: number }[];
  droppedBuckets: number;
  totalOperations: number;
};

function summaryCalls(): LoggedSummary[] {
  return mockLoggerInfo.mock.calls
    .filter(([message]) => message === '[client-usage] per-minute summary')
    .map(([, summary]) => summary as LoggedSummary);
}

describe('client usage reporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    stopClientUsageReporter();
  });

  afterEach(() => {
    stopClientUsageReporter();
    vi.useRealTimers();
  });

  it('flushes one summary line and one analytics event per bucket every minute', () => {
    startClientUsageReporter();
    recordClientOperation(mobileIdentity, 'http');
    recordClientOperation(mobileIdentity, 'http');
    recordClientOperation(mobileIdentity, 'ws');
    recordClientOperation(undefined, 'http');

    vi.advanceTimersByTime(CLIENT_USAGE_FLUSH_INTERVAL_MS - 1);
    expect(summaryCalls()).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(summaryCalls()).toEqual([
      {
        buckets: [
          { clientName: 'boardsesh-mobile', clientVersion: '2.6.0', transport: 'http', operations: 2 },
          { clientName: 'boardsesh-mobile', clientVersion: '2.6.0', transport: 'ws', operations: 1 },
          { clientName: 'unknown', clientVersion: 'unknown', transport: 'http', operations: 1 },
        ],
        droppedBuckets: 0,
        totalOperations: 4,
      },
    ]);
    expect(mockCaptureBackendEvent).toHaveBeenCalledTimes(3);
    expect(mockCaptureBackendEvent).toHaveBeenCalledWith('Client Usage Summary', {
      systemDistinctId: 'system:client-usage',
      properties: { client_name: 'boardsesh-mobile', client_version: '2.6.0', transport: 'http', operations: 2 },
    });
    expect(getClientUsageSnapshotForTests()).toEqual([]);
  });

  it('skips the flush entirely when no operation was counted', () => {
    startClientUsageReporter();
    vi.advanceTimersByTime(CLIENT_USAGE_FLUSH_INTERVAL_MS * 3);

    expect(summaryCalls()).toHaveLength(0);
    expect(mockCaptureBackendEvent).not.toHaveBeenCalled();
  });

  it('resets counters between minutes', () => {
    startClientUsageReporter();
    recordClientOperation(mobileIdentity, 'http');
    vi.advanceTimersByTime(CLIENT_USAGE_FLUSH_INTERVAL_MS);
    recordClientOperation(mobileIdentity, 'http');
    vi.advanceTimersByTime(CLIENT_USAGE_FLUSH_INTERVAL_MS);

    expect(summaryCalls().map((summary) => summary.totalOperations)).toEqual([1, 1]);
  });

  it('reports only the busiest buckets and counts the rest as dropped', () => {
    const bucketCount = CLIENT_USAGE_REPORTED_BUCKETS + 5;
    for (let index = 0; index < bucketCount; index += 1) {
      for (let repeat = 0; repeat <= index; repeat += 1) {
        recordClientOperation({ name: 'boardsesh-mobile', version: `1.0.${index}` }, 'http');
      }
    }

    flushClientUsage();

    const [summary] = summaryCalls();
    expect(summary.buckets).toHaveLength(CLIENT_USAGE_REPORTED_BUCKETS);
    expect(summary.droppedBuckets).toBe(5);
    expect(summary.buckets[0]).toMatchObject({ clientVersion: `1.0.${bucketCount - 1}`, operations: bucketCount });
    expect(mockCaptureBackendEvent).toHaveBeenCalledTimes(CLIENT_USAGE_REPORTED_BUCKETS);
  });

  it('folds new keys into an overflow bucket once the tracked-bucket cap is reached', () => {
    for (let index = 0; index < CLIENT_USAGE_MAX_TRACKED_BUCKETS; index += 1) {
      recordClientOperation({ name: 'spammy', version: `0.0.${index}` }, 'http');
    }
    recordClientOperation({ name: 'spammy', version: 'one-more' }, 'http');
    recordClientOperation({ name: 'spammy', version: 'and-another' }, 'http');
    // An existing key keeps counting in its own bucket.
    recordClientOperation({ name: 'spammy', version: '0.0.0' }, 'http');

    const snapshot = getClientUsageSnapshotForTests();
    expect(snapshot).toHaveLength(CLIENT_USAGE_MAX_TRACKED_BUCKETS + 1);
    expect(snapshot.find((bucket) => bucket.clientName === CLIENT_USAGE_OVERFLOW_CLIENT)).toEqual({
      clientName: CLIENT_USAGE_OVERFLOW_CLIENT,
      clientVersion: CLIENT_USAGE_OVERFLOW_CLIENT,
      transport: 'http',
      operations: 2,
    });
    expect(snapshot.find((bucket) => bucket.clientVersion === '0.0.0')?.operations).toBe(2);
  });

  it('uses the context transport and falls back when it is missing', () => {
    recordContextOperation({ clientIdentity: mobileIdentity, transport: 'ws' }, 'http');
    recordContextOperation({ clientIdentity: mobileIdentity }, 'http');

    expect(getClientUsageSnapshotForTests()).toEqual([
      { clientName: 'boardsesh-mobile', clientVersion: '2.6.0', transport: 'ws', operations: 1 },
      { clientName: 'boardsesh-mobile', clientVersion: '2.6.0', transport: 'http', operations: 1 },
    ]);
  });

  it('stops flushing after stopClientUsageReporter', () => {
    startClientUsageReporter();
    recordClientOperation(mobileIdentity, 'http');
    stopClientUsageReporter();
    vi.advanceTimersByTime(CLIENT_USAGE_FLUSH_INTERVAL_MS * 2);

    expect(summaryCalls()).toHaveLength(0);
  });
});

describe('resolveClientIdentity', () => {
  it('returns nothing for non-string or blank values', () => {
    expect(resolveClientIdentity(undefined)).toEqual({});
    expect(resolveClientIdentity(42)).toEqual({});
    expect(resolveClientIdentity({ name: 'boardsesh-web' })).toEqual({});
    expect(resolveClientIdentity('   ')).toEqual({});
  });

  it('parses a valid value and keeps the trimmed raw string', () => {
    expect(resolveClientIdentity(' boardsesh-web/1.4.2 ')).toEqual({
      clientIdentity: { name: 'boardsesh-web', version: '1.4.2' },
      clientIdentityRaw: 'boardsesh-web/1.4.2',
    });
  });
});
