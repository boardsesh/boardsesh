import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { logger } from '../../../../utils/logger';
import { logSearchClimbsMetrics, type SearchClimbsMetricDimensions } from '../search-metrics';

const SLOW_MS = 350; // above the 300ms threshold
const FAST_MS = 12; // below the threshold

const baseDimensions: SearchClimbsMetricDimensions = {
  boardName: 'kilter',
  angle: 40,
  page: 0,
  pageSize: 20,
  sortBy: 'ascents',
  cacheable: true,
  resultCount: 21,
};

function parsePayload(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const call = spy.mock.calls[0];
  // logger is called as (message, jsonPayloadString)
  return JSON.parse(call[1] as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('logSearchClimbsMetrics', () => {
  it('warns with slow=true and the structured payload when over the threshold', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);

    logSearchClimbsMetrics('searchClimbs.climbs', SLOW_MS, 'db', baseDimensions);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toContain('SLOW searchClimbs.climbs');

    const payload = parsePayload(warnSpy);
    expect(payload).toMatchObject({
      type: 'search_climbs_metrics',
      operation: 'searchClimbs.climbs',
      durationMs: SLOW_MS,
      source: 'db',
      slow: true,
      boardName: 'kilter',
      angle: 40,
      page: 0,
      pageSize: 20,
      sortBy: 'ascents',
      cacheable: true,
      resultCount: 21,
    });
  });

  it('rounds the duration before logging', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    vi.spyOn(logger, 'info').mockImplementation(() => logger);

    logSearchClimbsMetrics('searchClimbs.climbs', 412.7, 'db', baseDimensions);

    expect(parsePayload(warnSpy).durationMs).toBe(413);
  });

  it('does not warn for a fast call and stays silent outside development', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);

    logSearchClimbsMetrics('searchClimbs.climbs', FAST_MS, 'redis', baseDimensions);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('logs a fast call at info in development with slow=false', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);

    logSearchClimbsMetrics('searchClimbs.totalCount', FAST_MS, 'redis', {
      ...baseDimensions,
      resultCount: undefined,
    });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const payload = parsePayload(infoSpy);
    expect(payload).toMatchObject({
      operation: 'searchClimbs.totalCount',
      source: 'redis',
      slow: false,
    });
    // totalCount carries no resultCount
    expect(payload.resultCount).toBeUndefined();
  });

  it('threads the source through for each origin', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    for (const source of ['db', 'redis', 'precomputed'] as const) {
      infoSpy.mockClear();
      logSearchClimbsMetrics('searchClimbs.climbs', FAST_MS, source, baseDimensions);
      expect(parsePayload(infoSpy).source).toBe(source);
    }
  });
});
