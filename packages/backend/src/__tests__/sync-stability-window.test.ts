import { describe, expect, it } from 'vite-plus/test';
import {
  resolveSyncStabilityWindowSeconds,
  syncStabilityWindowSeconds,
} from '../graphql/resolvers/sync/stability-window';

describe('the publication tombstone stability boundary', () => {
  it.each(['-1', '0', '0.5', '1', '1.000001'])('keeps deployed window %s beyond the one-second guard', (window) => {
    expect(resolveSyncStabilityWindowSeconds(window, 'production')).toBeGreaterThan(1);
    expect(resolveSyncStabilityWindowSeconds(window, undefined)).toBeGreaterThan(1);
  });

  it('preserves longer windows and the safe default for invalid configuration', () => {
    expect(resolveSyncStabilityWindowSeconds('2.5', 'production')).toBe(2.5);
    expect(resolveSyncStabilityWindowSeconds(undefined, 'production')).toBe(30);
    expect(resolveSyncStabilityWindowSeconds('invalid', 'production')).toBe(30);
    expect(resolveSyncStabilityWindowSeconds('Infinity', 'production')).toBe(30);
  });

  it('reads a blank setting as unset, not as zero', () => {
    expect(resolveSyncStabilityWindowSeconds('', 'production')).toBe(30);
    expect(resolveSyncStabilityWindowSeconds('   ', undefined)).toBe(30);
    expect(resolveSyncStabilityWindowSeconds(' 45 ', 'production')).toBe(45);
  });

  it('reads the environment it is given, the way the live pulls and the snapshot exporter both call it', () => {
    expect(syncStabilityWindowSeconds({ SYNC_STABILITY_WINDOW_SECONDS: '1' })).toBe(2);
    expect(syncStabilityWindowSeconds({ SYNC_STABILITY_WINDOW_SECONDS: '0' })).toBe(2);
    expect(syncStabilityWindowSeconds({ SYNC_STABILITY_WINDOW_SECONDS: '0', NODE_ENV: 'test' })).toBe(0);
    expect(syncStabilityWindowSeconds({})).toBe(30);
  });

  it('allows immediate fixture pulls only for exact zero in the test runtime', () => {
    expect(resolveSyncStabilityWindowSeconds('0', 'test')).toBe(0);
    expect(resolveSyncStabilityWindowSeconds('0.5', 'test')).toBeGreaterThan(1);
    expect(resolveSyncStabilityWindowSeconds('0', 'development')).toBeGreaterThan(1);
  });
});
