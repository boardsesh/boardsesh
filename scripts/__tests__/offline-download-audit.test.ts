import { describe, expect, it } from 'vitest';
import {
  classifyDownloadRequests,
  classifyDownloadStarts,
  DOWNLOAD_AUDIT_WINDOW,
  DOWNLOAD_FOLLOW_UP_MS,
  parseDownloadAuditTuples,
  summarizeDownloadAudit,
  type DownloadAuditEvent,
} from '../offline-download-audit';

const REQUESTED_AT = Date.parse('2026-10-20T12:00:00Z');
const STARTED = 'Offline Board Download Started';
const COMPLETED = 'Offline Board Download Completed';
const FAILED = 'Offline Board Download Failed';
const TOGGLED = 'Offline Board Toggled';
const LIFECYCLE = 'Offline Board Download Lifecycle';

function observation(event: string, seconds: number, fields: Partial<DownloadAuditEvent> = {}): DownloadAuditEvent {
  return {
    uuid: `event-${String(seconds).padStart(8, '0')}`,
    timestamp: new Date(REQUESTED_AT + seconds * 1_000).toISOString(),
    event,
    clientId: 'client-one',
    personId: 'person-one',
    scopeKey: 'kilter:1:10',
    platform: 'iOS',
    nativeVersion: '2.7.0',
    runtimeVersion: 'runtime-one',
    updateId: 'update-one',
    embedded: false,
    ...fields,
  };
}

function enable(seconds = 0, fields: Partial<DownloadAuditEvent> = {}) {
  return observation(TOGGLED, seconds, { enabled: true, ...fields });
}

