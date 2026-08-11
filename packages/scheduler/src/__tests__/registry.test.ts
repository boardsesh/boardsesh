import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isValidCronExpression } from '../cron/expression';
import { assertValidTimeZone } from '../cron/zoned-time';
import { findJob, JOBS, VERCEL_OWNED_CRON_PATHS } from '../jobs/registry';

type VercelConfig = { crons?: { path: string; schedule: string }[] };

const vercelConfigUrl = new URL('../../../web/vercel.json', import.meta.url);
const vercelConfig = JSON.parse(readFileSync(vercelConfigUrl, 'utf8')) as VercelConfig;
const vercelCronPaths = (vercelConfig.crons ?? []).map((cron) => cron.path);

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

  it('has taken the cleanup cron off Vercel', () => {
    expect(vercelCronPaths).not.toContain('/api/internal/cleanup');
    expect(findJob('cleanup')?.webPath).toBe('/api/internal/cleanup');
  });

  it('keeps the cleanup job on the slot vercel.json used', () => {
    expect(findJob('cleanup')?.schedule).toBe('0 5 * * *');
  });

  it('returns undefined for an unknown job name', () => {
    expect(findJob('nope')).toBeUndefined();
  });
});
