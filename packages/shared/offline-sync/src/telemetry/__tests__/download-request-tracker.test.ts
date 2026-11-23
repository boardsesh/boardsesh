import { describe, expect, it, vi } from 'vitest';
import {
  createDownloadRequestTracker,
  type DownloadRequestContext,
  type DownloadRequestEvent,
  type DownloadRequestLedger,
} from '../download-request-tracker';

const REQUEST_TIME = Date.parse('2026-11-21T12:00:00.000Z');
const REQUEST_OPTIONS = { trigger: 'auto-download-all', source: 'more' };

function createFixture(initial: unknown = {}) {
  let stored: unknown = initial;
  let nextId = 0;
  const reports: DownloadRequestEvent[] = [];
  const write = vi.fn((ledger: DownloadRequestLedger) => {
    stored = JSON.parse(JSON.stringify(ledger)) as unknown;
  });
  const report = vi.fn((event: DownloadRequestEvent) => {
    reports.push(event);
  });
  const createId = vi.fn(() => `random-id-${++nextId}`);
  const options = { read: () => stored, write, report, createId, now: () => REQUEST_TIME };
  return {
    tracker: createDownloadRequestTracker(options),
    recreate: () => createDownloadRequestTracker(options),
    write,
    report,
    reports,
    createId,
    read: () => stored,
  };
}

