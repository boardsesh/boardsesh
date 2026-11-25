import { describe, expect, it } from 'vitest';
import type { WipData } from 'pg-boss';
import {
  WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS,
  WORKER_JOB_QUEUE_STATEMENT_TIMEOUT_MS,
} from '@boardsesh/db/background-jobs';
import { SPRAY_DETECTION_QUEUE } from '@boardsesh/shared-schema';
import {
  PROBE_STALL_SECONDS,
  WORK_LOOP_STALL_SECONDS,
  detectorJobQueueOptions,
  probeHasHung,
  workLoopAgeSeconds,
} from '../queue';

const connectionString = 'postgresql://worker:secret@primary.example:5432/boardsesh?sslmode=verify-full';
const createdOn = Date.parse('2026-11-21T07:00:00Z');

function worker(overrides: Partial<WipData> = {}): WipData {
  return {
    id: 'worker',
    workId: 'worker',
    name: SPRAY_DETECTION_QUEUE,
    options: {},
    state: 'active',
    count: 0,
    createdOn,
    lastFetchedOn: null,
    lastJobStartedOn: null,
    lastJobEndedOn: null,
    lastJobDuration: null,
    lastError: null,
    lastErrorOn: null,
    ...overrides,
  };
}

describe('detector job queue options', () => {
  // pg-boss passes these straight to pg. Without them a fetch sent down a dead
  // proxy leg waited forever and the detector claimed nothing for four days.
  it('gives every queue statement the workers read and server deadlines', () => {
    expect(detectorJobQueueOptions(connectionString)).toMatchObject({
      connectionString,
      query_timeout: WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS,
      statement_timeout: WORKER_JOB_QUEUE_STATEMENT_TIMEOUT_MS,
    });
  });

  it('never migrates, supervises or schedules', () => {
    expect(detectorJobQueueOptions(connectionString)).toMatchObject({
      migrate: false,
      supervise: false,
      schedule: false,
    });
  });

  it('waits out the read deadline before calling the loop stuck', () => {
    expect(WORK_LOOP_STALL_SECONDS * 1000).toBeGreaterThan(WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS);
  });
});

describe('work loop age', () => {
  it('is null before pg-boss registers the detection worker', () => {
    expect(workLoopAgeSeconds([], SPRAY_DETECTION_QUEUE, createdOn)).toBeNull();
    expect(workLoopAgeSeconds([worker({ name: 'other-queue' })], SPRAY_DETECTION_QUEUE, createdOn)).toBeNull();
  });

  it('counts from the newest fetch while the loop polls', () => {
    const lastFetchedOn = createdOn + 60_000;
    expect(workLoopAgeSeconds([worker({ lastFetchedOn })], SPRAY_DETECTION_QUEUE, lastFetchedOn + 2_000)).toBe(2);
  });

  it('grows without bound when a fetch never returns', () => {
    const lastFetchedOn = createdOn + 60_000;
    const fourDaysLater = lastFetchedOn + 4 * 24 * 3_600_000;
    expect(
      workLoopAgeSeconds([worker({ lastFetchedOn })], SPRAY_DETECTION_QUEUE, fourDaysLater),
    ).toBeGreaterThanOrEqual(WORK_LOOP_STALL_SECONDS);
  });

  it('treats a failing fetch as a live loop, since a restart cannot fix the database', () => {
    const lastErrorOn = createdOn + 600_000;
    expect(
      workLoopAgeSeconds(
        [worker({ lastFetchedOn: createdOn, lastErrorOn })],
        SPRAY_DETECTION_QUEUE,
        lastErrorOn + 1_000,
      ),
    ).toBe(1);
  });

  it('counts a finished job as a sign of life', () => {
    const lastJobEndedOn = createdOn + 120_000;
    expect(
      workLoopAgeSeconds([worker({ lastFetchedOn: createdOn, lastJobEndedOn })], SPRAY_DETECTION_QUEUE, lastJobEndedOn),
    ).toBe(0);
  });

  it('starts the clock at registration when nothing has been fetched yet', () => {
    expect(workLoopAgeSeconds([worker()], SPRAY_DETECTION_QUEUE, createdOn + 10_000)).toBe(10);
  });
});

describe('probe hang', () => {
  const startedAtMs = createdOn;

  it('lets a probe against a failing database finish its deadlines first', () => {
    // Two pg-boss reads (10 s checkout + 30 s read each), then the Drizzle read:
    // a 10 s connect-retry budget, up to 20 s reconnect backoff and a 30 s connect.
    const slowestFailingProbeMs = 2 * (10_000 + WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS) + 10_000 + 20_000 + 30_000;
    expect(probeHasHung(startedAtMs, startedAtMs + slowestFailingProbeMs)).toBe(false);
  });

  it('calls a probe hung once it passes the limit', () => {
    expect(probeHasHung(startedAtMs, startedAtMs + PROBE_STALL_SECONDS * 1000 - 1)).toBe(false);
    expect(probeHasHung(startedAtMs, startedAtMs + PROBE_STALL_SECONDS * 1000)).toBe(true);
  });
});
