import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { readMobileStoreRelease, resetMobileStoreReleaseCache } from '../mobile-store-release';
import { githubRequest, resolveGithubToken } from '../../lib/github-client';

vi.mock('../../lib/github-client', () => ({
  githubRequest: vi.fn(),
  resolveGithubToken: vi.fn(),
  resolveGithubRepo: () => 'boardsesh/boardsesh',
}));
vi.mock('../../utils/logger', () => ({ logger: { warn: vi.fn() } }));

const NOW = Date.parse('2026-10-06T00:00:00.000Z');
const snapshot = {
  schemaVersion: 1,
  checkedAt: new Date(NOW).toISOString(),
  latestVersion: '2.6.0',
  firstPublicAtByMinor: { '2.6': '2026-09-06T00:00:00.000Z' },
};

function mockSuccessfulSnapshot(payload: unknown = snapshot): void {
  vi.mocked(githubRequest)
    .mockResolvedValueOnce([{ id: 10, payload }])
    .mockResolvedValueOnce([{ state: 'success' }]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  vi.mocked(githubRequest).mockReset();
  vi.mocked(resolveGithubToken).mockReset().mockResolvedValue('test-token');
  resetMobileStoreReleaseCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('public mobile store release reader', () => {
  it('reads successful metadata with the canonical store URL and shares concurrent/cache reads', async () => {
    mockSuccessfulSnapshot();
    const [first, concurrent] = await Promise.all([
      readMobileStoreRelease('ios', '2.5.0'),
      readMobileStoreRelease('ios', '2.4.0'),
    ]);
    expect(first).toEqual({
      latestVersion: '2.6.0',
      checkedAt: snapshot.checkedAt,
      firstNewerMinorAvailableAt: snapshot.firstPublicAtByMinor['2.6'],
      storeUrl: 'https://apps.apple.com/app/boardsesh/id6761350784',
    });
    expect(concurrent).toEqual(first);
    expect(await readMobileStoreRelease('ios', '2.6.0')).toBeNull();
    expect(githubRequest).toHaveBeenCalledTimes(2);
    expect(githubRequest).toHaveBeenNthCalledWith(
      1,
      '/repos/boardsesh/boardsesh/deployments?environment=mobile-public-store-ios&per_page=10',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      'test-token',
    );
  });

  it('skips failed and unfinished runs until the latest completed successful snapshot', async () => {
    vi.mocked(githubRequest)
      .mockResolvedValueOnce([
        { id: 12, payload: snapshot },
        { id: 11, payload: snapshot },
        { id: 10, payload: JSON.stringify(snapshot) },
      ])
      .mockResolvedValueOnce([{ state: 'in_progress' }])
      .mockResolvedValueOnce([{ state: 'failure' }])
      .mockResolvedValueOnce([{ state: 'success' }]);
    expect((await readMobileStoreRelease('ios', '2.5.0'))?.latestVersion).toBe('2.6.0');
    expect(githubRequest).toHaveBeenCalledTimes(4);
  });

  it('walks deployments newest id first whatever order GitHub lists them in', async () => {
    vi.mocked(githubRequest)
      .mockResolvedValueOnce([
        { id: 10, payload: snapshot },
        {
          id: 12,
          payload: {
            ...snapshot,
            latestVersion: '2.7.0',
            firstPublicAtByMinor: { ...snapshot.firstPublicAtByMinor, '2.7': '2026-09-20T00:00:00.000Z' },
          },
        },
      ])
      .mockResolvedValueOnce([{ state: 'success' }]);
    expect((await readMobileStoreRelease('ios', '2.5.0'))?.latestVersion).toBe('2.7.0');
    expect(githubRequest).toHaveBeenNthCalledWith(
      2,
      '/repos/boardsesh/boardsesh/deployments/12/statuses?per_page=1',
      expect.anything(),
      'test-token',
    );
  });

  it.each([
    { ...snapshot, latestVersion: null },
    { ...snapshot, latestVersion: '2.4.0' },
    { ...snapshot, schemaVersion: 99 },
    '{invalid-json',
  ])(
    'does not resurrect older releases after a successful withdrawal, rollback, or malformed snapshot',
    async (payload) => {
      vi.mocked(githubRequest)
        .mockResolvedValueOnce([
          { id: 11, payload },
          { id: 10, payload: snapshot },
        ])
        .mockResolvedValueOnce([{ state: 'success' }]);
      expect(await readMobileStoreRelease('ios', '2.5.0')).toBeNull();
      expect(githubRequest).toHaveBeenCalledTimes(2);
    },
  );

  it('returns null for metadata older than 24 hours, even while its response is cached', async () => {
    mockSuccessfulSnapshot({ ...snapshot, checkedAt: new Date(NOW - 24 * 60 * 60 * 1000 + 1).toISOString() });
    expect(await readMobileStoreRelease('ios', '2.5.0')).not.toBeNull();
    vi.setSystemTime(NOW + 2);
    expect(await readMobileStoreRelease('ios', '2.5.0')).toBeNull();
    expect(githubRequest).toHaveBeenCalledTimes(2);
  });

  it('caches failed reads for ten minutes and retries after expiry', async () => {
    vi.mocked(githubRequest).mockRejectedValueOnce(new Error('403'));
    expect(await readMobileStoreRelease('ios', '2.5.0')).toBeNull();
    expect(await readMobileStoreRelease('ios', '2.5.0')).toBeNull();
    expect(githubRequest).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 10 * 60 * 1000);
    mockSuccessfulSnapshot();
    expect(await readMobileStoreRelease('ios', '2.5.0')).not.toBeNull();
    expect(githubRequest).toHaveBeenCalledTimes(3);
  });

  it('keeps platform caches and failures independent', async () => {
    vi.mocked(githubRequest).mockRejectedValueOnce(new Error('ios unavailable'));
    expect(await readMobileStoreRelease('ios', '2.5.0')).toBeNull();
    mockSuccessfulSnapshot();
    expect((await readMobileStoreRelease('android', '2.5.0'))?.storeUrl).toBe(
      'https://play.google.com/store/apps/details?id=com.boardsesh.app',
    );
    expect(await readMobileStoreRelease('ios', '2.5.0')).toBeNull();
    expect(githubRequest).toHaveBeenCalledTimes(3);
  });

  it('bounds token resolution by ten seconds and negative-caches the timeout', async () => {
    vi.mocked(resolveGithubToken).mockImplementationOnce(() => new Promise(() => undefined));
    const result = readMobileStoreRelease('ios', '2.5.0');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBeNull();
    expect(await readMobileStoreRelease('ios', '2.5.0')).toBeNull();
    expect(resolveGithubToken).toHaveBeenCalledTimes(1);
    expect(githubRequest).not.toHaveBeenCalled();
  });

  it('bounds stalled GitHub calls by ten seconds', async () => {
    vi.mocked(githubRequest).mockImplementationOnce(() => new Promise(() => undefined));
    const result = readMobileStoreRelease('ios', '2.5.0');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBeNull();
  });

  it('suppresses malformed versions and patch-only updates', async () => {
    mockSuccessfulSnapshot();
    expect(await readMobileStoreRelease('ios', 'unknown')).toBeNull();
    expect(await readMobileStoreRelease('ios', '2.6.0-beta')).toBeNull();
    expect(await readMobileStoreRelease('ios', '2.6.0')).toBeNull();
  });
});
