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

describe('safeErrorKind', () => {
  it('extracts an HTTP status code from a status-prefixed message', async () => {
    const { safeErrorKind } = await importFresh();
    expect(safeErrorKind(new Error('401: Unauthorized'))).toBe('401');
    expect(safeErrorKind(new Error('503 Service Unavailable'))).toBe('503');
  });

  it('classifies HTTP errors generically', async () => {
    const { safeErrorKind } = await importFresh();
    expect(safeErrorKind(new Error('HTTP error! status=500'))).toBe('http_error');
  });

  it('falls back to error.name for typed errors', async () => {
    const { safeErrorKind } = await importFresh();
    class ZodError extends Error {
      constructor() {
        super('whatever');
        this.name = 'ZodError';
      }
    }
    expect(safeErrorKind(new ZodError())).toBe('ZodError');
  });

  it('does not leak raw message text for unknown errors', async () => {
    const { safeErrorKind } = await importFresh();
    const err = new Error('relation "users" does not exist (constraint users_email_key)');
    // Falls back to 'unknown' (default Error.name === 'Error' is filtered).
    expect(safeErrorKind(err)).toBe('unknown');
  });

  it('returns "unknown" for non-Error throws', async () => {
    const { safeErrorKind } = await importFresh();
    expect(safeErrorKind('something bad')).toBe('unknown');
    expect(safeErrorKind(undefined)).toBe('unknown');
    expect(safeErrorKind({ code: 'X' })).toBe('unknown');
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

  it('falls back to the x-bs-distinct-id header when anonymous and the value is a UUID', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const { resolveRequestAttribution, SERVER_DISTINCT_ID_HEADER } = await importFresh();

    const validUuid = '11111111-2222-4333-8444-555555555555';
    const req = new Request('https://x/test', {
      headers: { [SERVER_DISTINCT_ID_HEADER]: validUuid },
    });
    const result = await resolveRequestAttribution(req);

    expect(result).toEqual({ distinctId: validUuid, isAuthenticated: false });
  });

  it('returns undefined distinctId when nothing is available so the event is dropped', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const { resolveRequestAttribution } = await importFresh();

    const result = await resolveRequestAttribution(new Request('https://x/test'));

    expect(result).toEqual({ distinctId: undefined, isAuthenticated: false });
  });

  it('rejects oversized header distinct ids', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const { resolveRequestAttribution, SERVER_DISTINCT_ID_HEADER } = await importFresh();

    const longId = 'a'.repeat(300);
    const req = new Request('https://x/test', { headers: { [SERVER_DISTINCT_ID_HEADER]: longId } });
    const result = await resolveRequestAttribution(req);

    expect(result.distinctId).toBeUndefined();
  });

  it('rejects non-UUID header distinct ids (defends against injection)', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const { resolveRequestAttribution, SERVER_DISTINCT_ID_HEADER } = await importFresh();

    const malicious = '"><script>alert(1)</script>';
    const req = new Request('https://x/test', { headers: { [SERVER_DISTINCT_ID_HEADER]: malicious } });
    const result = await resolveRequestAttribution(req);

    expect(result.distinctId).toBeUndefined();
  });

  it('honors userIdOverride to skip getServerSession for callers that already have it', async () => {
    const { resolveRequestAttribution } = await importFresh();

    const result = await resolveRequestAttribution(new Request('https://x/test'), {
      userIdOverride: 'pre-resolved-user',
    });

    expect(result).toEqual({ distinctId: 'pre-resolved-user', isAuthenticated: true, userId: 'pre-resolved-user' });
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });
});

describe('trackServer drops events when distinctId is undefined', () => {
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

  it('returns false and does not call PostHog when distinctId is undefined', async () => {
    const { trackServer } = await importFresh();

    const ok = trackServer('Search Climbs', { distinctId: undefined });

    expect(ok).toBe(false);
    expect(posthogMocks.capture).not.toHaveBeenCalled();
  });
});
