/// <reference types="node" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAppStoreVersions } from './mobile-auto-version-bump';
import {
  mapPublicIosBuilds,
  PUBLIC_ANDROID_STATE,
  PUBLIC_IOS_STATE,
  resolveLiveStoreRuntimes,
} from './mobile-live-store-runtimes';
import {
  isReleaseTrainActive,
  LIVE_STORE_MAX_AGE_MS,
  mayPublishTrainRuntime,
  parseLiveStoreRuntimes,
  readMarketingVersion,
  stableCandidateMatchesLiveRuntimes,
} from './lib/mobile-release-policy';

const NOW = Date.parse('2026-10-19T01:00:00Z');
const IOS_RUNTIME = 'a'.repeat(40);
const ANDROID_RUNTIME = 'b'.repeat(40);
const TRAIN_RUNTIME = 'c'.repeat(40);
const COMMIT = 'd'.repeat(40);
const publicBuilds = [
  { platform: 'ios' as const, versionString: '2.6.0', buildNumber: 41, state: PUBLIC_IOS_STATE },
  { platform: 'android' as const, versionString: null, buildNumber: 42, state: PUBLIC_ANDROID_STATE },
];
const tags = [
  `build-ios-v2.6.0-41-${IOS_RUNTIME.slice(0, 12)}`,
  `fingerprint-ios-${IOS_RUNTIME}`,
  `build-android-v2.6.0-42-${ANDROID_RUNTIME.slice(0, 12)}`,
  `fingerprint-android-${ANDROID_RUNTIME}`,
];
const live = () => resolveLiveStoreRuntimes(publicBuilds, tags, () => COMMIT, NOW);

afterEach(() => vi.unstubAllGlobals());

describe('release train policy', () => {
  it('compares literal marketing versions without running configuration', () => {
    const config = (version: string) => `throw new Error('never execute');\nversion: '${version}',\n`;
    expect(readMarketingVersion(config('2.6.0'))).toBe('2.6.0');
    expect(isReleaseTrainActive(config('2.6.0'), config('2.6.1'))).toBe(true);
    expect(isReleaseTrainActive(config('2.6.0'), config('2.6.0'))).toBe(false);
    expect(() => readMarketingVersion('version: process.env.VERSION,\n')).toThrow();
    expect(() => readMarketingVersion(config('2.6.0') + config('2.6.1'))).toThrow();
  });

  it('protects the store fleet even after main already moved to a newer native runtime', () => {
    expect(mayPublishTrainRuntime(live(), 'ios', IOS_RUNTIME)).toBe(false);
    expect(mayPublishTrainRuntime(live(), 'ios', TRAIN_RUNTIME)).toBe(true);
    expect(mayPublishTrainRuntime(live(), 'android', ANDROID_RUNTIME)).toBe(false);
    expect(mayPublishTrainRuntime(live(), 'ios', 'unknown')).toBe(false);
  });

  it('soaks only when both candidate platforms match the current public stores', () => {
    expect(stableCandidateMatchesLiveRuntimes(live(), { ios: IOS_RUNTIME, android: ANDROID_RUNTIME })).toBe(true);
    expect(stableCandidateMatchesLiveRuntimes(live(), { ios: TRAIN_RUNTIME, android: ANDROID_RUNTIME })).toBe(false);
    expect(stableCandidateMatchesLiveRuntimes(live(), { ios: IOS_RUNTIME, android: TRAIN_RUNTIME })).toBe(false);
  });

  it('validates full hashes, schema, provenance and freshness', () => {
    expect(parseLiveStoreRuntimes(live(), NOW)).toEqual(live());
    for (const bad of [
      null,
      {},
      { ...live(), schemaVersion: 2 },
      { ...live(), checkedAt: 'invalid' },
      { ...live(), ios: { ...live().ios, runtimeVersion: 'a'.repeat(12) } },
      { ...live(), ios: { ...live().ios, protectedRuntimeVersions: [] } },
      { ...live(), android: { ...live().android, buildNumber: 99 } },
    ]) {
      expect(() => parseLiveStoreRuntimes(bad, NOW)).toThrow();
    }
    expect(() => parseLiveStoreRuntimes(live(), NOW + LIVE_STORE_MAX_AGE_MS + 1)).toThrow(/stale/);
    expect(() => parseLiveStoreRuntimes(live(), NOW - 61_000)).toThrow(/stale/);
  });
});

