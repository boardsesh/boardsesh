import type { PgBoss } from 'pg-boss';
import type { DbInstance } from '@boardsesh/db/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_SCHEDULE_QUEUE } from '@boardsesh/db/background-jobs';
import type { BackgroundJobFamilyModule } from '../../workers/families';

// Fake families, so the wiring is tested apart from the real registry's
// schedules. The family list is swapped so env validation accepts them.
const fakes = vi.hoisted(() => {
  const fanOut = vi.fn<() => Promise<Array<{ payload: object; singletonKey?: string; role?: string }>>>();
  const families: Array<Record<string, unknown>> = [];
  return { fanOut, enqueue: vi.fn(), families };
});

vi.mock('@boardsesh/db/background-jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/db/background-jobs')>();
  const names = ['batch-fake', 'multi-fake'];
  return {
    ...actual,
    BACKGROUND_JOB_FAMILIES: names,
    isBackgroundJobFamily: (name: string) => names.includes(name),
  };
});

vi.mock('../../workers/families', () => ({
  allFamilies: () => fakes.families,
  findFamily: (name: string) => fakes.families.find((family) => family.name === name),
}));

vi.mock('../../workers/jobs', () => ({ enqueueBackgroundJob: fakes.enqueue }));

const { assertScheduleRoles, enabledBatchFamilies, runScheduleTick, startBatchSchedules } =
  await import('../batch-schedules');

const batchFake = {
  name: 'batch-fake',
  roles: ['batch'],
  schedules: [
    { key: 'hourly', cron: '7 * * * *', fanOut: fakes.fanOut },
    { key: 'nightly', cron: '0 3 * * *', tz: 'Australia/Sydney', fanOut: fakes.fanOut },
  ],
};
const multiFake = {
  name: 'multi-fake',
  roles: ['batch', 'routine-provider'],
  schedules: [{ key: 'daily', cron: '0 4 * * *', fanOut: fakes.fanOut }],
};
const asModule = (family: object) => family as unknown as BackgroundJobFamilyModule;

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
    unscheduledKeys: () => new Set(boss.unschedule.mock.calls.map(([, key]) => key)),
    tick: (data: unknown) => {
      if (!workHandler) throw new Error('no schedule worker registered');
      return workHandler([{ data }]);
    },
  };
}

const database = {} as unknown as DbInstance;

beforeEach(() => {
  fakes.fanOut.mockReset();
  fakes.enqueue.mockReset();
  fakes.families.splice(0, fakes.families.length, batchFake);
});

describe('enabledBatchFamilies', () => {
  it('treats unset and empty as none', () => {
    expect(enabledBatchFamilies({})).toEqual([]);
    expect(enabledBatchFamilies({ BATCH_FAMILIES_ENABLED: '' })).toEqual([]);
    expect(enabledBatchFamilies({ BATCH_FAMILIES_ENABLED: ' , ' })).toEqual([]);
  });

  it('parses and dedupes a comma list', () => {
    expect(enabledBatchFamilies({ BATCH_FAMILIES_ENABLED: ' batch-fake ,batch-fake,multi-fake' })).toEqual([
      'batch-fake',
      'multi-fake',
    ]);
  });

  it('rejects an unknown family name', () => {
    expect(() => enabledBatchFamilies({ BATCH_FAMILIES_ENABLED: 'batch-fake,refresh-typo' })).toThrow('refresh-typo');
  });
});

describe('assertScheduleRoles', () => {
  it('accepts a single-role family and a multi-role schedule that names a served role', () => {
    expect(() => assertScheduleRoles(asModule(batchFake))).not.toThrow();
    const named = { ...multiFake, schedules: [{ ...multiFake.schedules[0], role: 'routine-provider' }] };
    expect(() => assertScheduleRoles(asModule(named))).not.toThrow();
  });

  it('refuses a multi-role schedule without a role, or with one the family does not serve', () => {
    expect(() => assertScheduleRoles(asModule(multiFake))).toThrow('multi-fake:daily must name a role');
    const wrong = { ...multiFake, schedules: [{ ...multiFake.schedules[0], role: 'interactive-import' }] };
    expect(() => assertScheduleRoles(asModule(wrong))).toThrow('does not serve');
  });
});

