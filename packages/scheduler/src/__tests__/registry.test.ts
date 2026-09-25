import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isValidCronExpression } from '../cron/expression';
import { assertValidTimeZone } from '../cron/zoned-time';
import { findJob, JOBS, VERCEL_OWNED_CRON_PATHS } from '../jobs/registry';
import { refreshGymActivityStats } from '../jobs/refresh-gym-activity-stats';
import { purgeSprayWallPhotos } from '../jobs/purge-spray-wall-photos';

type VercelConfig = { crons?: { path: string; schedule: string }[] };

const vercelConfigUrl = new URL('../../../web/vercel.json', import.meta.url);
const vercelConfig = JSON.parse(readFileSync(vercelConfigUrl, 'utf8')) as VercelConfig;
const vercelCronPaths = (vercelConfig.crons ?? []).map((cron) => cron.path);

/**
 * Every path Vercel used to fire, with the exact slot it ran on. Pinned as data
 * rather than derived from {@link JOBS}, so a typo'd minute or a job quietly
 * dropped from the registry reds instead of being re-derived into agreement
 * with itself.
 *
 * `refresh-sitemap-climbs` is here for the same reason as the rest even though
 * it did not travel with them: Vercel ran it on the six-hourly slot pinned
 * below, from 2026-08-22 until the climb-sitemap pause deleted the row on
 * 2026-08-29 — before #4654 moved the remaining crons across. #4648
 * republishes the surface and brings that slot back, so the pin still means
 * what it says.
 */
const VERCEL_SCHEDULES: readonly (readonly [job: string, path: string, schedule: string])[] = [
  ['cleanup', '/api/internal/cleanup', '0 5 * * *'],
  ['profile-percentiles', '/api/internal/profile-percentiles', '0 6 * * 0'],
  ['refresh-sitemap-climbs', '/api/internal/refresh-sitemap-climbs', '0 */6 * * *'],
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

  it('runs every path on the exact slot vercel.json used', () => {
    // `refresh-sitemap-climbs` included: `s-maxage=21600` on the shard pages is
    // why six hours was the right slot on Vercel and is still the right slot
    // here — longer publishes `<lastmod>` values the CDN has already aged out,
    // shorter re-scans sixteen `DISTINCT ON` groups against production Postgres
    // more often than any crawler re-reads the file.
    const actual = JOBS.filter((job) => job.webPath !== undefined).map((job) => [job.name, job.webPath, job.schedule]);
    expect(actual).toEqual(VERCEL_SCHEDULES.map((row) => [...row]));
  });

  it('runs the gym activity refresh directly against GraphQL at 06:30 UTC', () => {
    expect(findJob('refresh-gym-activity-stats')).toMatchObject({
      schedule: '30 6 * * *',
      timezone: 'UTC',
      timeoutMs: 900_000,
      run: refreshGymActivityStats,
    });
    expect(findJob('refresh-gym-activity-stats')?.webPath).toBeUndefined();
  });

  it('runs the spray wall photo purge directly against GraphQL at 07:00 UTC', () => {
    // Pinned as data, like every row above: the 30-day retention window is only
    // as real as the job that acts on it, and a purge silently dropped from the
    // registry would leave photographs of people's homes in the bucket forever.
    // 07:00, not 06:30, so it never shares a tick with the gym activity rebuild.
    expect(findJob('purge-spray-wall-photos')).toMatchObject({
      schedule: '0 7 * * *',
      timezone: 'UTC',
      timeoutMs: 600_000,
      run: purgeSprayWallPhotos,
    });
    expect(findJob('purge-spray-wall-photos')?.webPath).toBeUndefined();
  });

  it('gives the long jobs more than the 300s Vercel capped them at', () => {
    // These routes were pinned at Vercel's Pro maximum, not at a measured
    // duration — `refresh-sitemap-climbs` included, whose route still exports
    // it. Dropping the scheduler timeout back to 300s would re-impose a limit
    // the platform no longer forces on us.
    for (const job of JOBS.filter((candidate) => candidate.name !== 'cleanup')) {
      expect(job.timeoutMs, `${job.name} timeoutMs`).toBeGreaterThan(300_000);
    }
  });

  it('returns undefined for an unknown job name', () => {
    expect(findJob('nope')).toBeUndefined();
  });
});
