import { describe, it, expect } from 'vite-plus/test';
import { BUILD_RELEASE } from '../build-release';
import { GET, type HealthResponse } from '../route';

describe('GET /api/health', () => {
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
      expect(body).toEqual({ status: 'ok', deploymentId: 'unknown', release: BUILD_RELEASE });
    } finally {
      if (previousDeploymentId !== undefined) process.env.RAILWAY_DEPLOYMENT_ID = previousDeploymentId;
    }
  });
});
