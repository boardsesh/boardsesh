import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectAndroidVersions,
  main,
  nextStoreSnapshot,
  publicAndroidVersions,
  publicIosVersions,
  publishPlatform,
} from '../mobile-store-release-monitor';
const checkedAt = '2026-10-06T12:00:00.000Z';
const tags = ['build-android-v2.7.0-70-abcdef123456', 'build-android-v2.8.0-80-abcdef123456'];
const lifecycle = {
  releases: [
    {
      releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED',
      activeArtifacts: [{ versionCode: 70 }, { versionCode: 80 }],
    },
  ],
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('public native store collection', () => {
  it('requires ready and downloadable Apple versions', () => {
    const versions = [
      { attributes: { versionString: '2.7.0', appVersionState: 'READY_FOR_DISTRIBUTION' } },
      { attributes: { versionString: '2.8.0', appVersionState: 'PENDING_DEVELOPER_RELEASE' } },
    ];
    const territory = { attributes: { available: true, preOrderEnabled: false } };
    expect(publicIosVersions(versions, [territory], Date.parse(checkedAt))).toEqual(['2.7.0']);
    expect(publicIosVersions(versions, [], Date.parse(checkedAt))).toEqual([]);
    expect(
      publicIosVersions(versions, [{ attributes: { available: true, preOrderEnabled: true } }], Date.parse(checkedAt)),
    ).toEqual([]);
    expect(
      publicIosVersions(
        versions,
        [{ attributes: { available: false, preOrderEnabled: false } }],
        Date.parse(checkedAt),
      ),
    ).toEqual([]);
    expect(
      publicIosVersions(
        versions,
        [{ attributes: { available: true, preOrderEnabled: false, releaseDate: '2026-10-07' } }],
        Date.parse(checkedAt),
      ),
    ).toEqual([]);
  });
  it('intersects published lifecycle with completed rollout and resolves exact build tags', () => {
    expect(
      publicAndroidVersions(
        lifecycle,
        {
          releases: [
            { status: 'completed', versionCodes: ['70'] },
            { status: 'inProgress', versionCodes: ['80'] },
          ],
        },
        tags,
      ),
    ).toEqual(['2.7.0']);
    for (const status of ['draft', 'inProgress', 'halted'])
      expect(publicAndroidVersions(lifecycle, { releases: [{ status, versionCodes: ['70'] }] }, tags)).toEqual([]);
    expect(
      publicAndroidVersions(
        {
          releases: [
            {
              releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED',
              activeArtifacts: [{ versionCode: 70 }],
            },
          ],
        },
        { releases: [{ status: 'completed', versionCodes: ['70'] }] },
        tags,
      ),
    ).toEqual([]);
    expect(() =>
      publicAndroidVersions(lifecycle, { releases: [{ status: 'completed', versionCodes: ['70'] }] }, []),
    ).toThrow('one exact build tag');
    expect(() =>
      publicAndroidVersions(lifecycle, { releases: [{ status: 'completed', versionCodes: ['70'] }] }, [
        ...tags,
        'build-android-v2.7.0-70-123456abcdef',
      ]),
    ).toThrow('one exact build tag');
  });
  it('retains observed minor history through upgrades, withdrawal, rollback, and republishing', () => {
    const first = nextStoreSnapshot(null, ['2.6.0', '2.5.9', '2.7.0'], '2026-09-01T12:00:00.000Z');
    const upgrade = nextStoreSnapshot(first, ['2.8.0', '2.8.1'], checkedAt);
    expect(upgrade.latestVersion).toBe('2.8.1');
    expect(upgrade.firstPublicAtByMinor['2.7']).toBe(first.checkedAt);
    const withdrawn = nextStoreSnapshot(upgrade, [], checkedAt);
    expect(withdrawn.latestVersion).toBeNull();
    expect(withdrawn.firstPublicAtByMinor).toEqual(upgrade.firstPublicAtByMinor);
    expect(nextStoreSnapshot(withdrawn, ['2.7.1'], checkedAt).latestVersion).toBe('2.7.1');
    expect(nextStoreSnapshot(withdrawn, ['2.8.2'], checkedAt).firstPublicAtByMinor['2.8']).toBe(checkedAt);
  });
  it('fails closed on corrupt or future prior history', () => {
    const first = nextStoreSnapshot(null, ['2.7.0'], checkedAt);
    expect(() => nextStoreSnapshot({ ...first, firstPublicAtByMinor: {} }, ['2.8.0'], checkedAt)).toThrow(
      'Invalid prior',
    );
    expect(() => nextStoreSnapshot(first, [], '2026-09-01T12:00:00.000Z')).toThrow('Invalid prior');
  });
  it('rejects missing publishing identity before network access', async () => {
    vi.stubEnv(
      'GOOGLE_PLAY_MONITOR_SERVICE_ACCOUNT_JSON',
      JSON.stringify({ client_email: 'monitor@example.com', private_key: 'unused' }),
    );
    vi.stubEnv('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(collectAndroidVersions(tags)).rejects.toThrow('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('skips Android with a warning, and stays green, until the monitor credential exists', async () => {
    vi.stubEnv('GOOGLE_PLAY_MONITOR_SERVICE_ACCOUNT_JSON', '');
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    vi.stubEnv('GITHUB_REPOSITORY', 'boardsesh/boardsesh');
    vi.stubEnv('DRY_RUN', 'true');
    const fetchMock = vi.fn(async (_url: string) => Response.json([]));
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const android = vi.fn(async () => ['2.7.0']);
    expect(await main({ ios: async () => ['2.7.0'], android })).toBe(0);
    expect(android).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('::warning::Play monitor credential not configured');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('environment=mobile-public-store-ios'),
    ]);
    log.mockRestore();
  });
  it('rejects a publishing account reused for monitoring before network access', async () => {
    const credential = JSON.stringify({ client_email: 'publisher@example.com', private_key: 'unused' });
    vi.stubEnv('GOOGLE_PLAY_MONITOR_SERVICE_ACCOUNT_JSON', credential);
    vi.stubEnv('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', credential);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(collectAndroidVersions(tags)).rejects.toThrow('different client_email');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('dry runs preserve prior history without deployment writes', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    vi.stubEnv('GITHUB_REPOSITORY', 'boardsesh/boardsesh');
    vi.stubEnv('DRY_RUN', 'true');
    const first = nextStoreSnapshot(null, ['2.7.0'], '2026-09-01T12:00:00.000Z');
    const fetchMock = vi.fn(async () => Response.json([{ payload: first }]));
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await publishPlatform('ios', ['2.8.0'], checkedAt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(log.mock.calls[0]![0].split('dry run: ')[1]);
    expect(logged.firstPublicAtByMinor['2.7']).toBe(first.checkedAt);
    log.mockRestore();
  });
  it('malformed deployment history blocks writes instead of resetting', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    vi.stubEnv('GITHUB_REPOSITORY', 'boardsesh/boardsesh');
    vi.stubEnv('DRY_RUN', 'false');
    const fetchMock = vi.fn(async () => Response.json([{ payload: { schemaVersion: 0 } }]));
    vi.stubGlobal('fetch', fetchMock);
    await expect(publishPlatform('android', ['2.8.0'], checkedAt)).rejects.toThrow('Malformed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('publishes complete rollback snapshots and marks success', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    vi.stubEnv('GITHUB_REPOSITORY', 'boardsesh/boardsesh');
    vi.stubEnv('GITHUB_SHA', 'test-sha');
    vi.stubEnv('DRY_RUN', 'false');
    const first = nextStoreSnapshot(null, ['2.7.0', '2.8.0'], '2026-09-01T12:00:00.000Z');
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === 'GET') return Response.json([{ payload: first }]);
      return Response.json({ id: 100 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await publishPlatform('android', ['2.7.0'], checkedAt);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string).payload).toEqual({
      ...first,
      checkedAt,
      latestVersion: '2.7.0',
    });
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body as string).state).toBe('success');
  });
  it('discards Google edits even after track reads fail and never commits', async () => {
    vi.stubEnv(
      'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
      JSON.stringify({ client_email: 'publisher@example.com', private_key: 'unused' }),
    );
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    vi.stubEnv(
      'GOOGLE_PLAY_MONITOR_SERVICE_ACCOUNT_JSON',
      JSON.stringify({
        client_email: 'monitor@example.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      }),
    );
    const requests: { url: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit) => {
        requests.push({ url, method: options.method ?? 'GET' });
        if (url.includes('oauth2')) return Response.json({ access_token: 'token' });
        if (url.endsWith('/tracks/production/releases')) return Response.json(lifecycle);
        if (url.endsWith('/edits')) return Response.json({ id: 'read-only-edit' });
        if (url.endsWith('/tracks/production')) return new Response('failure', { status: 403 });
        return new Response(null, { status: 204 });
      }),
    );
    await expect(collectAndroidVersions(tags)).rejects.toThrow('HTTP 403');
    expect(requests.at(-1)).toEqual({
      url: 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.boardsesh.app/edits/read-only-edit',
      method: 'DELETE',
    });
    expect(requests.some((request) => request.url.includes('commit'))).toBe(false);
  });
});
