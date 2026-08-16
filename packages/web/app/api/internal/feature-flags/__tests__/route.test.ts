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

import { SERVER_FEATURE_FLAG_KEYS } from '@/app/flags';
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

  it('reports cached and live answers for both the visitor and the admin', async () => {
    const response = await GET(request('https://www.boardsesh.com/api/internal/feature-flags?key=gyms-directory'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const body = await response.json();
    expect(body.flags).toHaveLength(1);
    expect(body.flags[0]).toEqual({
      key: 'gyms-directory',
      registered: true,
      cached: {
        public: { enabled: false, reason: 'override', detail: null },
        viewer: { enabled: false, reason: 'override', detail: null },
      },
      live: {
        public: { enabled: true, reason: 'posthog-enabled', detail: null },
        viewer: { enabled: true, reason: 'posthog-enabled', detail: null },
      },
    });
  });

  it('reads the ANONYMOUS cache entry, which is the one that 404s a visitor', async () => {
    await GET(request('https://www.boardsesh.com/api/internal/feature-flags?key=gyms-directory'));

    // The data cache is keyed per flag AND per person, so the admin's entry says
    // nothing about the entry a signed-out visitor's request used. Reading only
    // the admin's would make "cached off, live on" mean either staleness or the
    // admin being in a person-targeted rollout — the exact ambiguity this
    // endpoint exists to remove.
    expect(getServerFeatureFlagResolution).toHaveBeenCalledWith('gyms-directory', {
      distinctId: null,
      allowAnonymous: true,
    });
    expect(getServerFeatureFlagResolution).toHaveBeenCalledWith('gyms-directory', {
      distinctId: 'admin-1',
      allowAnonymous: true,
    });
    expect(probeServerFeatureFlag).toHaveBeenCalledWith('gyms-directory', {
      distinctId: null,
      allowAnonymous: true,
    });
  });

  it('marks a key that is not a registered server flag', async () => {
    const body = await (
      await GET(request('https://www.boardsesh.com/api/internal/feature-flags?key=renamed-in-the-dashboard'))
    ).json();

    // Allowed on purpose: `flag-missing` is the answer to "did someone rename
    // it?", which a membership check could never ask.
    expect(body.flags[0].registered).toBe(false);
    expect(body.flags[0].live.public).toMatchObject({ reason: 'posthog-enabled' });
  });

  it('covers every server flag when no key is given', async () => {
    const response = await GET(request());
    const body = await response.json();

    // Derived from the registry rather than hardcoded: the behaviour under test
    // is "covers every registered server flag", which a second flag must extend
    // rather than break.
    expect(body.flags.map((flag: { key: string }) => flag.key)).toEqual([...SERVER_FEATURE_FLAG_KEYS]);
    expect(body.flags.every((flag: { registered: boolean }) => flag.registered)).toBe(true);
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

  it('skips the viewer columns when there is no signed-in person', async () => {
    // checkAdmin can only pass with a session, so this is belt-and-braces —
    // but a null distinct id must never be probed as if it were a person.
    getPosthogDistinctId.mockResolvedValue(null);

    const body = await (await GET(request())).json();
    expect(body.flags[0].cached.viewer).toBeNull();
    expect(body.flags[0].live.viewer).toBeNull();
    expect(body.viewerDistinctId).toBeNull();
    expect(probeServerFeatureFlag).toHaveBeenCalledTimes(SERVER_FEATURE_FLAG_KEYS.length);
    expect(getServerFeatureFlagResolution).toHaveBeenCalledTimes(SERVER_FEATURE_FLAG_KEYS.length);
  });

  it('accepts a dot-separated key, which PostHog allows', async () => {
    const response = await GET(request('https://www.boardsesh.com/api/internal/feature-flags?key=gyms.directory.v2'));
    expect(response.status).toBe(200);
  });

  // Shape, not membership: an unregistered key is answerable on purpose (see
  // the `registered: false` test above), a path-traversal string is not — the
  // slashes are what disqualify it, dots on their own are fine.
  it('rejects a key that is not shaped like a flag key', async () => {
    const response = await GET(
      request('https://www.boardsesh.com/api/internal/feature-flags?key=' + encodeURIComponent('../../etc/passwd')),
    );
    expect(response.status).toBe(400);
    expect(probeServerFeatureFlag).not.toHaveBeenCalled();
  });
});
