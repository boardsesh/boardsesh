import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  createFails: false,
  readFails: false,
  writeFails: false,
  uuidFails: false,
  nextId: 0,
  track: vi.fn(),
  writes: vi.fn(),
  reads: vi.fn(),
}));

vi.mock('react-native-mmkv', () => ({
  createMMKV: vi.fn(() => {
    if (mocks.createFails) throw new Error('native storage unavailable');
    return {
      getString: (key: string) => {
        mocks.reads(key);
        if (mocks.readFails) throw new Error('read failed');
        return mocks.storage.get(key);
      },
      set: (key: string, serialized: string) => {
        mocks.writes(key, serialized);
        if (mocks.writeFails) throw new Error('write failed');
        mocks.storage.set(key, serialized);
      },
      remove: (key: string) => {
        mocks.writes(key);
        if (mocks.writeFails) throw new Error('remove failed');
        mocks.storage.delete(key);
      },
    };
  }),
}));
vi.mock('expo-crypto', () => ({
  randomUUID: () => {
    if (mocks.uuidFails) throw new Error('crypto unavailable');
    mocks.nextId += 1;
    return `request-${mocks.nextId}`;
  },
}));
vi.mock('@boardsesh/analytics', () => ({
  SHARED_EVENTS: { OfflineBoardDownloadLifecycle: 'Offline Board Download Lifecycle' },
}));
vi.mock('../../lib/analytics', () => ({ track: mocks.track }));

import {
  __resetDownloadLifecycleMemoryForTests,
  getDownloadRequest,
  getDownloadRequests,
  requestDownload,
  resetDownloadLifecycle,
  setDownloadLifecycleOwner,
  transitionDownload,
} from '../download-lifecycle';

const KILTER = 'kilter:1:10';
const TENSION = 'tension:9:1';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-21T12:00:00Z'));
  mocks.storage.clear();
  mocks.createFails = false;
  mocks.readFails = false;
  mocks.writeFails = false;
  mocks.uuidFails = false;
  mocks.nextId = 0;
  mocks.track.mockReset();
  mocks.writes.mockClear();
  mocks.reads.mockClear();
  __resetDownloadLifecycleMemoryForTests();
  setDownloadLifecycleOwner('climber-a');
});

afterEach(() => vi.useRealTimers());

describe('durable download requests', () => {
  it('records a requested scope before any engine attempt exists', () => {
    const request = requestDownload(KILTER, 'download-all');

    expect(request).toEqual({
      scopeKey: KILTER,
      requestId: 'request-1',
      requestedAt: Date.now(),
      trigger: 'download-all',
      origin: 'requested',
      state: 'requested',
    });
    expect(mocks.track).toHaveBeenCalledWith('Offline Board Download Lifecycle', request);
    expect(getDownloadRequests()).toEqual([request]);
  });

  it('deduplicates sibling board enables and explicit retry taps', () => {
    const request = requestDownload(KILTER, 'toggle');
    const storedBeforeRetry = mocks.storage.get('requests');

    expect(requestDownload(KILTER, 'download-all')).toEqual(request);
    expect(requestDownload(KILTER, 'retry')).toEqual(request);
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.writes).toHaveBeenCalledTimes(1);
    expect(mocks.storage.get('requests')).toBe(storedBeforeRetry);
  });

  it('retains request and attempt context through a cold launch', () => {
    const request = requestDownload(KILTER, 'toggle');
    transitionDownload({ ...request, attemptId: 'attempt-1' }, 'paused', { reason: 'background' });
    __resetDownloadLifecycleMemoryForTests();
    setDownloadLifecycleOwner('climber-a');

    expect(getDownloadRequest(KILTER)).toMatchObject({
      requestId: request.requestId,
      requestedAt: request.requestedAt,
      state: 'paused',
      attemptId: 'attempt-1',
      reason: 'background',
    });
    expect(requestDownload(KILTER, 'retry').requestId).toBe(request.requestId);
    expect(mocks.track).toHaveBeenCalledTimes(2);
  });

  it('marks legacy recovery without inventing an original request timestamp or event', () => {
    const request = requestDownload(KILTER, 'unknown', 'recovered');

    expect(request).toMatchObject({ origin: 'recovered', requestedAt: null, state: 'recovered' });
    expect(mocks.track).toHaveBeenCalledWith(
      'Offline Board Download Lifecycle',
      expect.objectContaining({ origin: 'recovered', requestedAt: null, state: 'recovered' }),
    );
    expect(mocks.track.mock.calls.some(([, properties]) => properties.state === 'requested')).toBe(false);
  });

  it('returns copies so callers cannot alter the ledger or captured identity', () => {
    const request = requestDownload(KILTER, 'toggle');
    request.requestId = 'changed-by-caller';
    const requestFromList = getDownloadRequests()[0];
    requestFromList.requestId = 'changed-by-list-consumer';
    const requestFromGetter = getDownloadRequest(KILTER);
    if (requestFromGetter) requestFromGetter.state = 'completed';

    expect(getDownloadRequest(KILTER)).toMatchObject({ requestId: 'request-1', state: 'requested' });
  });
});

