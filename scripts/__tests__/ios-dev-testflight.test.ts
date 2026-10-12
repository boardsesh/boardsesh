import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AppleDevBuildClient,
  createAppleApiToken,
  isReusableDevBuild,
  parseDevBaseline,
  type AppleBuild,
  type AppleApiFetchRequest,
  type IosDevBaseline,
} from '../lib/ios-dev-testflight';

const NOW = Date.parse('2026-10-12T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const baseline: IosDevBaseline = {
  bundleId: 'com.boardsesh.app.dev',
  fingerprint: 'a'.repeat(40),
  commit: 'b'.repeat(40),
  appId: 'dev-app',
  buildId: 'dev-build',
  buildNumber: '42',
  version: '2.6.0',
};
const readyBuild: AppleBuild = {
  id: baseline.buildId,
  number: baseline.buildNumber,
  version: baseline.version,
  uploadedDate: new Date(NOW - DAY).toISOString(),
  expirationDate: new Date(NOW + 89 * DAY).toISOString(),
  expired: false,
  processingState: 'VALID',
  buildAudienceType: 'INTERNAL_ONLY',
  internalBuildState: 'IN_BETA_TESTING',
};

function credentials() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicKey,
    environment: {
      NODE_ENV: 'test' as const,
      APP_STORE_CONNECT_API_KEY_ID: 'test-key',
      APP_STORE_CONNECT_ISSUER_ID: 'test-issuer',
      APP_STORE_CONNECT_API_KEY_BASE64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString(
        'base64',
      ),
    },
  };
}

describe('iOS Dev TestFlight renewal and distribution policy', () => {
  it('reuses only the exact processed, compatible internal binary', () => {
    expect(isReusableDevBuild(baseline, baseline.fingerprint, readyBuild, NOW)).toBe(true);
    expect(isReusableDevBuild(baseline, 'c'.repeat(40), readyBuild, NOW)).toBe(false);
    expect(isReusableDevBuild(baseline, baseline.fingerprint, { ...readyBuild, id: 'different-build' }, NOW)).toBe(
      false,
    );
    expect(isReusableDevBuild(baseline, baseline.fingerprint, { ...readyBuild, version: '2.7.0' }, NOW)).toBe(false);
  });

  it.each([
    { expired: true },
    { processingState: 'PROCESSING' },
    { processingState: 'INVALID' },
    { buildAudienceType: 'APP_STORE_ELIGIBLE' },
    { internalBuildState: 'MISSING_EXPORT_COMPLIANCE' },
    { expirationDate: new Date(NOW).toISOString() },
    { uploadedDate: 'invalid timestamp' },
    { uploadedDate: new Date(NOW + DAY).toISOString() },
  ])('does not reuse an unavailable or unsafe baseline: %j', (attributes) => {
    expect(isReusableDevBuild(baseline, baseline.fingerprint, { ...readyBuild, ...attributes }, NOW)).toBe(false);
  });

  it('renews at 60 days, before Apple expiry', () => {
    expect(
      isReusableDevBuild(
        baseline,
        baseline.fingerprint,
        {
          ...readyBuild,
          uploadedDate: new Date(NOW - 59 * DAY).toISOString(),
        },
        NOW,
      ),
    ).toBe(true);
    expect(
      isReusableDevBuild(
        baseline,
        baseline.fingerprint,
        {
          ...readyBuild,
          uploadedDate: new Date(NOW - 60 * DAY).toISOString(),
        },
        NOW,
      ),
    ).toBe(false);
  });

  it('rejects metadata from production or with an invalid fingerprint', () => {
    expect(parseDevBaseline(JSON.stringify(baseline))).toEqual(baseline);
    expect(() => parseDevBaseline(JSON.stringify({ ...baseline, bundleId: 'com.boardsesh.app' }))).toThrow();
    expect(() => parseDevBaseline(JSON.stringify({ ...baseline, fingerprint: '' }))).toThrow();
  });
});

describe('App Store Connect build lookup', () => {
  it('signs a short-lived Apple ES256 token with the required JWT encoding', () => {
    const { environment, publicKey } = credentials();
    const [header, claims, signature] = createAppleApiToken(environment, NOW).split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'test-key',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: 'test-issuer',
      iat: NOW / 1000,
      exp: NOW / 1000 + 600,
      aud: 'appstoreconnect-v1',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        {
          key: publicKey,
          dsaEncoding: 'ieee-p1363',
        },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('matches marketing version when Apple returns reused build numbers', async () => {
    const fetchRequest = vi.fn<AppleApiFetchRequest>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'older-version',
              type: 'builds',
              attributes: { ...readyBuild, version: '42' },
              relationships: { preReleaseVersion: { data: { id: 'old-version' } } },
            },
            {
              id: 'dev-build',
              type: 'builds',
              attributes: { ...readyBuild, version: '42' },
              relationships: {
                preReleaseVersion: { data: { id: 'current-version' } },
                buildBetaDetail: { data: { id: 'beta-details' } },
              },
            },
          ],
          included: [
            { id: 'old-version', type: 'preReleaseVersions', attributes: { version: '2.5.0' } },
            { id: 'current-version', type: 'preReleaseVersions', attributes: { version: '2.6.0' } },
            { id: 'beta-details', type: 'buildBetaDetails', attributes: { internalBuildState: 'IN_BETA_TESTING' } },
          ],
        }),
      ),
    );
    const client = new AppleDevBuildClient(credentials().environment, fetchRequest);
    expect(await client.build('dev-app', '42', '2.6.0')).toEqual(readyBuild);
    const requestAddress = fetchRequest.mock.calls[0][0];
    if (typeof requestAddress !== 'string') throw new Error('Expected an Apple API URL string');
    const requestUrl = new URL(requestAddress);
    expect(requestUrl.searchParams.get('filter[app]')).toBe('dev-app');
    expect(requestUrl.searchParams.get('filter[version]')).toBe('42');
  });

  it('fails API permission errors instead of treating them as an absent baseline', async () => {
    const fetchRequest = vi.fn<AppleApiFetchRequest>().mockResolvedValue(new Response('', { status: 403 }));
    await expect(new AppleDevBuildClient(credentials().environment, fetchRequest).appId()).rejects.toThrow('403');
  });
});
