import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getAcceptedVersions,
  mapAcceptedGoogleProductionReleases,
  mapAcceptedVersions,
  parseGoogleProductionReleasesResponse,
  parseGoogleServiceAccount,
} from '../mobile-auto-version-bump';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mapAcceptedVersions', () => {
  it.each([
    'ACCEPTED',
    'PENDING_DEVELOPER_RELEASE',
    'PENDING_APPLE_RELEASE',
    'PROCESSING_FOR_DISTRIBUTION',
    'READY_FOR_DISTRIBUTION',
  ])('maps exact iOS build in accepted state %s', (state) => {
    expect(
      mapAcceptedVersions({
        data: [
          {
            type: 'appStoreVersions',
            id: 'v1',
            attributes: { versionString: '2.1.0', appVersionState: state },
            relationships: { build: { data: { type: 'builds', id: 'b1' } } },
          },
        ],
        included: [{ type: 'builds', id: 'b1', attributes: { version: '42' } }],
      }),
    ).toEqual([{ platform: 'ios', versionString: '2.1.0', buildNumber: 42, state }]);
  });

  it('drops pending, rejected, and deprecated legacy accepted states', () => {
    expect(
      mapAcceptedVersions({
        data: [
          {
            type: 'appStoreVersions',
            id: 'v1',
            attributes: { versionString: '2.1.0', appVersionState: 'IN_REVIEW' },
            relationships: { build: { data: { type: 'builds', id: 'b1' } } },
          },
          {
            type: 'appStoreVersions',
            id: 'v2',
            attributes: { versionString: '2.1.0', appVersionState: 'REJECTED' },
            relationships: { build: { data: { type: 'builds', id: 'b1' } } },
          },
          {
            type: 'appStoreVersions',
            id: 'v3',
            attributes: { versionString: '2.1.0', appVersionState: 'READY_FOR_SALE' },
            relationships: { build: { data: { type: 'builds', id: 'b1' } } },
          },
        ],
        included: [{ type: 'builds', id: 'b1', attributes: { version: '42' } }],
      }),
    ).toEqual([]);
  });

  it('fails loudly when ASC omits the official appVersionState attribute', () => {
    expect(() =>
      mapAcceptedVersions({
        data: [
          {
            type: 'appStoreVersions',
            id: 'legacy-v1',
            attributes: { versionString: '2.1.0' },
            relationships: { build: { data: { type: 'builds', id: 'b1' } } },
          },
        ],
        included: [{ type: 'builds', id: 'b1', attributes: { version: '42' } }],
      }),
    ).toThrow(/missing the required appVersionState/);
  });

  it('drops versions without an exact attached numeric build', () => {
    expect(
      mapAcceptedVersions({
        data: [
          {
            type: 'appStoreVersions',
            id: 'v1',
            attributes: { versionString: '2.1.0', appVersionState: 'READY_FOR_DISTRIBUTION' },
            relationships: { build: { data: null } },
          },
          {
            type: 'appStoreVersions',
            id: 'v2',
            attributes: { versionString: '2.1.0', appVersionState: 'READY_FOR_DISTRIBUTION' },
            relationships: { build: { data: { type: 'builds', id: 'missing' } } },
          },
          {
            type: 'appStoreVersions',
            id: 'v3',
            attributes: { versionString: '2.1.0', appVersionState: 'READY_FOR_DISTRIBUTION' },
            relationships: { build: { data: { type: 'builds', id: 'bad' } } },
          },
        ],
        included: [{ type: 'builds', id: 'bad', attributes: { version: 'not-a-number' } }],
      }),
    ).toEqual([]);
  });

  it('ignores non-build included resources sharing the build id', () => {
    expect(
      mapAcceptedVersions({
        data: [
          {
            type: 'appStoreVersions',
            id: 'v1',
            attributes: { versionString: '2.1.0', appVersionState: 'READY_FOR_DISTRIBUTION' },
            relationships: { build: { data: { type: 'builds', id: 'shared-id' } } },
          },
        ],
        included: [
          { type: 'appStoreVersionSubmissions', id: 'shared-id', attributes: { version: '999' } },
          { type: 'builds', id: 'shared-id', attributes: { version: '42' } },
        ],
      }),
    ).toEqual([
      {
        platform: 'ios',
        versionString: '2.1.0',
        buildNumber: 42,
        state: 'READY_FOR_DISTRIBUTION',
      },
    ]);
  });
});

