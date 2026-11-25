import { afterEach, beforeEach, describe, it, expect, vi } from 'vite-plus/test';
import { BUILD_RELEASE } from '../build-release';
import { GET, type HealthResponse } from '../route';

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.stubEnv('BOARDSESH_WEB', undefined);
    vi.stubEnv('PARTNER_OAUTH_MODE', undefined);
    vi.stubEnv('SUPPORT_MONTHLY_LINKS_AUD', undefined);
    vi.stubEnv('SUPPORT_MONTHLY_LINKS_USD', undefined);
  });
  afterEach(() => vi.unstubAllEnvs());
  it('returns 200 with the immutable build release', async () => {
    const previousDeploymentId = process.env.RAILWAY_DEPLOYMENT_ID;
    const previousRuntimeRelease = process.env.SENTRY_RELEASE;
    try {
      process.env.RAILWAY_DEPLOYMENT_ID = '12345678-1234-4234-8234-123456789abc';
      process.env.SENTRY_RELEASE = 'runtime-settings-cannot-change-the-build';

      const res = await GET();

      expect(res.status).toBe(200);
      const body = (await res.json()) as HealthResponse;
      expect(body).toEqual({
        status: 'ok',
        deploymentId: '12345678-1234-4234-8234-123456789abc',
        release: BUILD_RELEASE,
        marketing: { enableExpoAuthBridge: false, developerHref: '/docs', hasMonthlySupport: false },
      });
    } finally {
      if (previousDeploymentId === undefined) delete process.env.RAILWAY_DEPLOYMENT_ID;
      else process.env.RAILWAY_DEPLOYMENT_ID = previousDeploymentId;
      if (previousRuntimeRelease === undefined) delete process.env.SENTRY_RELEASE;
      else process.env.SENTRY_RELEASE = previousRuntimeRelease;
    }
  });

  it('uses an explicit local fallback when no Railway deployment is active', async () => {
    const previousDeploymentId = process.env.RAILWAY_DEPLOYMENT_ID;
    try {
      delete process.env.RAILWAY_DEPLOYMENT_ID;

      const body = (await (await GET()).json()) as HealthResponse;
      expect(body).toEqual({
        status: 'ok',
        deploymentId: 'unknown',
        release: BUILD_RELEASE,
        marketing: { enableExpoAuthBridge: false, developerHref: '/docs', hasMonthlySupport: false },
      });
    } finally {
      if (previousDeploymentId !== undefined) process.env.RAILWAY_DEPLOYMENT_ID = previousDeploymentId;
    }
  });

  it.each([
    ['off', '/docs'],
    ['hold', '/docs'],
    ['allowlist', '/developers'],
    ['open', '/developers'],
  ])('reads public configuration at request time for partner mode %s', async (mode, developerHref) => {
    const initial = (await (await GET()).json()) as HealthResponse;
    expect(initial.marketing.enableExpoAuthBridge).toBe(false);
    vi.stubEnv('BOARDSESH_WEB', '1');
    vi.stubEnv('PARTNER_OAUTH_MODE', mode);
    const response = await GET();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as HealthResponse;
    expect(body.marketing).toEqual({ enableExpoAuthBridge: true, developerHref, hasMonthlySupport: false });
    expect(JSON.stringify(body)).not.toContain('PARTNER_OAUTH_MODE');
  });

  it('exposes only monthly support availability and never payment URLs or labels', async () => {
    vi.stubEnv(
      'SUPPORT_MONTHLY_LINKS_AUD',
      '[{"label":"Private configured amount","url":"https://buy.stripe.com/monthly_example"}]',
    );
    const enabled = (await (await GET()).json()) as HealthResponse;
    expect(enabled.marketing.hasMonthlySupport).toBe(true);
    expect(JSON.stringify(enabled)).not.toContain('Private configured amount');
    expect(JSON.stringify(enabled)).not.toContain('stripe.com');
    vi.stubEnv('SUPPORT_MONTHLY_LINKS_AUD', 'invalid');
    const disabled = (await (await GET()).json()) as HealthResponse;
    expect(disabled.marketing.hasMonthlySupport).toBe(false);
  });
});
