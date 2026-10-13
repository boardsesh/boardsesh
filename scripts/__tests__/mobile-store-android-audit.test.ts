import { generateKeyPairSync } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildAndroidReleaseAudit,
  createAuditAccessToken,
  parseExpectedVersionCode,
  readProductionReleaseSummaries,
} from '../mobile-store-android-audit';

afterEach(() => vi.unstubAllGlobals());

const release = (versionCode: number, releaseLifecycleState = 'RELEASE_LIFECYCLE_STATE_DRAFT') => ({
  releaseName: '2.6.0',
  track: 'production',
  activeArtifacts: [{ versionCode }],
  releaseLifecycleState,
});

describe('exact Android release audit', () => {
  it.each([
    'RELEASE_LIFECYCLE_STATE_DRAFT',
    'RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW',
    'RELEASE_LIFECYCLE_STATE_IN_REVIEW',
    'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED',
    'RELEASE_LIFECYCLE_STATE_NOT_APPROVED',
    'RELEASE_LIFECYCLE_STATE_PUBLISHED',
  ])('retains %s without implying notes or publishing-setting verification', (state) => {
    const report = buildAndroidReleaseAudit({ releases: [release(2001247, state), release(2001248)] }, 2001247);
    expect(report.identityErrors).toEqual([]);
    expect(report.matchingReleases).toEqual([release(2001247, state)]);
    expect(report.releases).toHaveLength(2);
    expect(report.limitations).toContain('Release notes are not exposed by this endpoint and were not verified.');
    expect(report.limitations).toContain(
      'Managed publishing status is not exposed by this endpoint and was not verified.',
    );
  });

  it('rejects identity when a newer release exists but the requested versionCode is absent', () => {
    const report = buildAndroidReleaseAudit({ releases: [release(2001248)] }, 2001247);
    expect(report.identityErrors).toEqual(['Expected one production release containing versionCode 2001247; found 0']);
    expect(report.matchingReleases).toEqual([]);
  });

  it('rejects ambiguous identity instead of selecting the first matching release', () => {
    const report = buildAndroidReleaseAudit(
      { releases: [release(2001247), release(2001247, 'RELEASE_LIFECYCLE_STATE_IN_REVIEW')] },
      2001247,
    );
    expect(report.identityErrors[0]).toContain('found 2');
  });

  it('retains only approved public fields from a response', () => {
    const report = buildAndroidReleaseAudit(
      {
        access_token: 'secret-token',
        releases: [{ ...release(2001247), unrelated: { contactEmail: 'private@example.com' } }],
      },
      2001247,
    );
    expect(JSON.stringify(report)).not.toContain('secret-token');
    expect(JSON.stringify(report)).not.toContain('private@example.com');
  });

  it.each([
    { releases: [{ ...release(2001247), track: 'internal' }] },
    { releases: [{ ...release(2001247), releaseName: 260 }] },
    { releases: [{ ...release(2001247), releaseLifecycleState: 'UNKNOWN_FUTURE_STATE' }] },
    { releases: [{ ...release(2001247), activeArtifacts: [{ versionCode: '2001247' }] }] },
  ])('fails closed on malformed or mismatched release metadata %#', (input) => {
    expect(() => buildAndroidReleaseAudit(input, 2001247)).toThrow(/Google Play/);
  });

  it.each(['', '0', '-1', '2.6.0', '2001247suffix', '9007199254740992', ' 2001247'])(
    'rejects invalid versionCode %s before querying Google',
    (input) => expect(() => parseExpectedVersionCode(input)).toThrow(/positive safe integer/),
  );
});

describe('Google Play request boundary', () => {
  it('sanitizes malformed credential JSON before logging any error', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await expect(createAuditAccessToken('{"private_key":"secret-fragment",')).rejects.toThrow(
      'Google Play authentication failed; check the Production service-account credential',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sanitizes OAuth error bodies from the reused authentication helper', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret-fragment', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      createAuditAccessToken(JSON.stringify({ client_email: 'test@example.com', private_key: privateKey })),
    ).rejects.toThrow('Google Play authentication failed; check the Production service-account credential');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('makes one GET outside the Edits API and refuses redirects', async () => {
    const response = { releases: [release(2001247)] };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(readProductionReleaseSummaries('token')).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.boardsesh.app/tracks/production/releases',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
        redirect: 'error',
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('reports failed HTTP status without retaining an error response body', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('private diagnostic', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(readProductionReleaseSummaries('token')).rejects.toThrow(
      'Google Play production release audit returned HTTP 403',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not echo an invalid release-response body in JSON parse errors', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('private diagnostic')));
    await expect(readProductionReleaseSummaries('token')).rejects.toThrow(
      'Google Play production release audit returned invalid JSON',
    );
  });
});