describe('getAcceptedVersions', () => {
  const acceptedVersion = (id: string, buildId: string, buildNumber: string) => ({
    data: [
      {
        type: 'appStoreVersions' as const,
        id,
        attributes: { versionString: '2.1.0', appVersionState: 'READY_FOR_DISTRIBUTION' },
        relationships: { build: { data: { type: 'builds' as const, id: buildId } } },
      },
    ],
    included: [{ type: 'builds', id: buildId, attributes: { version: buildNumber } }],
  });

  it('follows trusted ASC pagination and maps builds from every page', async () => {
    const firstPage = acceptedVersion('v1', 'b1', '41');
    const secondPage = acceptedVersion('v2', 'b2', '42');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...firstPage,
            links: {
              next: 'https://api.appstoreconnect.apple.com/v1/apps/app-id/appStoreVersions?cursor=second',
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(secondPage), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAcceptedVersions('token', 'app-id')).resolves.toEqual([
      { platform: 'ios', versionString: '2.1.0', buildNumber: 41, state: 'READY_FOR_DISTRIBUTION' },
      { platform: 'ios', versionString: '2.1.0', buildNumber: 42, state: 'READY_FOR_DISTRIBUTION' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toEqual(
      new URL('https://api.appstoreconnect.apple.com/v1/apps/app-id/appStoreVersions?cursor=second'),
    );
  });

  it('rejects a cross-origin ASC pagination link before sending the token', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...acceptedVersion('v1', 'b1', '41'),
          links: { next: 'https://attacker.example/v1/apps/app-id/appStoreVersions?cursor=second' },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAcceptedVersions('token', 'app-id')).rejects.toThrow(/untrusted pagination link/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('mapAcceptedGoogleProductionReleases', () => {
  it.each(['RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED', 'RELEASE_LIFECYCLE_STATE_PUBLISHED'])(
    'maps exact Android versionCodes in accepted state %s',
    (state) => {
      expect(
        mapAcceptedGoogleProductionReleases([
          { releaseLifecycleState: state, activeArtifacts: [{ versionCode: 2_000_041 }, { versionCode: 2_000_042 }] },
        ]),
      ).toEqual([
        { platform: 'android', versionString: null, buildNumber: 2_000_041, state },
        { platform: 'android', versionString: null, buildNumber: 2_000_042, state },
      ]);
    },
  );

  it('drops draft, review, and rejected releases', () => {
    expect(
      mapAcceptedGoogleProductionReleases([
        {
          releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_DRAFT',
          activeArtifacts: [{ versionCode: 2_000_041 }],
        },
        {
          releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_IN_REVIEW',
          activeArtifacts: [{ versionCode: 2_000_042 }],
        },
        {
          releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_NOT_APPROVED',
          activeArtifacts: [{ versionCode: 2_000_043 }],
        },
      ]),
    ).toEqual([]);
  });

  it('deduplicates a versionCode and prefers PUBLISHED regardless of response order', () => {
    expect(
      mapAcceptedGoogleProductionReleases([
        {
          releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED',
          activeArtifacts: [{ versionCode: 2_000_041 }],
        },
        {
          releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED',
          activeArtifacts: [{ versionCode: 2_000_041 }],
        },
      ]),
    ).toEqual([
      {
        platform: 'android',
        versionString: null,
        buildNumber: 2_000_041,
        state: 'RELEASE_LIFECYCLE_STATE_PUBLISHED',
      },
    ]);
  });
});

describe('parseGoogleProductionReleasesResponse', () => {
  it('parses the official production release lifecycle shape', () => {
    expect(
      parseGoogleProductionReleasesResponse({
        releases: [
          {
            releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED',
            activeArtifacts: [{ versionCode: 2_000_042 }],
          },
        ],
      }),
    ).toEqual([
      {
        releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED',
        activeArtifacts: [{ versionCode: 2_000_042 }],
      },
    ]);
  });

  it.each([
    null,
    [],
    {},
    { releases: null },
    { releases: [{}] },
    { releases: [{ releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED' }] },
    { releases: [{ releaseLifecycleState: 'FUTURE_UNKNOWN_STATE', activeArtifacts: [] }] },
    { releases: [{ releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED', activeArtifacts: null }] },
    { releases: [{ releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED', activeArtifacts: [{}] }] },
    {
      releases: [
        { releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED', activeArtifacts: [{ versionCode: '2000042' }] },
      ],
    },
  ])('fails closed on unexpected response shape %#', (response) => {
    expect(() => parseGoogleProductionReleasesResponse(response)).toThrow(/Google Play/);
  });
});

describe('parseGoogleServiceAccount', () => {
  const serviceAccount = {
    client_email: 'release@example.iam.gserviceaccount.com',
    private_key: 'private-key',
    token_uri: 'https://oauth2.googleapis.com/token',
  };

  it('accepts plain or base64 JSON', () => {
    const json = JSON.stringify(serviceAccount);
    expect(parseGoogleServiceAccount(json)).toEqual(serviceAccount);
    expect(parseGoogleServiceAccount(Buffer.from(json).toString('base64'))).toEqual(serviceAccount);
  });

  it('rejects missing credential fields', () => {
    expect(() => parseGoogleServiceAccount('{}')).toThrow(/missing client_email/);
  });

  it.each([
    'http://oauth2.googleapis.com/token',
    'https://oauth2.googleapis.com/other',
    'https://oauth2.googleapis.com/token?redirect=https://evil.example',
    'https://oauth2.googleapis.com.evil.example/token',
    'https://evil.example/token',
  ])('rejects untrusted token_uri %s', (tokenUri) => {
    expect(() => parseGoogleServiceAccount(JSON.stringify({ ...serviceAccount, token_uri: tokenUri }))).toThrow(
      /token_uri must be https:\/\/oauth2.googleapis.com\/token/,
    );
  });
});