describe('startBatchSchedules', () => {
  it('registers nothing and unschedules every key when no family is enabled', async () => {
    const { boss, asPgBoss, unscheduledKeys } = fakeBoss(['batch-fake:hourly', 'retired-family:daily']);
    await startBatchSchedules(asPgBoss, database, {});
    expect(boss.schedule).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
    expect(unscheduledKeys()).toEqual(new Set(['batch-fake:hourly', 'batch-fake:nightly', 'retired-family:daily']));
    expect(boss.unschedule.mock.calls.every(([queue]) => queue === BACKGROUND_SCHEDULE_QUEUE)).toBe(true);
  });

  it('sweeps stale keys, then schedules each enabled schedule and starts one worker', async () => {
    const { boss, asPgBoss } = fakeBoss(['batch-fake:hourly', 'retired-family:daily']);
    await startBatchSchedules(asPgBoss, database, { BATCH_FAMILIES_ENABLED: 'batch-fake' });
    expect(boss.unschedule.mock.calls).toEqual([[BACKGROUND_SCHEDULE_QUEUE, 'retired-family:daily']]);
    expect(boss.unschedule.mock.invocationCallOrder[0]).toBeLessThan(boss.schedule.mock.invocationCallOrder[0]);
    expect(boss.schedule.mock.calls).toEqual([
      [
        BACKGROUND_SCHEDULE_QUEUE,
        '7 * * * *',
        { family: 'batch-fake', key: 'hourly' },
        { key: 'batch-fake:hourly', tz: 'UTC', missed: 'once' },
      ],
      [
        BACKGROUND_SCHEDULE_QUEUE,
        '0 3 * * *',
        { family: 'batch-fake', key: 'nightly' },
        { key: 'batch-fake:nightly', tz: 'Australia/Sydney', missed: 'once' },
      ],
    ]);
    expect(boss.work).toHaveBeenCalledTimes(1);
    expect(boss.work.mock.calls[0].slice(0, 2)).toEqual([
      BACKGROUND_SCHEDULE_QUEUE,
      { localConcurrency: 1, batchSize: 1 },
    ]);
  });

  it('on an unknown family, removes every schedule and throws without scheduling', async () => {
    const { boss, asPgBoss, unscheduledKeys } = fakeBoss(['batch-fake:hourly', 'retired-family:daily']);
    await expect(
      startBatchSchedules(asPgBoss, database, { BATCH_FAMILIES_ENABLED: 'batch-fake,typo' }),
    ).rejects.toThrow('typo');
    expect(unscheduledKeys()).toEqual(new Set(['batch-fake:hourly', 'batch-fake:nightly', 'retired-family:daily']));
    expect(boss.schedule).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
  });

  it('refuses to register an enabled multi-role family whose schedule names no role', async () => {
    fakes.families.push(multiFake);
    const { boss, asPgBoss } = fakeBoss();
    await expect(
      startBatchSchedules(asPgBoss, database, { BATCH_FAMILIES_ENABLED: 'batch-fake,multi-fake' }),
    ).rejects.toThrow('must name a role');
    expect(boss.schedule).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
  });

  it('fans a tick out into one enqueue per request and tolerates ALREADY_QUEUED', async () => {
    const { asPgBoss, tick } = fakeBoss();
    await startBatchSchedules(asPgBoss, database, { BATCH_FAMILIES_ENABLED: 'batch-fake' });
    fakes.fanOut.mockResolvedValue([{ payload: {}, singletonKey: 'board-1' }, { payload: {} }]);
    fakes.enqueue
      .mockResolvedValueOnce({ runId: 'a', alreadyQueued: true })
      .mockResolvedValueOnce({ runId: 'b', alreadyQueued: false });
    await tick({ family: 'batch-fake', key: 'hourly' });
    expect(fakes.fanOut).toHaveBeenCalledWith(database);
    expect(fakes.enqueue.mock.calls).toEqual([
      [database, asPgBoss, { family: 'batch-fake', payload: {}, singletonKey: 'board-1', role: undefined }],
      [database, asPgBoss, { family: 'batch-fake', payload: {}, singletonKey: undefined, role: undefined }],
    ]);
  });
});

