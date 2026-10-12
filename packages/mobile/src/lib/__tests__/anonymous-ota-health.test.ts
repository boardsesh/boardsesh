import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { anonymousOtaStatusProperties } from '../anonymous-ota-health-properties';
vi.mock('../is-dev-build', () => ({ isDevBuild: () => false }));
// Device storage that outlives a JS runtime restart (vi.resetModules), as AsyncStorage does.
const deviceStorage = vi.hoisted(() => new Map<string, string>());
const persistence = vi.hoisted(() => ({ failReads: false, failWrites: false }));
vi.mock('../preference-store', () => ({
  getPreference: async (key: string) => {
    if (persistence.failReads) throw new Error('storage unavailable');
    const raw = deviceStorage.get(key);
    return raw === undefined ? null : JSON.parse(raw);
  },
  setPreference: async (key: string, value: unknown) => {
    if (persistence.failWrites) throw new Error('storage write unavailable');
    deviceStorage.set(key, JSON.stringify(value));
  },
}));
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
  deviceStorage.clear();
  persistence.failReads = false;
  persistence.failWrites = false;
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
it('health uses one anonymous identity per install and first-party transport with no cookies or person processing', async () => {
  const fetch = vi.fn(async (_url: string, _request: RequestInit & { body: string }) => ({ status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const health = await import('../anonymous-ota-health');
  await health.reportAnonymousOtaStatus(status);
  await health.reportAnonymousOtaStatus(status);
  const [url, request] = fetch.mock.calls[0];
  const event = JSON.parse(request.body).batch[0];
  expect(url).toMatch(/\/api\/posthog\/batch\/$/);
  expect(request.credentials).toBe('omit');
  // No consent header: anonymous health cannot expose a visitor's IP.
  expect(request.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(event.distinct_id).toMatch(/^ota-install:[0-9a-f-]{36}$/);
  expect(event.properties.$process_person_profile).toBe(false);
  expect(event.properties.$geoip_disable).toBe(true);
  expect(event.properties).not.toHaveProperty('email');
  expect(event.properties).not.toHaveProperty('emergencyLaunchReason');
  expect(JSON.parse(fetch.mock.calls[1][1].body).batch[0].distinct_id).toBe(event.distinct_id);
  // A relaunch of the same install reports under the same id, so rates count installs.
  vi.resetModules();
  const nextLaunch = await import('../anonymous-ota-health');
  await nextLaunch.reportAnonymousOtaStatus(status);
  expect(JSON.parse(fetch.mock.calls[2][1].body).batch[0].distinct_id).toBe(event.distinct_id);
  // A reinstall (cleared app storage) is a new install.
  deviceStorage.clear();
  vi.resetModules();
  const reinstall = await import('../anonymous-ota-health');
  await reinstall.reportAnonymousOtaStatus(status);
  expect(JSON.parse(fetch.mock.calls[3][1].body).batch[0].distinct_id).not.toBe(event.distinct_id);
});

it.each(['failReads', 'failWrites'] as const)(
  'skips install health across launches when %s prevents persistence, then resumes with the stored id',
  async (failure) => {
    const fetch = vi.fn(async (_url: string, _request: RequestInit & { body: string }) => ({ status: 200 }));
    vi.stubGlobal('fetch', fetch);
    persistence[failure] = true;
    const install = await import('../anonymous-install-id');
    expect(await install.getFlagsInstallDistinctId()).toMatch(/^flags-install:[0-9a-f-]{36}$/);
    const health = await import('../anonymous-ota-health');
    await health.reportAnonymousOtaStatus(status);
    vi.resetModules();
    const nextLaunch = await import('../anonymous-ota-health');
    await nextLaunch.reportAnonymousOtaStatus(status);
    expect(fetch).not.toHaveBeenCalled();
    persistence[failure] = false;
    await nextLaunch.reportAnonymousOtaStatus(status);
    expect(fetch).toHaveBeenCalledOnce();
    const record = JSON.parse(deviceStorage.get('anonymousInstallId')!);
    expect(JSON.parse(fetch.mock.calls[0][1].body).batch[0].distinct_id).toBe(`ota-install:${record.id}`);
  },
);