describe('download request tracking', () => {
  it('records one request per distinct scope and persists the entire batch before reporting', () => {
    const fixture = createFixture();
    fixture.report.mockImplementation((event) => {
      const stored = fixture.read() as DownloadRequestLedger;
      expect(Object.keys(stored)).toHaveLength(2);
      expect(stored[event.context.scopeKey]).toEqual(event.context);
    });

    const contexts = fixture.tracker.request(['kilter:1:5', 'kilter:1:5', 'tension:2:11'], REQUEST_OPTIONS);

    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toMatchObject({
      requestedAt: '2026-11-21T12:00:00.000Z',
      requestedScopeCount: 2,
      trigger: 'auto-download-all',
      source: 'more',
      state: 'requested',
    });
    expect(contexts[0].requestId).not.toBe(contexts[1].requestId);
    expect(contexts[0].batchId).toBe(contexts[1].batchId);
    expect(fixture.write).toHaveBeenCalledTimes(1);
    expect(fixture.report).toHaveBeenCalledTimes(2);
  });

  it('retains request identities and the original attribution through a process restart and retry', () => {
    const fixture = createFixture();
    const [requested] = fixture.tracker.request(['kilter:1:5'], REQUEST_OPTIONS);
    const restarted = fixture.recreate();

    expect(restarted.started('kilter:1:5')).toEqual({ ...requested, state: 'started' });
    expect(restarted.request(['kilter:1:5'], { trigger: 'retry', source: 'manage' })).toEqual([
      { ...requested, state: 'started' },
    ]);
    expect(restarted.started('kilter:1:5')?.requestId).toBe(requested.requestId);
    expect(fixture.reports.map(({ kind }) => kind)).toEqual(['requested', 'started']);
    expect(fixture.createId).toHaveBeenCalledTimes(2);
  });

  it('uses a fresh batch only for newly requested scopes', () => {
    const fixture = createFixture();
    const [existing] = fixture.tracker.request(['kilter:1:5'], REQUEST_OPTIONS);

    const [reused, added] = fixture.tracker.request(['kilter:1:5', 'tension:2:11'], REQUEST_OPTIONS);

    expect(reused).toEqual(existing);
    expect(added.batchId).not.toBe(existing.batchId);
    expect(added.requestedScopeCount).toBe(1);
    expect(fixture.reports.map(({ context }) => context.scopeKey)).toEqual(['kilter:1:5', 'tension:2:11']);
  });

  it.each(['completed', 'already_available'] as const)(
    'resolves %s once and never converts success into cancellation or a new request',
    (outcome) => {
      const fixture = createFixture();
      const [requested] = fixture.tracker.request(['kilter:1:5'], REQUEST_OPTIONS);
      const resolved = fixture.tracker.resolve('kilter:1:5', outcome);

      expect(resolved).toEqual({ ...requested, state: outcome });
      expect(fixture.tracker.resolve('kilter:1:5', outcome)).toEqual(resolved);
      expect(fixture.tracker.resolve('kilter:1:5', 'cancelled')).toEqual(resolved);
      expect(fixture.tracker.started('kilter:1:5')).toEqual(resolved);
      expect(fixture.tracker.request(['kilter:1:5'], REQUEST_OPTIONS)).toEqual([resolved]);
      expect(fixture.reports).toHaveLength(2);
      expect(fixture.reports[1]).toEqual({ kind: 'resolved', context: resolved });
      expect(fixture.write).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps a cancellation explicit and creates a new identity when that scope is requested again', () => {
    const fixture = createFixture();
    const [requested] = fixture.tracker.request(['kilter:1:5'], REQUEST_OPTIONS);

    const cancelled = fixture.tracker.resolve('kilter:1:5', 'cancelled');
    expect(fixture.tracker.resolve('kilter:1:5', 'completed')).toEqual(cancelled);
    const [requestedAgain] = fixture.recreate().request(['kilter:1:5'], REQUEST_OPTIONS);

    expect(requestedAgain.state).toBe('requested');
    expect(requestedAgain.requestId).not.toBe(requested.requestId);
    expect(requestedAgain.batchId).not.toBe(requested.batchId);
    expect(fixture.reports.map(({ kind }) => kind)).toEqual(['requested', 'resolved', 'requested']);
  });

  it('does not synthesize requests from callbacks on legacy or cleared scopes', () => {
    const fixture = createFixture();
    expect(fixture.tracker.started('kilter:1:5')).toBeUndefined();
    expect(fixture.tracker.resolve('kilter:1:5', 'completed')).toBeUndefined();
    fixture.tracker.request(['kilter:1:5'], REQUEST_OPTIONS);

    fixture.tracker.clear();

    expect(fixture.recreate().get('kilter:1:5')).toBeUndefined();
    expect(fixture.tracker.resolve('kilter:1:5', 'completed')).toBeUndefined();
    expect(fixture.reports).toHaveLength(1);
  });

  it('does not write or generate IDs for an empty request', () => {
    const fixture = createFixture();

    expect(fixture.tracker.request(['', '  '], REQUEST_OPTIONS)).toEqual([]);
    expect(fixture.write).not.toHaveBeenCalled();
    expect(fixture.createId).not.toHaveBeenCalled();
  });

  it.each([null, [], 'corrupt', 4, true])('ignores a malformed persisted ledger: %s', (persisted) => {
    const fixture = createFixture(persisted);
    expect(fixture.tracker.get('kilter:1:5')).toBeUndefined();
    expect(fixture.tracker.request(['kilter:1:5'], REQUEST_OPTIONS)).toHaveLength(1);
  });

  it.each([
    { requestedAt: 'not-a-date' },
    { requestedAt: '2026-11-21' },
    { requestedScopeCount: 0 },
    { requestedScopeCount: 1.5 },
    { requestedScopeCount: Number.POSITIVE_INFINITY },
    { requestId: '' },
    { batchId: '' },
    { scopeKey: 'tension:2:11' },
    { trigger: '' },
    { source: '' },
    { state: 'future_state' },
  ])('drops only a corrupt context (%j), preserving valid scopes', (corruptFields) => {
    const valid: DownloadRequestContext = {
      requestId: 'request-1',
      batchId: 'batch-1',
      scopeKey: 'kilter:1:5',
      trigger: 'auto-download-all',
      source: 'more',
      requestedAt: '2026-11-21T12:00:00.000Z',
      requestedScopeCount: 1,
      state: 'requested',
    };
    const other = { ...valid, scopeKey: 'tension:2:11', requestId: 'request-2' };
    const fixture = createFixture({ 'kilter:1:5': { ...valid, ...corruptFields }, 'tension:2:11': other });

    expect(fixture.tracker.get('kilter:1:5')).toBeUndefined();
    expect(fixture.tracker.get('tension:2:11')).toEqual(other);
  });

  it('does not mistake Object prototype properties for stored requests', () => {
    const fixture = createFixture();
    expect(fixture.tracker.get('toString')).toBeUndefined();

    const [requested] = fixture.tracker.request(['__proto__'], REQUEST_OPTIONS);

    expect(fixture.recreate().get('__proto__')).toEqual(requested);
    expect(fixture.tracker.resolve('__proto__', 'completed')?.state).toBe('completed');
  });

  it('keeps persisted identities usable when the analytics reporter throws', () => {
    const fixture = createFixture();
    fixture.report.mockImplementation(() => {
      throw new Error('analytics unavailable');
    });

    expect(() => fixture.tracker.request(['kilter:1:5'], REQUEST_OPTIONS)).not.toThrow();
    expect(fixture.tracker.get('kilter:1:5')?.state).toBe('requested');
    expect(() => fixture.tracker.resolve('kilter:1:5', 'completed')).not.toThrow();
    expect(fixture.recreate().get('kilter:1:5')?.state).toBe('completed');
  });

  it('never reports an unpersisted request when the storage write fails', () => {
    const fixture = createFixture();
    fixture.write.mockImplementation(() => {
      throw new Error('storage unavailable');
    });

    expect(() => fixture.tracker.request(['kilter:1:5'], REQUEST_OPTIONS)).toThrow('storage unavailable');
    expect(fixture.report).not.toHaveBeenCalled();
  });
});
