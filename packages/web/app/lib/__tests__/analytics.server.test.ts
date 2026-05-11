// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

const mockVercelTrack = vi.hoisted(() => vi.fn());
vi.mock('@vercel/analytics/server', () => ({
  track: (...args: Parameters<typeof mockVercelTrack>) => mockVercelTrack(...args),
}));

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
      Object.assign(this, posthogMocks);
    }
    capture = posthogMocks.capture;
    identify = posthogMocks.identify;
    alias = posthogMocks.alias;
    flush = posthogMocks.flush;
    shutdown = posthogMocks.shutdown;
  },
}));

const mockGetServerSession = vi.hoisted(() => vi.fn());
vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('../auth/auth-options', () => ({
  authOptions: {},
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
  const mod = await import('../analytics.server');
  mod.__resetServerAnalyticsForTests();
  return mod;
}

describe('server analytics — Vercel passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVercelTrack.mockResolvedValue(undefined);
  });

  it('delegates event names, properties, and headers to Vercel server analytics', async () => {
    const { track } = await importFresh();
    const headers = new Headers({ 'user-agent': 'vitest', 'x-forwarded-for': '127.0.0.1' });

    await track('Climb Search Cache Invalidated', { boardName: 'kilter', layoutId: 1 }, { headers });

    expect(mockVercelTrack).toHaveBeenCalledWith(
      'Climb Search Cache Invalidated',
      { boardName: 'kilter', layoutId: 1 },
      { headers },
    );
  });
});

describe('server analytics — PostHog capture', () => {
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

  it('captures events with sanitized properties and the provided distinct id', async () => {
    const { trackServer } = await importFresh();

    const ok = trackServer('Search Climbs', {
      distinctId: 'user-123',
      properties: { boardName: 'kilter', resultCount: 42, optionalUndef: undefined },
    });

    expect(ok).toBe(true);
    expect(posthogMocks.capture).toHaveBeenCalledWith({
      distinctId: 'user-123',
      event: 'Search Climbs',
      properties: { boardName: 'kilter', resultCount: 42 },
    });
  });

  it('drops events when route matches the admin surface', async () => {
    const { trackServer } = await importFresh();

    const ok = trackServer('Search Climbs', {
      distinctId: 'user-123',
      route: '/admin/retention',
      properties: { boardName: 'kilter' },
    });

    expect(ok).toBe(false);
    expect(posthogMocks.capture).not.toHaveBeenCalled();
  });

  it('skips when NEXT_PUBLIC_POSTHOG_KEY is unset', async () => {
    reloadEnv({ NEXT_PUBLIC_POSTHOG_KEY: undefined, BOARDSESH_ENABLE_SERVER_ANALYTICS: '1' });
    const { trackServer } = await importFresh();

    const ok = trackServer('Search Climbs', { distinctId: 'user-123' });

    expect(ok).toBe(false);
    expect(posthogMocks.capture).not.toHaveBeenCalled();
  });

  it('skips outside production unless explicitly enabled', async () => {
    reloadEnv({
      NEXT_PUBLIC_POSTHOG_KEY: 'test-key',
      BOARDSESH_ENABLE_SERVER_ANALYTICS: undefined,
      NODE_ENV: 'development',
    });
    const { trackServer } = await importFresh();

    const ok = trackServer('Search Climbs', { distinctId: 'user-123' });

    expect(ok).toBe(false);
  });

  it('forwards identify and alias calls', async () => {
    const { identifyServer, aliasServer } = await importFresh();

    identifyServer('user-123', { plan: 'free' });
    aliasServer('anon-uuid', 'user-123');

    expect(posthogMocks.identify).toHaveBeenCalledWith({
      distinctId: 'user-123',
      properties: { plan: 'free' },
    });
    expect(posthogMocks.alias).toHaveBeenCalledWith({ distinctId: 'anon-uuid', alias: 'user-123' });
  });
});

describe('server analytics — request attribution', () => {
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

  it('uses the NextAuth session id when authenticated', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: 'auth-user-1' } });
    const { resolveRequestAttribution } = await importFresh();

    const result = await resolveRequestAttribution(new Request('https://x/test'));

    expect(result).toEqual({ distinctId: 'auth-user-1', isAuthenticated: true, userId: 'auth-user-1' });
  });

  it('falls back to the x-bs-distinct-id header when anonymous', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const { resolveRequestAttribution, SERVER_DISTINCT_ID_HEADER } = await importFresh();

    const req = new Request('https://x/test', {
      headers: { [SERVER_DISTINCT_ID_HEADER]: 'anon-party-uuid' },
    });
    const result = await resolveRequestAttribution(req);

    expect(result).toEqual({ distinctId: 'anon-party-uuid', isAuthenticated: false });
  });

  it('mints a server-anon distinct id when nothing is available', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const { resolveRequestAttribution } = await importFresh();

    const result = await resolveRequestAttribution(new Request('https://x/test'));

    expect(result.isAuthenticated).toBe(false);
    expect(result.distinctId).toMatch(/^server-anon-/);
  });

  it('rejects oversized header distinct ids', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const { resolveRequestAttribution, SERVER_DISTINCT_ID_HEADER } = await importFresh();

    const longId = 'a'.repeat(300);
    const req = new Request('https://x/test', { headers: { [SERVER_DISTINCT_ID_HEADER]: longId } });
    const result = await resolveRequestAttribution(req);

    expect(result.distinctId).not.toBe(longId);
    expect(result.distinctId).toMatch(/^server-anon-/);
  });
});
