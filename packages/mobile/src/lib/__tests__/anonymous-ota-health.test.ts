import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { anonymousOtaStatusProperties } from '../anonymous-ota-health-properties';
vi.mock('../is-dev-build', () => ({ isDevBuild: () => false }));
const status = {
  isEnabled: true,
  isEmbeddedLaunch: false,
  updateId: 'update-id',
  channel: 'production',
  branch: 'main',
  runtimeVersion: 'fingerprint',
  createdAtIso: null,
  isEmergencyLaunch: true,
  emergencyLaunchReason: 'private /Users/person/token',
  email: 'person@example.com',
};
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('EXPO_PUBLIC_POSTHOG_KEY', 'phc_health');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('health properties are an explicit allowlist without freeform emergency reason or person traits', () => {
  const properties = anonymousOtaStatusProperties(status);
  expect(properties).not.toHaveProperty('email');
  expect(properties).not.toHaveProperty('emergencyLaunchReason');
});
it('health uses an ephemeral launch identity and first-party transport with no cookies or person processing', async () => {
  const fetch = vi.fn(async (_url: string, _request: RequestInit & { body: string }) => ({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const health = await import('../anonymous-ota-health');
  await health.reportAnonymousOtaStatus(status);
  await health.reportAnonymousOtaStatus(status);
  const [url, request] = fetch.mock.calls[0];
  const event = JSON.parse(request.body).batch[0];
  expect(url).toMatch(/\/api\/posthog\/batch\/$/);
  expect(request.credentials).toBe('omit');
  expect(event.distinct_id).toMatch(/^ota-launch:/);
  expect(event.properties.$process_person_profile).toBe(false);
  expect(event.properties).not.toHaveProperty('email');
  expect(event.properties).not.toHaveProperty('emergencyLaunchReason');
  expect(JSON.parse(fetch.mock.calls[1][1].body).batch[0].distinct_id).toBe(event.distinct_id);
  vi.resetModules();
  const nextRuntime = await import('../anonymous-ota-health');
  await nextRuntime.reportAnonymousOtaStatus(status);
  expect(JSON.parse(fetch.mock.calls[2][1].body).batch[0].distinct_id).not.toBe(event.distinct_id);
});
