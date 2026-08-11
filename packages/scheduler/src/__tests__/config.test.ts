import { describe, expect, it } from 'vitest';
import { loadSchedulerConfig, SchedulerConfigError } from '../config';

describe('loadSchedulerConfig', () => {
  it('throws when CRON_SECRET is missing', () => {
    expect(() => loadSchedulerConfig({})).toThrow(SchedulerConfigError);
    expect(() => loadSchedulerConfig({ CRON_SECRET: '   ' })).toThrow(/CRON_SECRET is required/);
  });

  it('defaults the web base URL to production', () => {
    const config = loadSchedulerConfig({ CRON_SECRET: 'secret' });
    expect(config.webBaseUrl).toBe('https://www.boardsesh.com');
    expect(config.port).toBe(8080);
    expect(config.disabledJobs).toEqual([]);
  });

  it('strips trailing slashes so paths never double up', () => {
    const config = loadSchedulerConfig({ CRON_SECRET: 'secret', BOARDSESH_WEB_URL: 'https://example.com//' });
    expect(config.webBaseUrl).toBe('https://example.com');
    expect(`${config.webBaseUrl}/api/internal/cleanup`).toBe('https://example.com/api/internal/cleanup');
  });

  it('rejects a base URL without a scheme', () => {
    expect(() => loadSchedulerConfig({ CRON_SECRET: 'secret', BOARDSESH_WEB_URL: 'www.boardsesh.com' })).toThrow(
      /must start with http/,
    );
  });

  it('parses SCHEDULER_DISABLED_JOBS into trimmed names', () => {
    const config = loadSchedulerConfig({
      CRON_SECRET: 'secret',
      SCHEDULER_DISABLED_JOBS: ' cleanup , ,profile-percentiles ',
    });
    expect(config.disabledJobs).toEqual(['cleanup', 'profile-percentiles']);
  });

  it('rejects a non-numeric or out-of-range PORT', () => {
    expect(() => loadSchedulerConfig({ CRON_SECRET: 'secret', PORT: 'eight' })).toThrow(/PORT must be an integer/);
    expect(() => loadSchedulerConfig({ CRON_SECRET: 'secret', PORT: '0' })).toThrow(/PORT must be an integer/);
    expect(loadSchedulerConfig({ CRON_SECRET: 'secret', PORT: '3001' }).port).toBe(3001);
  });
});
