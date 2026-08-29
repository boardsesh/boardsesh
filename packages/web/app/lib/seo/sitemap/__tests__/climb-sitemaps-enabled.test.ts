import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

const { climbSitemapsEnabled } = await import('../climb-sitemaps-enabled');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('climbSitemapsEnabled', () => {
  it('enables publication only for the exact lowercase true value', () => {
    for (const disabledValue of ['', '1', 'TRUE', 'false']) {
      vi.stubEnv('CLIMB_SITEMAPS_ENABLED', disabledValue);
      expect(climbSitemapsEnabled()).toBe(false);
    }

    vi.stubEnv('CLIMB_SITEMAPS_ENABLED', 'true');
    expect(climbSitemapsEnabled()).toBe(true);
  });

  it('defaults to disabled when the variable is absent', () => {
    vi.stubEnv('CLIMB_SITEMAPS_ENABLED', undefined);
    expect(climbSitemapsEnabled()).toBe(false);
  });
});