describe('runScheduleTick', () => {
  const enabled = new Set(['batch-fake', 'multi-fake']);

  it("passes the request's role, else the schedule's", async () => {
    fakes.families.push({ ...multiFake, schedules: [{ ...multiFake.schedules[0], role: 'batch' }] });
    fakes.fanOut.mockResolvedValue([{ payload: {} }, { payload: {}, role: 'routine-provider' }]);
    fakes.enqueue.mockResolvedValue({ runId: 'a', alreadyQueued: false });
    const { asPgBoss } = fakeBoss();
    await runScheduleTick(asPgBoss, database, enabled, { family: 'multi-fake', key: 'daily' });
    expect(fakes.enqueue.mock.calls.map(([, , input]) => input.role)).toEqual(['batch', 'routine-provider']);
  });

  it('keeps enqueueing after one request fails and reports the counts', async () => {
    fakes.fanOut.mockResolvedValue([{ payload: {} }, { payload: {} }, { payload: {} }]);
    fakes.enqueue
      .mockResolvedValueOnce({ runId: 'a', alreadyQueued: false })
      .mockRejectedValueOnce(new Error('INVALID_PAYLOAD'))
      .mockResolvedValueOnce({ runId: 'c', alreadyQueued: true });
    const { asPgBoss } = fakeBoss();
    expect(await runScheduleTick(asPgBoss, database, enabled, { family: 'batch-fake', key: 'hourly' })).toEqual({
      enqueued: 1,
      alreadyQueued: 1,
      failed: 1,
    });
  });

  it('throws when every request fails, so pg-boss retries a tick that enqueued nothing', async () => {
    fakes.fanOut.mockResolvedValue([{ payload: {} }, { payload: {} }]);
    fakes.enqueue.mockRejectedValue(new Error('relation "secret" does not exist'));
    const { asPgBoss } = fakeBoss();
    await expect(runScheduleTick(asPgBoss, database, enabled, { family: 'batch-fake', key: 'hourly' })).rejects.toThrow(
      'SCHEDULE_TICK_FAILED',
    );
  });

  it('treats an empty fan-out as success', async () => {
    fakes.fanOut.mockResolvedValue([]);
    const { asPgBoss } = fakeBoss();
    expect(await runScheduleTick(asPgBoss, database, enabled, { family: 'batch-fake', key: 'hourly' })).toEqual({
      enqueued: 0,
      alreadyQueued: 0,
      failed: 0,
    });
  });

  it('throws when the fan-out fails so pg-boss retries the tick', async () => {
    fakes.fanOut.mockRejectedValue(new Error('read failed'));
    const { asPgBoss } = fakeBoss();
    await expect(runScheduleTick(asPgBoss, database, enabled, { family: 'batch-fake', key: 'hourly' })).rejects.toThrow(
      'read failed',
    );
  });

  it.each([
    ['a malformed tick', { family: 'batch-fake' }, enabled],
    ['an unknown schedule key', { family: 'batch-fake', key: 'weekly' }, enabled],
    ['an unknown family', { family: 'retired-family', key: 'hourly' }, enabled],
    ['a family disabled since the tick was queued', { family: 'batch-fake', key: 'hourly' }, new Set<string>()],
  ])('ignores %s', async (_label, tickData, enabledFamilies) => {
    const { asPgBoss } = fakeBoss();
    expect(await runScheduleTick(asPgBoss, database, enabledFamilies, tickData)).toEqual({
      enqueued: 0,
      alreadyQueued: 0,
      failed: 0,
    });
    expect(fakes.fanOut).not.toHaveBeenCalled();
    expect(fakes.enqueue).not.toHaveBeenCalled();
  });
});
