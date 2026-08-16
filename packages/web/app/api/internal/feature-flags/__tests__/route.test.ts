import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkAdmin = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/admin/check-admin', () => ({ checkAdmin }));

const getPosthogDistinctId = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/feature-flags/server-distinct-id', () => ({ getPosthogDistinctId }));

const getServerFeatureFlagResolution = vi.hoisted(() => vi.fn());
const probeServerFeatureFlag = vi.hoisted(() => vi.fn());
const describeServerFeatureFlagConfig = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/feature-flags/server-feature-flag', () => ({
  ANONYMOUS_DISTINCT_ID: 'anonymous-web-visitor',
  describeServerFeatureFlagConfig,
  getServerFeatureFlagResolution,
  probeServerFeatureFlag,
}));

import { GET } from '../route';

const ADMIN = { authenticated: true as const, userId: 'admin-1', isAdmin: true, boardScopedOnly: false };

function request(url = 'https://www.boardsesh.com/api/internal/feature-flags') {
  return new Request(url);
}

beforeEach(() => {
  checkAdmin.mockReset().mockResolvedValue(ADMIN);
  getPosthogDistinctId.mockReset().mockResolvedValue('admin-1');
  getServerFeatureFlagResolution.mockReset().mockResolvedValue({ enabled: false, reason: 'override', detail: null });
  probeServerFeatureFlag.mockReset().mockResolvedValue({ enabled: true, reason: 'posthog-enabled', detail: null });
  describeServerFeatureFlagConfig.mockReset().mockReturnValue({
    apiKeySource: 'NEXT_PUBLIC_POSTHOG_KEY',
    host: 'https://us.i.posthog.com',
    overrides: {},
  });
});

describe('GET /api/internal/feature-flags', () => {
  it('turns a signed-out caller away', async () => {
    checkAdmin.mockResolvedValue({ authenticated: false });
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(getServerFeatureFlagResolution).not.toHaveBeenCalled();
  });

  it('turns a non-admin away', async () => {
    checkAdmin.mockResolvedValue({ ...ADMIN, isAdmin: false, boardScopedOnly: true });
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(probeServerFeatureFlag).not.toHaveBeenCalled();
  });

  it('reports the cached page answer alongside live public and viewer probes', async () => {
    const response = await GET(request('https://www.boardsesh.com/api/internal/feature-flags?key=gyms-directory'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const body = await response.json();
    expect(body.flags).toHaveLength(1);
    expect(body.flags[0]).toEqual({
      key: 'gyms-directory',
      page: { enabled: false, reason: 'override', detail: null },
      public: { enabled: true, reason: 'posthog-enabled', detail: null },
      viewer: { enabled: true, reason: 'posthog-enabled', detail: null },
    });

    // The page answer has to be the gated route's own call — same distinct id,
    // same allowAnonymous — or the diagnostic describes a different question
    // than the one that 404'd.
    expect(getServerFeatureFlagResolution).toHaveBeenCalledWith('gyms-directory', {
      distinctId: 'admin-1',
      allowAnonymous: true,
    });
    expect(probeServerFeatureFlag).toHaveBeenCalledWith('gyms-directory', {
      distinctId: null,
      allowAnonymous: true,
    });
  });

  it('covers every server flag when no key is given', async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(body.flags.map((flag: { key: string }) => flag.key)).toEqual(['gyms-directory']);
    expect(body.config).toMatchObject({
      apiKeySource: 'NEXT_PUBLIC_POSTHOG_KEY',
      anonymousDistinctId: 'anonymous-web-visitor',
    });
  });

  it('never returns the project key itself', async () => {
    describeServerFeatureFlagConfig.mockReturnValue({
      apiKeySource: 'POSTHOG_PROJECT_KEY',
      host: 'https://us.i.posthog.com',
      overrides: { 'gyms-directory': true },
    });

    const body = await (await GET(request())).text();
    expect(body).not.toContain('phc_');
  });

  it('skips the viewer probe for a flag check with no signed-in person', async () => {
    // checkAdmin can only pass with a session, so this is belt-and-braces —
    // but a null distinct id must never be probed as if it were a person.
    getPosthogDistinctId.mockResolvedValue(null);

    const body = await (await GET(request())).json();
    expect(body.flags[0].viewer).toBeNull();
    expect(body.viewerDistinctId).toBeNull();
    expect(probeServerFeatureFlag).toHaveBeenCalledTimes(1);
  });

  it('rejects a key that is not a flag key', async () => {
    const response = await GET(
      request('https://www.boardsesh.com/api/internal/feature-flags?key=' + encodeURIComponent('../../etc/passwd')),
    );
    expect(response.status).toBe(400);
    expect(probeServerFeatureFlag).not.toHaveBeenCalled();
  });
});
