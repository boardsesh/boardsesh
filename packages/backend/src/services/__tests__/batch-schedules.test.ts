import type { PgBoss } from 'pg-boss';
import type { DbInstance } from '@boardsesh/db/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_SCHEDULE_QUEUE } from '@boardsesh/db/background-jobs';

// The registry ships only the probe, which has no schedules. Give it two so the
// schedule wiring has something to register; the name must stay a real family
// because BATCH_FAMILIES_ENABLED is validated against the real list.
const scheduled = vi.hoisted(() => ({
  fanOut: vi.fn<() => Promise<Array<{ payload: object; singletonKey?: string }>>>(),
  enqueue: vi.fn(),
}));

vi.mock('../../workers/families', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workers/families')>();
  const family = {
    ...actual.requireFamily('worker-probe'),
    schedules: [
      { key: 'hourly', cron: '7 * * * *', fanOut: scheduled.fanOut },
      { key: 'nightly', cron: '0 3 * * *', tz: 'Australia/Sydney', fanOut: scheduled.fanOut },
    ],
  };
  return {
    ...actual,
    allFamilies: () => [family],
    findFamily: (name: string) => (name === family.name ? family : undefined),
  };
});

vi.mock('../../workers/jobs', () => ({ enqueueBackgroundJob: scheduled.enqueue }));

const { enabledBatchFamilies, runScheduleTick, startBatchSchedules } = await import('../batch-schedules');

type WorkHandler = (jobs: Array<{ data: unknown }>) => Promise<void>;

function fakeBoss(existingKeys: string[] = []) {
  let workHandler: WorkHandler | undefined;
  const boss = {
    schedule: vi.fn(async (_name: string, _cron: string, _data: object, _options: object) => {}),
    unschedule: vi.fn(async (_name: string, _key: string) => {}),
    getSchedules: vi.fn(async () => existingKeys.map((key) => ({ name: BACKGROUND_SCHEDULE_QUEUE, key }))),
    work: vi.fn(async (_name: string, _options: object, handler: WorkHandler) => {
      workHandler = handler;
      return 'work-id';
    }),
  };
  return {
    boss,
    asPgBoss: boss as unknown as PgBoss,
    tick: (data: unknown) => {
      if (!workHandler) throw new Error('no schedule worker registered');
      return workHandler([{ data }]);
    },
  };
}

const database = {} as unknown as DbInstance;

beforeEach(() => {
  scheduled.fanOut.mockReset();
  scheduled.enqueue.mockReset();
});

describe('enabledBatchFamilies', () => {
  it('treats unset and empty as none', () => {
    expect(enabledBatchFamilies({})).toEqual([]);
    expect(enabledBatchFamilies({ BATCH_FAMILIES_ENABLED: '' })).toEqual([]);
    expect(enabledBatchFamilies({ BATCH_FAMILIES_ENABLED: ' , ' })).toEqual([]);
  });

  it('parses and dedupes a comma list', () => {
    expect(enabledBatchFamilies({ BATCH_FAMILIES_ENABLED: ' worker-probe ,worker-probe' })).toEqual(['worker-probe']);
  });

  it('rejects an unknown family name', () => {
    expect(() => enabledBatchFamilies({ BATCH_FAMILIES_ENABLED: 'worker-probe,refresh-typo' })).toThrow('refresh-typo');
  });
});