describe('offline download audit classification', () => {
  it('counts a completion at exactly seven days but leaves a later completion unknown', () => {
    const initial = [enable(), observation(STARTED, 1)];
    const exact = observation(COMPLETED, DOWNLOAD_FOLLOW_UP_MS / 1_000);
    expect(classifyDownloadRequests([...initial, exact])[0].outcome).toBe('completed');
    expect(
      classifyDownloadRequests([
        ...initial,
        { ...exact, timestamp: new Date(Date.parse(exact.timestamp) + 1).toISOString() },
      ])[0].outcome,
    ).toBe('unknown');
  });

  it('reports no-start separately and recognizes cancellation before any start', () => {
    expect(classifyDownloadRequests([enable()])[0].outcome).toBe('no-start');
    expect(classifyDownloadRequests([enable(), observation(TOGGLED, 1, { enabled: false })])[0].outcome).toBe(
      'abandoned',
    );
  });

  it('deduplicates repeated enables and leaves retries in the same request generation', () => {
    const classified = classifyDownloadRequests([
      enable(),
      observation(STARTED, 1),
      enable(2),
      observation(STARTED, 3),
      observation(COMPLETED, 4),
    ]);
    expect(classified).toHaveLength(1);
    expect(classified[0]).toMatchObject({ outcome: 'completed', starts: 2, restarts: 1 });
  });

  it.each(['abandoned-removed', 'abandoned-signed-out', 'abandoned-disabled'])(
    'opens a new legacy generation after %s without a disabled toggle',
    (reason) => {
      const classified = classifyDownloadRequests([
        enable(),
        observation(STARTED, 1),
        observation(FAILED, 2, { reason }),
        enable(3),
        observation(STARTED, 4),
        observation(COMPLETED, 5),
      ]);
      expect(classified.map(({ outcome }) => outcome)).toEqual(['abandoned', 'completed']);
      expect(classified.map(({ starts }) => starts)).toEqual([1, 1]);
    },
  );

  it.each(['unknown', 'watermark-regression', 'database-locked', 'aborted-background'])(
    'keeps a legacy generation enabled after the nonterminal %s diagnostic',
    (reason) => {
      const classified = classifyDownloadRequests([
        enable(),
        observation(STARTED, 1),
        observation(FAILED, 2, { reason }),
        enable(3),
        observation(STARTED, 4),
        observation(COMPLETED, 5),
      ]);
      expect(classified).toHaveLength(1);
      expect(classified[0]).toMatchObject({ outcome: 'completed', starts: 2 });
    },
  );

  it('separates clients and operating systems even when the person and scope match', () => {
    const classified = classifyDownloadRequests([
      enable(),
      observation(STARTED, 1),
      observation(COMPLETED, 2, { clientId: 'client-two' }),
      observation(COMPLETED, 3, { platform: 'Android' }),
    ]);
    expect(classified[0].outcome).toBe('unknown');
  });

  it('credits one completion only to the latest start and counts the restart', () => {
    const classified = classifyDownloadStarts([
      observation(STARTED, 0),
      observation(STARTED, 1),
      observation(COMPLETED, 2),
    ]);
    expect(classified.map(({ outcome }) => outcome)).toEqual(['unknown', 'completed']);
    expect(summarizeDownloadAudit(classified).restarts).toBe(1);
  });

  it('keeps bootstrap failures and background pauses nonterminal through paging recovery', () => {
    const classified = classifyDownloadRequests([
      enable(),
      observation(STARTED, 1),
      observation(FAILED, 2, { reason: 'aborted-background' }),
      observation(FAILED, 3, { reason: 'watermark-regression', stage: 'import' }),
      observation(COMPLETED, 4),
      observation(FAILED, 5, { reason: 'unknown' }),
    ]);
    expect(classified[0]).toMatchObject({
      outcome: 'completed',
      pauses: 1,
      failuresObserved: 1,
      completionAfterPause: true,
    });
    expect(
      classifyDownloadRequests([
        enable(),
        observation(STARTED, 1),
        observation(FAILED, 2, { reason: 'unknown-exit' }),
      ])[0].outcome,
    ).toBe('unknown');
  });

  it('accepts an explicit lifecycle scope failure as the only confirmed failure', () => {
    const classified = classifyDownloadRequests([
      observation(LIFECYCLE, 0, {
        state: 'requested',
        origin: 'requested',
        requestId: 'request-one',
        requestedAt: REQUESTED_AT,
      }),
      observation(LIFECYCLE, 1, { state: 'failed', requestId: 'request-one' }),
    ]);
    expect(classified[0].outcome).toBe('confirmed-failure');
  });

  it('recognizes cached completion without Started only with explicit lifecycle proof', () => {
    const classified = classifyDownloadRequests([
      observation(LIFECYCLE, 0, {
        state: 'requested',
        origin: 'requested',
        requestId: 'request-one',
        requestedAt: REQUESTED_AT,
      }),
      observation(LIFECYCLE, 1, { state: 'completed', completionSource: 'cached', requestId: 'request-one' }),
    ]);
    expect(classified[0]).toMatchObject({ outcome: 'completed', started: false, cached: true });
    expect(classifyDownloadRequests([enable(), observation(COMPLETED, 1)])[0]).toMatchObject({
      outcome: 'completed',
      cached: false,
    });
  });

  it('does not fabricate a request for recovered legacy scope telemetry', () => {
    expect(
      classifyDownloadRequests([
        observation(LIFECYCLE, 0, { state: 'resumed', origin: 'recovered', requestId: 'recovered-one' }),
        observation(COMPLETED, 1, { requestId: 'recovered-one' }),
      ]),
    ).toEqual([]);
  });

  it('never attributes an old completion to a re-enabled request', () => {
    const classified = classifyDownloadRequests([
      observation(LIFECYCLE, 0, { state: 'requested', origin: 'requested', requestId: 'request-one' }),
      observation(LIFECYCLE, 1, { state: 'abandoned', requestId: 'request-one' }),
      observation(LIFECYCLE, 2, { state: 'requested', origin: 'requested', requestId: 'request-two' }),
      observation(COMPLETED, 3, { requestId: 'request-one' }),
    ]);
    expect(classified.map(({ outcome }) => outcome)).toEqual(['abandoned', 'no-start']);
  });

  it('does not let a stale abandonment reset the current generation enabled state', () => {
    const classified = classifyDownloadRequests([
      observation(LIFECYCLE, 0, { state: 'requested', origin: 'requested', requestId: 'request-one' }),
      observation(LIFECYCLE, 1, { state: 'abandoned', requestId: 'request-one' }),
      observation(LIFECYCLE, 2, { state: 'requested', origin: 'requested', requestId: 'request-two' }),
      observation(LIFECYCLE, 3, { state: 'abandoned', requestId: 'request-one' }),
      enable(4),
      observation(COMPLETED, 5, { requestId: 'request-two' }),
    ]);
    expect(classified.map(({ outcome }) => outcome)).toEqual(['abandoned', 'completed']);
  });

  it.each(['abandoned-removed', 'abandoned-signed-out', 'abandoned-disabled'])(
    'ignores stale %s failure callbacks when a replacement request is enabled',
    (reason) => {
      const classified = classifyDownloadRequests([
        observation(LIFECYCLE, 0, { state: 'requested', origin: 'requested', requestId: 'request-one' }),
        observation(LIFECYCLE, 1, { state: 'abandoned', requestId: 'request-one' }),
        observation(LIFECYCLE, 2, { state: 'requested', origin: 'requested', requestId: 'request-two' }),
        observation(FAILED, 3, { reason, requestId: 'request-one' }),
        enable(4),
        observation(COMPLETED, 5, { requestId: 'request-two' }),
      ]);
      expect(classified.map(({ outcome }) => outcome)).toEqual(['abandoned', 'completed']);
    },
  );

  it.each([
    { event: FAILED, reason: 'abandoned-removed' },
    { event: FAILED, reason: 'abandoned-signed-out' },
    { event: FAILED, reason: 'abandoned-disabled' },
    { event: COMPLETED },
    { event: TOGGLED, enabled: false },
    { event: LIFECYCLE, state: 'abandoned' },
    { event: LIFECYCLE, state: 'failed' },
  ])('does not attach an unkeyed $event terminal to an identified replacement request', (terminal) => {
    const classified = classifyDownloadRequests([
      observation(LIFECYCLE, 0, { state: 'requested', origin: 'requested', requestId: 'request-one' }),
      observation(LIFECYCLE, 1, { state: 'abandoned', requestId: 'request-one' }),
      observation(LIFECYCLE, 2, { state: 'requested', origin: 'requested', requestId: 'request-two' }),
      observation(terminal.event, 3, terminal),
      enable(4),
      observation(COMPLETED, 5, { requestId: 'request-two' }),
    ]);
    expect(classified.map(({ outcome }) => outcome)).toEqual(['abandoned', 'completed']);
  });

  it.each([
    { event: FAILED, reason: 'abandoned-removed' },
    { event: FAILED, reason: 'abandoned-signed-out' },
    { event: FAILED, reason: 'abandoned-disabled' },
    { event: COMPLETED },
    { event: TOGGLED, enabled: false },
  ])('requires a keyed terminal after an identified start despite an unkeyed $event', (terminal) => {
    const initial = [observation(STARTED, 0, { requestId: 'request-one' }), observation(terminal.event, 1, terminal)];
    expect(classifyDownloadStarts(initial)[0].outcome).toBe('unknown');
    expect(
      classifyDownloadStarts([...initial, observation(COMPLETED, 2, { requestId: 'request-one' })])[0].outcome,
    ).toBe('completed');
  });

  it('does not call someone complete when another requested board lacks a start', () => {
    const classified = classifyDownloadRequests([
      enable(),
      observation(STARTED, 1),
      observation(COMPLETED, 2),
      enable(3, { scopeKey: 'tension:10:6' }),
    ]);
    expect(summarizeDownloadAudit(classified)).toMatchObject({ people: 1, peopleCompletingEveryObservedRequest: 0 });
  });

  it('excludes immature requests and respects the exclusive cohort upper bound', () => {
    const classified = classifyDownloadRequests([enable()], {
      ...DOWNLOAD_AUDIT_WINDOW,
      observedTo: REQUESTED_AT + DOWNLOAD_FOLLOW_UP_MS - 1,
    });
    expect(summarizeDownloadAudit(classified)).toMatchObject({ observations: 0, immature: 1 });
    expect(classifyDownloadRequests([enable()], { ...DOWNLOAD_AUDIT_WINDOW, cohortTo: REQUESTED_AT })).toEqual([]);
  });

  it('orders equal timestamps by UUID without crediting a completion twice', () => {
    const classified = classifyDownloadStarts([
      observation(COMPLETED, 0, { uuid: 'c' }),
      observation(STARTED, 0, { uuid: 'b' }),
      observation(STARTED, 0, { uuid: 'a' }),
    ]);
    expect(classified.map(({ outcome }) => outcome)).toEqual(['unknown', 'completed']);
  });

  it('summarizes exact launch cohorts without returning client or person identifiers', () => {
    const summary = summarizeDownloadAudit(classifyDownloadRequests([enable(), observation(COMPLETED, 1)]));
    expect(summary.releases[0]).toMatchObject({
      nativeVersion: '2.7.0',
      runtimeVersion: 'runtime-one',
      updateId: 'update-one',
      embedded: false,
    });
    expect(JSON.stringify(summary)).not.toContain('client-one');
    expect(JSON.stringify(summary)).not.toContain('person-one');
  });

  it('validates the narrow SQL tuple export and interprets timestamps in UTC', () => {
    const tuple = [
      'event-id',
      '2026-10-20 12:00:00.000000',
      TOGGLED,
      'client',
      'person',
      'kilter:1:10',
      'iOS',
      '2.7.0',
      'runtime',
      'update',
      false,
      true,
      null,
      null,
      null,
      'manage',
    ];
    expect(parseDownloadAuditTuples([tuple])[0]).toMatchObject({
      timestamp: '2026-10-20T12:00:00.000000Z',
      enabled: true,
    });
    expect(() => parseDownloadAuditTuples([tuple.slice(0, 5)])).toThrow('16-column');
    expect(() => parseDownloadAuditTuples([[tuple[0], 'invalid', ...tuple.slice(2)]])).toThrow('timestamp');
  });
});