describe('scope-generation transitions', () => {
  it('deduplicates repeated observations but keeps separate work attempts', () => {
    const request = requestDownload(KILTER, 'toggle');
    transitionDownload({ ...request, attemptId: 'attempt-1' }, 'deferred', { reason: 'network' });
    const writeCount = mocks.writes.mock.calls.length;
    transitionDownload({ ...request, attemptId: 'attempt-1' }, 'deferred', { reason: 'network' });
    expect(mocks.writes).toHaveBeenCalledTimes(writeCount);

    transitionDownload({ ...request, attemptId: 'attempt-2' }, 'deferred', { reason: 'network' });
    expect(mocks.track).toHaveBeenCalledTimes(3);
    expect(getDownloadRequest(KILTER)?.attemptId).toBe('attempt-2');
  });

  it('keeps a request open across retryable errors, pauses and resumed paging', () => {
    const request = requestDownload(KILTER, 'toggle');
    transitionDownload({ ...request, attemptId: 'attempt-1' }, 'started');
    transitionDownload(request, 'deferred', { reason: 'snapshot-exhausted', stage: 'download' });
    transitionDownload(request, 'paused', { reason: 'background' });
    transitionDownload({ ...request, attemptId: 'attempt-2' }, 'resumed', { stage: 'board_data' });

    expect(getDownloadRequest(KILTER)).toMatchObject({
      requestId: request.requestId,
      state: 'resumed',
      attemptId: 'attempt-2',
      stage: 'board_data',
    });
    transitionDownload(request, 'completed', { completionSource: 'download' });
    expect(getDownloadRequest(KILTER)).toBeUndefined();
    expect(mocks.track).toHaveBeenLastCalledWith(
      'Offline Board Download Lifecycle',
      expect.objectContaining({ state: 'completed', completionSource: 'download' }),
    );
  });

  it.each(['completed', 'abandoned', 'failed'] as const)('prunes %s requests and ignores late callbacks', (state) => {
    const request = requestDownload(KILTER, 'toggle');
    transitionDownload(request, state);
    transitionDownload(request, state);
    transitionDownload(request, 'started');
    __resetDownloadLifecycleMemoryForTests();

    expect(getDownloadRequests()).toEqual([]);
    expect(mocks.storage.has('requests')).toBe(false);
    expect(mocks.track).toHaveBeenCalledTimes(2);
  });

  it('prevents the old generation from completing a re-enabled request', () => {
    const previous = requestDownload(KILTER, 'toggle');
    transitionDownload(previous, 'abandoned', { reason: 'disabled' });
    const replacement = requestDownload(KILTER, 'toggle');
    transitionDownload(previous, 'completed');

    expect(replacement.requestId).not.toBe(previous.requestId);
    expect(getDownloadRequest(KILTER)).toEqual(replacement);
    expect(mocks.track).toHaveBeenCalledTimes(3);
  });

  it('clears all accounts without emitting another climber’s abandonment', () => {
    const previous = requestDownload(KILTER, 'toggle');
    requestDownload(TENSION, 'toggle');
    resetDownloadLifecycle();
    const replacement = requestDownload(KILTER, 'toggle');
    transitionDownload(previous, 'completed');

    expect(getDownloadRequests()).toEqual([replacement]);
    expect(mocks.track).toHaveBeenCalledTimes(3);
  });

  it('reports cached completion without fabricating a Started attempt', () => {
    const request = requestDownload(KILTER, 'toggle');
    transitionDownload(request, 'completed', { completionSource: 'cached' });

    expect(mocks.track.mock.calls.map(([, properties]) => properties.state)).toEqual(['requested', 'completed']);
    expect(mocks.track).toHaveBeenLastCalledWith(
      'Offline Board Download Lifecycle',
      expect.objectContaining({ completionSource: 'cached' }),
    );
  });
});

describe('best-effort bookkeeping', () => {
  it.each(['createFails', 'readFails', 'writeFails'] as const)('continues in memory when %s', (failure) => {
    mocks[failure] = true;
    __resetDownloadLifecycleMemoryForTests();
    setDownloadLifecycleOwner('climber-a');
    const request = requestDownload(KILTER, 'toggle');

    expect(requestDownload(KILTER, 'retry').requestId).toBe(request.requestId);
    expect(() => transitionDownload(request, 'started')).not.toThrow();
    expect(getDownloadRequest(KILTER)?.state).toBe('started');
    expect(() => transitionDownload(request, 'completed')).not.toThrow();
    expect(getDownloadRequests()).toEqual([]);
  });

  it('does not turn analytics rejection into a download error or replay it later', () => {
    mocks.track.mockImplementation(() => {
      throw new Error('analytics rejected');
    });
    const request = requestDownload(KILTER, 'toggle');
    expect(() => transitionDownload(request, 'completed')).not.toThrow();
    __resetDownloadLifecycleMemoryForTests();

    expect(getDownloadRequests()).toEqual([]);
    expect(mocks.track).toHaveBeenCalledTimes(2);
  });

  it('uses correlation-only fallback IDs when native crypto fails', () => {
    mocks.uuidFails = true;
    const first = requestDownload(KILTER, 'toggle');
    const second = requestDownload(TENSION, 'toggle');

    expect(first.requestId).not.toBe(second.requestId);
    expect(first.requestId).toMatch(/^download-/);
  });

  it('ignores corrupt persisted records instead of claiming them as requests', () => {
    mocks.storage.set(
      'requests',
      JSON.stringify({
        ownerId: 'climber-a',
        requests: {
          [KILTER]: { requestId: 'bad-record', scopeKey: KILTER, state: 'started' },
          [TENSION]: { requestId: 'terminal', scopeKey: TENSION, state: 'completed' },
        },
      }),
    );
    __resetDownloadLifecycleMemoryForTests();
    setDownloadLifecycleOwner('climber-a');

    expect(getDownloadRequests()).toEqual([]);
    expect(requestDownload(KILTER, 'toggle').requestId).toBe('request-1');
  });
});