describe('live store runtime resolution', () => {
  it('maps exact public builds through immutable build tags to full fingerprints', () => {
    const resolvedTags: string[] = [];
    const resolved = resolveLiveStoreRuntimes(
      publicBuilds,
      tags,
      (tag) => {
        resolvedTags.push(tag);
        return COMMIT;
      },
      NOW,
    );
    expect(resolved.ios).toMatchObject({
      version: '2.6.0',
      buildNumber: 41,
      runtimeVersion: IOS_RUNTIME,
      commit: COMMIT,
    });
    expect(resolved.android).toMatchObject({ version: '2.6.0', buildNumber: 42, runtimeVersion: ANDROID_RUNTIME });
    expect(resolvedTags).toEqual([tags[0], tags[2]]);
  });

  it('excludes approved-unpublished Android and tester-only iOS builds', () => {
    const pending = [
      ...publicBuilds,
      { platform: 'ios' as const, versionString: '2.7.0', buildNumber: 50, state: 'PENDING_DEVELOPER_RELEASE' },
      {
        platform: 'android' as const,
        versionString: null,
        buildNumber: 51,
        state: 'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED',
      },
    ];
    expect(resolveLiveStoreRuntimes(pending, tags, () => COMMIT, NOW)).toEqual(live());
    expect(() => resolveLiveStoreRuntimes(pending.slice(2), tags, () => COMMIT, NOW)).toThrow(/No publicly released/);
  });

  it('selects newest public build while protecting every active phased-rollout runtime', () => {
    const newerBuilds = [
      ...publicBuilds,
      { platform: 'android' as const, versionString: null, buildNumber: 43, state: PUBLIC_ANDROID_STATE },
    ];
    const newerTags = [
      ...tags,
      `build-android-v2.7.0-43-${TRAIN_RUNTIME.slice(0, 12)}`,
      `fingerprint-android-${TRAIN_RUNTIME}`,
    ];
    const resolved = resolveLiveStoreRuntimes(newerBuilds, newerTags, () => COMMIT, NOW);
    expect(resolved.android.runtimeVersion).toBe(TRAIN_RUNTIME);
    expect(resolved.android.protectedRuntimeVersions).toEqual([TRAIN_RUNTIME, ANDROID_RUNTIME]);
    expect(mayPublishTrainRuntime(resolved, 'android', ANDROID_RUNTIME)).toBe(false);
  });

  it.each([
    ['missing build', tags.filter((tag) => !tag.startsWith('build-ios'))],
    ['missing full fingerprint', tags.filter((tag) => !tag.startsWith('fingerprint-ios'))],
    ['ambiguous build', [...tags, `build-ios-v2.6.0-41-${TRAIN_RUNTIME.slice(0, 12)}`]],
    ['ambiguous full fingerprint', [...tags, `fingerprint-ios-${IOS_RUNTIME.slice(0, 12)}${'f'.repeat(28)}`]],
  ])('fails closed on %s evidence', (_label, configuredTags) => {
    expect(() => resolveLiveStoreRuntimes(publicBuilds, configuredTags, () => COMMIT, NOW)).toThrow(/unique/);
  });
});

describe('public iOS store evidence', () => {
  const response = {
    data: [
      {
        type: 'appStoreVersions' as const,
        id: 'version-1',
        attributes: { versionString: '2.6.0', appVersionState: PUBLIC_IOS_STATE },
        relationships: { build: { data: { type: 'builds' as const, id: 'build-41' } } },
      },
    ],
    included: [{ type: 'builds', id: 'build-41', attributes: { version: '41' } }],
  };
  it('requires the exact attached public build and ignores approvals awaiting release', () => {
    expect(mapPublicIosBuilds(response)).toEqual([publicBuilds[0]]);
    expect(
      mapPublicIosBuilds({
        ...response,
        data: [
          {
            ...response.data[0]!,
            attributes: { versionString: '2.6.1', appVersionState: 'PENDING_DEVELOPER_RELEASE' },
          },
        ],
      }),
    ).toEqual([]);
    expect(() => mapPublicIosBuilds({ ...response, included: [] })).toThrow(/exact build identity/);
  });

  it('treats only the newest released version as live, since ASC never retires the state', () => {
    const released = (id: string, versionString: string, buildId: string) => ({
      type: 'appStoreVersions' as const,
      id,
      attributes: { versionString, appVersionState: PUBLIC_IOS_STATE },
      relationships: { build: { data: { type: 'builds' as const, id: buildId } } },
    });
    const history = {
      data: [
        released('version-legacy', '2.0', 'build-legacy'),
        released('version-old', '2.5.0', 'build-missing'),
        response.data[0]!,
        released('version-ancient', '1.2', 'build-ancient'),
      ],
      included: [...response.included, { type: 'builds', id: 'build-legacy', attributes: { version: '100399' } }],
    };
    expect(mapPublicIosBuilds(history)).toEqual([publicBuilds[0]]);
    expect(() =>
      mapPublicIosBuilds({ ...history, data: [...history.data, released('version-dup', '2.6.0', 'build-41')] }),
    ).toThrow(/share a version string/);
    expect(() =>
      mapPublicIosBuilds({ ...history, data: [...history.data, released('version-bad', '2.6.0-beta', 'build-41')] }),
    ).toThrow(/comparable version string/);
  });

  it('compares version parts as numbers, not text', () => {
    const released = (id: string, versionString: string) => ({
      type: 'appStoreVersions' as const,
      id,
      attributes: { versionString, appVersionState: PUBLIC_IOS_STATE },
      relationships: { build: { data: { type: 'builds' as const, id: `build-${id}` } } },
    });
    const included = ['nine', 'ten'].map((id) => ({ type: 'builds', id: `build-${id}`, attributes: { version: '7' } }));
    expect(
      mapPublicIosBuilds({ data: [released('ten', '2.10.0'), released('nine', '2.9.0')], included }),
    ).toMatchObject([{ versionString: '2.10.0' }]);
    expect(
      mapPublicIosBuilds({ data: [released('nine', '2.9.0'), released('ten', '2.10.0')], included }),
    ).toMatchObject([{ versionString: '2.10.0' }]);
    expect(() => mapPublicIosBuilds({ data: [released('nine', '2.0'), released('ten', '2.0.0')], included })).toThrow(
      /share a version string/,
    );
  });

  it('queries only publicly distributed iOS versions and prevents credential redirects', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getAppStoreVersions('token', 'app-id', [PUBLIC_IOS_STATE])).toEqual(response);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(new URL(url instanceof Request ? url.url : url).searchParams.get('filter[appVersionState]')).toBe(
      PUBLIC_IOS_STATE,
    );
    expect(options?.redirect).toBe('error');
  });
});
