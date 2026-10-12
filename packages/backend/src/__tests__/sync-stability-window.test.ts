import { describe, expect, it } from 'vite-plus/test';
import { resolveSyncStabilityWindowSeconds } from '../graphql/resolvers/sync/stability-window';

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

  it('allows immediate fixture pulls only for exact zero in the test runtime', () => {
    expect(resolveSyncStabilityWindowSeconds('0', 'test')).toBe(0);
    expect(resolveSyncStabilityWindowSeconds('0.5', 'test')).toBeGreaterThan(1);
    expect(resolveSyncStabilityWindowSeconds('0', 'development')).toBeGreaterThan(1);
  });
});
