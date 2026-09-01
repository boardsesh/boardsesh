import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isValidCronExpression } from '../cron/expression';
import { assertValidTimeZone } from '../cron/zoned-time';
import { findJob, JOBS, VERCEL_OWNED_CRON_PATHS } from '../jobs/registry';

type VercelConfig = { crons?: { path: string; schedule: string }[] };

const vercelConfigUrl = new URL('../../../web/vercel.json', import.meta.url);
const vercelConfig = JSON.parse(readFileSync(vercelConfigUrl, 'utf8')) as VercelConfig;
const vercelCronPaths = (vercelConfig.crons ?? []).map((cron) => cron.path);

/**
 * Every path the scheduler now owns, with the exact slot it inherited from
 * `vercel.json`. Pinned as data rather than derived from {@link JOBS}, so a
 * typo'd minute or a job quietly dropped from the registry reds instead of
 * being re-derived into agreement with itself.
 */
const MIGRATED_SCHEDULES: readonly (readonly [job: string, path: string, schedule: string])[] = [
  ['cleanup', '/api/internal/cleanup', '0 5 * * *'],
  ['prewarm-heatmap-kilter', '/api/internal/prewarm-heatmap/kilter', '0 4 * * 0'],
  ['prewarm-heatmap-tension', '/api/internal/prewarm-heatmap/tension', '15 4 * * 0'],
  ['prewarm-heatmap-decoy', '/api/internal/prewarm-heatmap/decoy', '30 4 * * 0'],
  ['prewarm-heatmap-touchstone', '/api/internal/prewarm-heatmap/touchstone', '45 4 * * 0'],
  ['prewarm-heatmap-grasshopper', '/api/internal/prewarm-heatmap/grasshopper', '0 5 * * 0'],
  ['profile-percentiles', '/api/internal/profile-percentiles', '0 6 * * 0'],
];

describe('job registry', () => {
  it('has unique job names', () => {
    const jobNames = JOBS.map((job) => job.name);
    expect(new Set(jobNames).size).toBe(jobNames.length);
  });

  it('declares a parseable schedule and a real timezone for every job', () => {
    for (const job of JOBS) {
      expect(isValidCronExpression(job.schedule), `${job.name} schedule ${job.schedule}`).toBe(true);
      expect(() => assertValidTimeZone(job.timezone)).not.toThrow();
      expect(job.timeoutMs).toBeGreaterThan(0);
    }
  });

  it('pins every job to UTC, the zone Vercel crons ran in', () => {
    // node-style cron evaluates in the host zone by default; a container whose
    // TZ is not UTC would silently move the job off its slot.
    for (const job of JOBS) {
      expect(job.timezone).toBe('UTC');
    }
  });

  it('names every job in kebab-case, because the Sentry monitor slug is derived from it', () => {
    // `monitorSlugForJob` turns the name straight into `scheduler-<name>`. A
    // name with an underscore or a capital would either be rejected by Sentry
    // or, worse, silently normalised into a slug that no longer matches the
    // monitor already collecting this job's history.
    for (const job of JOBS) {
      expect(job.name, `${job.name} is not kebab-case`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('has taken every cron off vercel.json', () => {
    // The whole point of #4654: the `crons` block is gone, not merely emptied
    // of the jobs we happened to look at.
    expect(vercelCronPaths).toEqual([]);
    expect(vercelConfig.crons).toBeUndefined();
  });

  it('never schedules a path that vercel.json still owns', () => {
    const schedulerPaths = JOBS.map((job) => job.webPath).filter((path): path is string => path !== undefined);
    const doubleScheduled = schedulerPaths.filter((path) => vercelCronPaths.includes(path));
    expect(doubleScheduled).toEqual([]);
  });

  it('keeps VERCEL_OWNED_CRON_PATHS in step with vercel.json', () => {
    // If this fails, a cron moved on one side only: either add the job here and
    // drop it from vercel.json, or drop it from this list.
    expect([...vercelCronPaths].sort()).toEqual([...VERCEL_OWNED_CRON_PATHS].sort());
  });

  it('runs every migrated path on the exact slot vercel.json used', () => {
    const actual = JOBS.map((job) => [job.name, job.webPath, job.schedule]);
    expect(actual).toEqual(MIGRATED_SCHEDULES.map((row) => [...row]));
  });

  it('keeps the five heatmap prewarms staggered rather than firing them together', () => {
    // Five boards' worth of heatmap aggregates against one Postgres. The
    // stagger is the rate limit, so a schedule collapsed onto a single minute
    // is a regression even though every individual job still "runs weekly".
    const prewarmSlots = JOBS.filter((job) => job.name.startsWith('prewarm-heatmap-')).map((job) => job.schedule);
    expect(new Set(prewarmSlots).size).toBe(prewarmSlots.length);
    expect(prewarmSlots).toHaveLength(5);
  });

  it('gives the weekly warm-ups more than the 300s Vercel capped them at', () => {
    // These routes were pinned at Vercel's Pro maximum, not at a measured
    // duration. Dropping the scheduler timeout back to 300s would re-impose a
    // limit the platform no longer forces on us.
    for (const job of JOBS.filter((candidate) => candidate.name !== 'cleanup')) {
      expect(job.timeoutMs, `${job.name} timeoutMs`).toBeGreaterThan(300_000);
    }
  });

  it('returns undefined for an unknown job name', () => {
    expect(findJob('nope')).toBeUndefined();
  });
});