describe('startBatchSchedules', () => {
  it('registers nothing and unschedules every key when no family is enabled', async () => {
    const { boss, asPgBoss } = fakeBoss(['worker-probe:hourly', 'retired-family:daily']);
    await startBatchSchedules(asPgBoss, database, {});
    expect(boss.schedule).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
    const unscheduled = boss.unschedule.mock.calls.map(([, key]) => key);
    expect(new Set(unscheduled)).toEqual(
      new Set(['worker-probe:hourly', 'worker-probe:nightly', 'retired-family:daily']),
    );
    expect(boss.unschedule.mock.calls.every(([queue]) => queue === BACKGROUND_SCHEDULE_QUEUE)).toBe(true);
  });

  it('schedules each enabled family schedule on the trigger queue and starts one worker', async () => {
    const { boss, asPgBoss } = fakeBoss(['worker-probe:hourly', 'retired-family:daily']);
    await startBatchSchedules(asPgBoss, database, { BATCH_FAMILIES_ENABLED: 'worker-probe' });
    expect(boss.schedule.mock.calls).toEqual([
      [
        BACKGROUND_SCHEDULE_QUEUE,
        '7 * * * *',
        { family: 'worker-probe', key: 'hourly' },
        { key: 'worker-probe:hourly', tz: 'UTC', missed: 'once' },
      ],
      [
        BACKGROUND_SCHEDULE_QUEUE,
        '0 3 * * *',
        { family: 'worker-probe', key: 'nightly' },
        { key: 'worker-probe:nightly', tz: 'Australia/Sydney', missed: 'once' },
      ],
    ]);
    expect(boss.unschedule.mock.calls).toEqual([[BACKGROUND_SCHEDULE_QUEUE, 'retired-family:daily']]);
    expect(boss.work).toHaveBeenCalledTimes(1);
    expect(boss.work.mock.calls[0].slice(0, 2)).toEqual([
      BACKGROUND_SCHEDULE_QUEUE,
      { localConcurrency: 1, batchSize: 1 },
    ]);
  });

  it('refuses an unknown family before touching pg-boss', async () => {
    const { boss, asPgBoss } = fakeBoss();
    await expect(startBatchSchedules(asPgBoss, database, { BATCH_FAMILIES_ENABLED: 'nope' })).rejects.toThrow('nope');
    expect(boss.schedule).not.toHaveBeenCalled();
    expect(boss.unschedule).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
  });

  it('fans a tick out into one enqueue per request and tolerates ALREADY_QUEUED', async () => {
    const { asPgBoss, tick } = fakeBoss();
    await startBatchSchedules(asPgBoss, database, { BATCH_FAMILIES_ENABLED: 'worker-probe' });
    scheduled.fanOut.mockResolvedValue([{ payload: {}, singletonKey: 'board-1' }, { payload: {} }]);
    scheduled.enqueue
      .mockResolvedValueOnce({ runId: 'a', alreadyQueued: true })
      .mockResolvedValueOnce({ runId: 'b', alreadyQueued: false });
    await tick({ family: 'worker-probe', key: 'hourly' });
    expect(scheduled.fanOut).toHaveBeenCalledWith(database);
    expect(scheduled.enqueue.mock.calls).toEqual([
      [database, asPgBoss, { family: 'worker-probe', payload: {}, singletonKey: 'board-1' }],
      [database, asPgBoss, { family: 'worker-probe', payload: {}, singletonKey: undefined }],
    ]);
  });
});

describe('runScheduleTick', () => {
  const enabled = new Set(['worker-probe']);

  it('keeps enqueueing after one request fails and reports the counts', async () => {
    scheduled.fanOut.mockResolvedValue([{ payload: {} }, { payload: {} }, { payload: {} }]);
    scheduled.enqueue
      .mockResolvedValueOnce({ runId: 'a', alreadyQueued: false })
      .mockRejectedValueOnce(new Error('INVALID_PAYLOAD'))
      .mockResolvedValueOnce({ runId: 'c', alreadyQueued: true });
    const { asPgBoss } = fakeBoss();
    expect(await runScheduleTick(asPgBoss, database, enabled, { family: 'worker-probe', key: 'hourly' })).toEqual({
      enqueued: 1,
      alreadyQueued: 1,
      failed: 1,
    });
  });

  it('throws when the fan-out fails so pg-boss retries the tick', async () => {
    scheduled.fanOut.mockRejectedValue(new Error('read failed'));
    const { asPgBoss } = fakeBoss();
    await expect(
      runScheduleTick(asPgBoss, database, enabled, { family: 'worker-probe', key: 'hourly' }),
    ).rejects.toThrow('read failed');
  });

  it.each([
    ['a malformed tick', { family: 'worker-probe' }, enabled],
    ['an unknown schedule key', { family: 'worker-probe', key: 'weekly' }, enabled],
    ['an unknown family', { family: 'retired-family', key: 'hourly' }, enabled],
    ['a family disabled since the tick was queued', { family: 'worker-probe', key: 'hourly' }, new Set<string>()],
  ])('ignores %s', async (_label, tickData, enabledFamilies) => {
    const { asPgBoss } = fakeBoss();
    expect(await runScheduleTick(asPgBoss, database, enabledFamilies, tickData)).toEqual({
      enqueued: 0,
      alreadyQueued: 0,
      failed: 0,
    });
    expect(scheduled.fanOut).not.toHaveBeenCalled();
    expect(scheduled.enqueue).not.toHaveBeenCalled();
  });
});
