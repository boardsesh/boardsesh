import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveUpdatesConfig } from '../../app.config';

// Unit tests for the fail-closed OTA routing in app.config.ts. This function
// decides whether a production binary points at EAS or our self-hosted server,
// and silent misrouting just means OTA never fires (no error). Cover every path.

const PROJECT_ID = 'test-project-id';
const SELF_HOST_URL = 'https://ota.example.test/manifest';

// The three env vars resolveUpdatesConfig reads. Snapshot + restore so tests
// don't leak into each other or the rest of the suite.
const ENV_KEYS = ['EAS_BUILD', 'EXPO_UPDATES_URL', 'EXPO_UPDATES_CHANNEL'] as const;
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

/** A throwaway project root, optionally containing certs/certificate.pem. */
function makeProjectRoot(withCert: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'boardsesh-otacfg-'));
  if (withCert) {
    mkdirSync(join(root, 'certs'), { recursive: true });
    writeFileSync(
      join(root, 'certs', 'certificate.pem'),
      '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n',
    );
  }
  return root;
}

const roots: string[] = [];
function projectRoot(withCert: boolean): string {
  const root = makeProjectRoot(withCert);
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const EAS_URL = `https://u.expo.dev/${PROJECT_ID}`;

describe('resolveUpdatesConfig', () => {
  it('returns the EAS URL for eas build (EAS_BUILD set), ignoring self-host env + cert', () => {
    process.env.EAS_BUILD = '1';
    process.env.EXPO_UPDATES_URL = SELF_HOST_URL;
    process.env.EXPO_UPDATES_CHANNEL = 'production';
    expect(resolveUpdatesConfig(PROJECT_ID, projectRoot(true))).toEqual({ url: EAS_URL });
  });

  it('falls back to the EAS URL when EXPO_UPDATES_URL is unset', () => {
    expect(resolveUpdatesConfig(PROJECT_ID, projectRoot(true))).toEqual({ url: EAS_URL });
  });

  it('FAILS CLOSED to the EAS URL when the server URL is set but the cert is missing', () => {
    process.env.EXPO_UPDATES_URL = SELF_HOST_URL;
    process.env.EXPO_UPDATES_CHANNEL = 'production';
    // No cert in this project root → must not bake the self-hosted (unsigned) URL.
    expect(resolveUpdatesConfig(PROJECT_ID, projectRoot(false))).toEqual({ url: EAS_URL });
  });

  it('uses the self-hosted server with channel header + code signing when URL + cert are present', () => {
    process.env.EXPO_UPDATES_URL = SELF_HOST_URL;
    process.env.EXPO_UPDATES_CHANNEL = 'production';
    expect(resolveUpdatesConfig(PROJECT_ID, projectRoot(true))).toEqual({
      url: SELF_HOST_URL,
      enabled: true,
      requestHeaders: { 'expo-channel-name': 'production' },
      codeSigningCertificate: './certs/certificate.pem',
      codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' },
    });
  });

  it('omits the channel header when EXPO_UPDATES_CHANNEL is unset (still signed)', () => {
    process.env.EXPO_UPDATES_URL = SELF_HOST_URL;
    const result = resolveUpdatesConfig(PROJECT_ID, projectRoot(true)) as Record<string, unknown>;
    expect(result.url).toBe(SELF_HOST_URL);
    expect(result.requestHeaders).toBeUndefined();
    expect(result.codeSigningCertificate).toBe('./certs/certificate.pem');
  });

  it('resolves the cert relative to projectRoot, not process.cwd()', () => {
    // The cert lives under the passed projectRoot; cwd here (the repo root) has no
    // such file, so a cwd-based check would wrongly fail closed. This asserts the
    // path-invariant behaviour.
    process.env.EXPO_UPDATES_URL = SELF_HOST_URL;
    process.env.EXPO_UPDATES_CHANNEL = 'production';
    const result = resolveUpdatesConfig(PROJECT_ID, projectRoot(true)) as Record<string, unknown>;
    expect(result.url).toBe(SELF_HOST_URL);
  });
});
