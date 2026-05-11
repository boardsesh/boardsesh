import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const posthogMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  identify: vi.fn(),
  alias: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
}));
const PostHogCtor = vi.hoisted(() => vi.fn());

vi.mock('posthog-node', () => ({
  PostHog: class {
    constructor(...args: unknown[]) {
      PostHogCtor(...args);
    }
    capture = posthogMocks.capture;
    identify = posthogMocks.identify;
    alias = posthogMocks.alias;
    flush = posthogMocks.flush;
    shutdown = posthogMocks.shutdown;
  },
}));

function reloadEnv(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      vi.stubEnv(key, '');
    } else {
      vi.stubEnv(key, value);
    }
  }
}

async function importFresh() {
  vi.resetModules();
  const mod = await import('../analytics/server-analytics');
  mod.__resetServerAnalyticsForTests();
  return mod;
}

describe('backend server analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reloadEnv({
      NEXT_PUBLIC_POSTHOG_KEY: 'test-key',
      BOARDSESH_ENABLE_SERVER_ANALYTICS: '1',
      NODE_ENV: 'test',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('captures events with sanitized properties', async () => {
    const { trackServer } = await importFresh();

    const ok = trackServer('Search Climbs', {
      distinctId: 'user-1',
      properties: { boardName: 'kilter', resultCount: 12, undef: undefined },
    });

    expect(ok).toBe(true);
    expect(posthogMocks.capture).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'Search Climbs',
      properties: { boardName: 'kilter', resultCount: 12 },
    });
  });

  it('skips when posthog key is missing', async () => {
    reloadEnv({ NEXT_PUBLIC_POSTHOG_KEY: undefined });
    const { trackServer } = await importFresh();

    expect(trackServer('Search Climbs', { distinctId: 'user-1' })).toBe(false);
    expect(posthogMocks.capture).not.toHaveBeenCalled();
  });

  describe('resolveContextAttribution', () => {
    it('returns userId when authenticated', async () => {
      const { resolveContextAttribution } = await importFresh();
      const result = resolveContextAttribution({
        connectionId: 'c1',
        isAuthenticated: true,
        userId: 'u1',
      });
      expect(result).toEqual({ distinctId: 'u1', isAuthenticated: true, userId: 'u1' });
    });

    it('returns the propagated distinctId for anonymous', async () => {
      const { resolveContextAttribution } = await importFresh();
      const result = resolveContextAttribution({
        connectionId: 'c1',
        distinctId: 'anon-uuid',
      });
      expect(result).toEqual({ distinctId: 'anon-uuid', isAuthenticated: false });
    });

    it('falls back to a server-anon id keyed by connectionId', async () => {
      const { resolveContextAttribution } = await importFresh();
      const result = resolveContextAttribution({ connectionId: 'c1' });
      expect(result).toEqual({ distinctId: 'server-anon-c1', isAuthenticated: false });
    });
  });

  describe('readDistinctIdHeader', () => {
    it('reads from a Headers object', async () => {
      const { readDistinctIdHeader, SERVER_DISTINCT_ID_HEADER } = await importFresh();
      const headers = new Headers({ [SERVER_DISTINCT_ID_HEADER]: 'abc' });
      expect(readDistinctIdHeader(headers)).toBe('abc');
    });

    it('reads from a plain object (incoming Node http headers)', async () => {
      const { readDistinctIdHeader, SERVER_DISTINCT_ID_HEADER } = await importFresh();
      expect(readDistinctIdHeader({ [SERVER_DISTINCT_ID_HEADER]: 'def' })).toBe('def');
    });

    it('rejects oversized headers', async () => {
      const { readDistinctIdHeader, SERVER_DISTINCT_ID_HEADER } = await importFresh();
      const headers = new Headers({ [SERVER_DISTINCT_ID_HEADER]: 'a'.repeat(300) });
      expect(readDistinctIdHeader(headers)).toBeUndefined();
    });

    it('returns undefined when header missing', async () => {
      const { readDistinctIdHeader } = await importFresh();
      expect(readDistinctIdHeader(new Headers())).toBeUndefined();
    });
  });
});
