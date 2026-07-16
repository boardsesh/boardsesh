import { describe, expect, it, vi } from 'vitest';
import { noopLocationSyncLogger, toLocationSyncLogger } from './logger';

describe('toLocationSyncLogger', () => {
  it('returns the shared no-op logger when no sink is given', () => {
    expect(toLocationSyncLogger(undefined)).toBe(noopLocationSyncLogger);
    // No-op must not throw for any level.
    expect(() => noopLocationSyncLogger.debug('d', { a: 1 })).not.toThrow();
    expect(() => noopLocationSyncLogger.info('x', { a: 1 })).not.toThrow();
    expect(() => noopLocationSyncLogger.warn('y')).not.toThrow();
  });

  it('prefixes the level and appends fields as a JSON suffix', () => {
    const sink = vi.fn();
    const logger = toLocationSyncLogger(sink);

    logger.debug('resolved alias', { gymId: 3 });
    logger.info('matched gym', { gymId: 7, tier: 2 });
    logger.warn('rejected', { reason: 'generic' });

    expect(sink).toHaveBeenNthCalledWith(1, '[location-sync] [debug] resolved alias {"gymId":3}');
    expect(sink).toHaveBeenNthCalledWith(2, '[location-sync] [info] matched gym {"gymId":7,"tier":2}');
    expect(sink).toHaveBeenNthCalledWith(3, '[location-sync] [warn] rejected {"reason":"generic"}');
  });

  it('omits the JSON suffix when fields are absent or empty', () => {
    const sink = vi.fn();
    const logger = toLocationSyncLogger(sink);

    logger.info('no fields');
    logger.info('empty fields', {});

    expect(sink).toHaveBeenNthCalledWith(1, '[location-sync] [info] no fields');
    expect(sink).toHaveBeenNthCalledWith(2, '[location-sync] [info] empty fields');
  });
});