describe('persisted account ownership', () => {
  it('restores only the bound account after a cold launch and keeps snapshot getters free of I/O', () => {
    const request = requestDownload(KILTER, 'toggle');
    transitionDownload({ ...request, attemptId: 'previous-attempt' }, 'paused', { reason: 'background' });
    __resetDownloadLifecycleMemoryForTests();
    mocks.reads.mockClear();
    mocks.track.mockClear();

    expect(getDownloadRequests()).toEqual([]);
    expect(getDownloadRequest(KILTER)).toBeUndefined();
    expect(mocks.reads).not.toHaveBeenCalled();
    setDownloadLifecycleOwner('climber-a');
    expect(mocks.reads).toHaveBeenCalledTimes(1);
    expect(getDownloadRequest(KILTER)).toMatchObject({ requestId: request.requestId, state: 'paused' });
    getDownloadRequests();
    getDownloadRequest(KILTER);
    expect(mocks.reads).toHaveBeenCalledTimes(1);
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it('cannot revive the previous account after failed sign-out cleanup and a process restart', () => {
    const previous = requestDownload(KILTER, 'toggle');
    mocks.writeFails = true;
    resetDownloadLifecycle();
    expect(mocks.storage.has('requests')).toBe(true);
    __resetDownloadLifecycleMemoryForTests();
    mocks.writeFails = false;
    mocks.track.mockClear();

    setDownloadLifecycleOwner('climber-b');
    transitionDownload(previous, 'completed');

    expect(getDownloadRequests()).toEqual([]);
    expect(mocks.storage.has('requests')).toBe(false);
    expect(mocks.track).not.toHaveBeenCalled();
    const replacement = requestDownload(KILTER, 'toggle');
    expect(replacement.requestId).not.toBe(previous.requestId);
    expect(JSON.parse(mocks.storage.get('requests') ?? '{}')).toMatchObject({ ownerId: 'climber-b' });
  });

  it('keeps old records hidden even when cleanup still fails for the newly bound account', () => {
    const previous = requestDownload(KILTER, 'toggle');
    mocks.writeFails = true;
    resetDownloadLifecycle();
    __resetDownloadLifecycleMemoryForTests();
    mocks.track.mockClear();

    setDownloadLifecycleOwner('climber-b');
    transitionDownload(previous, 'started');

    expect(getDownloadRequests()).toEqual([]);
    expect(mocks.storage.has('requests')).toBe(true);
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it('does not hydrate unknown-owner records or persist pre-auth requests over another account', () => {
    const previous = requestDownload(KILTER, 'toggle');
    const previousEnvelope = mocks.storage.get('requests');
    __resetDownloadLifecycleMemoryForTests();
    mocks.reads.mockClear();
    mocks.track.mockClear();

    expect(getDownloadRequests()).toEqual([]);
    const preAuth = requestDownload(KILTER, 'toggle');
    transitionDownload(previous, 'completed');
    expect(preAuth.requestId).not.toBe(previous.requestId);
    expect(mocks.storage.get('requests')).toBe(previousEnvelope);
    expect(mocks.reads).not.toHaveBeenCalled();
    expect(mocks.track).toHaveBeenCalledTimes(1);

    setDownloadLifecycleOwner('climber-b');
    expect(getDownloadRequests()).toEqual([]);
    transitionDownload(preAuth, 'completed');
    expect(mocks.track).toHaveBeenCalledTimes(1);
  });

  it('never includes the owner stamp in lifecycle analytics', () => {
    const request = requestDownload(KILTER, 'toggle');
    transitionDownload(request, 'started');
    const envelope = JSON.parse(mocks.storage.get('requests') ?? '{}') as Record<string, unknown>;
    expect(envelope.ownerId).toBe('climber-a');
    for (const [, properties] of mocks.track.mock.calls) {
      expect(Object.hasOwn(properties as Record<string, unknown>, 'ownerId')).toBe(false);
    }
  });

  it('does not let repeated authentication refreshes replace active requests', () => {
    const request = requestDownload(KILTER, 'toggle');
    mocks.reads.mockClear();

    setDownloadLifecycleOwner('climber-a');

    expect(getDownloadRequest(KILTER)).toEqual(request);
    expect(mocks.reads).not.toHaveBeenCalled();
  });
});
