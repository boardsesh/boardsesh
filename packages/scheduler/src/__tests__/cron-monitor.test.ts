import { describe, expect, it, vi } from 'vitest';
import {
  createCronMonitor,
  monitorConfigForJob,
  monitorSlugForJob,
  noopCronMonitor,
  type CronMonitorConfig,
  type WithMonitorFn,
} from '../monitoring/cron-monitor';
import { JOBS } from '../jobs/registry';
import type { JobDefinition } from '../jobs/types';

type RecordedMonitorCall = { slug: string; config: CronMonitorConfig };

/**
 * Stands in for `Sentry.withMonitor`, recording the slug and MonitorConfig it
 * was handed and passing the callback straight through — the same contract the
 * real one has, so a test that passes here says something about production.
 */
function createFakeSentry() {
  const calls: RecordedMonitorCall[] = [];
  const withMonitor: WithMonitorFn = (slug, callback, config) => {
    calls.push({ slug, config });
    return callback();
  };
  return { calls, withMonitor };
}

const defineJob = (overrides: Partial<JobDefinition> = {}): JobDefinition => ({
  name: 'cleanup',
  schedule: '0 5 * * *',
  timezone: 'UTC',
  timeoutMs: 120_000,
  run: async () => ({ ok: true }),
  ...overrides,
});

describe('monitorSlugForJob', () => {
  it('prefixes the job name so scheduler monitors are identifiable in Sentry', () => {
    expect(monitorSlugForJob('cleanup')).toBe('scheduler-cleanup');
    expect(monitorSlugForJob('prewarm-heatmap-kilter')).toBe('scheduler-prewarm-heatmap-kilter');
  });

  it('pins the exact slug of every registered job', () => {
    // Sentry keys a monitor's entire history on its slug. A renamed job would
    // silently orphan the monitor that holds this job's check-in history and
    // start a fresh one, so every live slug is pinned as data.
    expect(JOBS.map((job) => monitorSlugForJob(job.name))).toEqual([
      'scheduler-cleanup',
      'scheduler-prewarm-heatmap-kilter',
      'scheduler-prewarm-heatmap-tension',
      'scheduler-prewarm-heatmap-decoy',
      'scheduler-prewarm-heatmap-touchstone',
      'scheduler-prewarm-heatmap-grasshopper',
      'scheduler-profile-percentiles',
      'scheduler-refresh-sitemap-climbs',
    ]);
  });
});

describe('monitorConfigForJob', () => {
  it('hands Sentry the job registry schedule verbatim', () => {
    // This is what makes a MISSED run detectable: Sentry computes the next
    // expected check-in from this expression. A stale or hand-copied value
    // would have it waiting on the wrong minute.
    const config = monitorConfigForJob(defineJob({ schedule: '45 4 * * 0' }));
    expect(config.schedule).toEqual({ type: 'crontab', value: '45 4 * * 0' });
  });

  it('sends Sentry the exact crontab expression each live job runs on', () => {
    // Pinned as literals on purpose. Asserting `config.schedule.value ===
    // job.schedule` would derive both sides from the same field and pass no
    // matter what the schedule became — it would only prove the function
    // copies a string. Seven of these are the slots Vercel used and the eighth
    // is the six-hourly sitemap refresh #4648 brought back, so a registry
    // schedule edited without a deliberate change here reds, and Sentry can
    // never be left waiting on a minute the ticker does not fire.
    const configBySlug = Object.fromEntries(JOBS.map((job) => [monitorSlugForJob(job.name), monitorConfigForJob(job)]));

    expect(
      Object.fromEntries(Object.entries(configBySlug).map(([slug, config]) => [slug, config.schedule.value])),
    ).toEqual({
      'scheduler-cleanup': '0 5 * * *',
      'scheduler-prewarm-heatmap-kilter': '0 4 * * 0',
      'scheduler-prewarm-heatmap-tension': '15 4 * * 0',
      'scheduler-prewarm-heatmap-decoy': '30 4 * * 0',
      'scheduler-prewarm-heatmap-touchstone': '45 4 * * 0',
      'scheduler-prewarm-heatmap-grasshopper': '0 5 * * 0',
      'scheduler-profile-percentiles': '0 6 * * 0',
      'scheduler-refresh-sitemap-climbs': '0 */6 * * *',
    });

    for (const config of Object.values(configBySlug)) {
      expect(config.schedule.type).toBe('crontab');
      // Sentry defaults a monitor to UTC, but only if nothing says otherwise;
      // an unset timezone here plus a non-UTC host would put the expected
      // check-in window hours away from when the job actually runs.
      expect(config.timezone).toBe('UTC');
    }
  });

  it('alerts on the first failure and clears on the first success', () => {
    // These jobs are weekly. A threshold of 2 would mean hearing about a broken
    // prewarm a fortnight after it broke.
    const config = monitorConfigForJob(defineJob());
    expect(config.failureIssueThreshold).toBe(1);
    expect(config.recoveryThreshold).toBe(1);
  });

  it('derives maxRuntime from the job timeout, in whole minutes with slack', () => {
    expect(monitorConfigForJob(defineJob({ timeoutMs: 120_000 })).maxRuntime).toBe(3);
    expect(monitorConfigForJob(defineJob({ timeoutMs: 900_000 })).maxRuntime).toBe(16);
    // Rounds up rather than truncating: a 90s job must not be flagged at 1min.
    expect(monitorConfigForJob(defineJob({ timeoutMs: 90_000 })).maxRuntime).toBe(3);
  });

  it('leaves room for a late check-in without swallowing an outage', () => {
    const config = monitorConfigForJob(defineJob());
    expect(config.checkinMargin).toBeGreaterThan(0);
    // Must stay under the 15-minute stagger between the heatmap prewarms, or a
    // late kilter run would still be "on time" when tension is already due.
    expect(config.checkinMargin).toBeLessThan(15);
  });
});

describe('createCronMonitor', () => {
  it('wraps the run in a check-in and returns its result', async () => {
    const { calls, withMonitor } = createFakeSentry();
    const monitor = createCronMonitor(withMonitor);

    await expect(monitor.monitor(defineJob(), async () => 'done')).resolves.toBe('done');

    expect(calls).toHaveLength(1);
    expect(calls[0].slug).toBe('scheduler-cleanup');
    expect(calls[0].config.schedule).toEqual({ type: 'crontab', value: '0 5 * * *' });
  });

  it('lets a thrown job propagate after the monitor wrapper', async () => {
    // The runner's bookkeeping, /health/jobs and the error log all depend on
    // seeing the rejection. A monitor that swallowed it would leave the job
    // green everywhere except Sentry.
    const { calls, withMonitor } = createFakeSentry();
    const monitor = createCronMonitor(withMonitor);
    const failure = new Error('web returned HTTP 500');

    await expect(monitor.monitor(defineJob(), () => Promise.reject(failure))).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
  });
});

describe('noopCronMonitor', () => {
  it('calls straight through so behaviour is identical without a DSN', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true });
    await expect(noopCronMonitor.monitor(defineJob(), run)).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('still propagates a failure', async () => {
    const failure = new Error('boom');
    await expect(noopCronMonitor.monitor(defineJob(), () => Promise.reject(failure))).rejects.toBe(failure);
  });
});
