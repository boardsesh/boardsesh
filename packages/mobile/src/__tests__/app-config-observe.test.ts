import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveObserveEndpoint, OTA_APP_ID } from '../../app.config';

// The expo-observe ingest endpoint is derived rather than hardcoded, so the
// telemetry and the manifest can never point at different servers. These cover
// the gates that decide whether a build reports at all — a wrong answer here is
// silent (telemetry simply never arrives, or arrives from a build that should
// not be sending).

const SELF_HOST_URL = 'https://ota.example.test/manifest';
const ENV_KEYS = ['EAS_BUILD', 'EXPO_UPDATES_URL'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('resolveObserveEndpoint', () => {
  it('builds the ingest path from the updates origin and the OTA app id', () => {
    process.env.EXPO_UPDATES_URL = SELF_HOST_URL;
    // xprem mounts /observe/{APP_ID}/{PROJECT_ID}/v1/{logs,metrics} and ignores
    // PROJECT_ID; the SDK appends the rest.
    expect(resolveObserveEndpoint('app-id-123')).toBe('https://ota.example.test/observe/app-id-123');
  });

  it('takes only the origin, dropping the manifest path', () => {
    process.env.EXPO_UPDATES_URL = 'https://ota.example.test/manifest';
    expect(resolveObserveEndpoint('app-id-123')).not.toContain('/manifest');
  });

  it('keeps a non-default port, so a proxied or local server still works', () => {
    process.env.EXPO_UPDATES_URL = 'http://localhost:3000/manifest';
    expect(resolveObserveEndpoint('app-id-123')).toBe('http://localhost:3000/observe/app-id-123');
  });

  it('reports nothing when no self-hosted server is configured', () => {
    // Such a build has no server of ours to talk to; collecting would be pointless.
    expect(resolveObserveEndpoint('app-id-123')).toBeUndefined();
  });

  it('reports nothing from an EAS-hosted build', () => {
    // Matches the updates gate: EAS_BUILD keeps a build on u.expo.dev, where
    // there is no Observe ingest at all.
    process.env.EAS_BUILD = '1';
    process.env.EXPO_UPDATES_URL = SELF_HOST_URL;
    expect(resolveObserveEndpoint('app-id-123')).toBeUndefined();
  });

  it('uses the real OTA app id, not the EAS project id', () => {
    // The two are different values for Boardsesh, and the server routes on the
    // OTA one. Getting this wrong 404s every batch.
    process.env.EXPO_UPDATES_URL = SELF_HOST_URL;
    expect(resolveObserveEndpoint(OTA_APP_ID)).toBe(`https://ota.example.test/observe/${OTA_APP_ID}`);
  });
});
