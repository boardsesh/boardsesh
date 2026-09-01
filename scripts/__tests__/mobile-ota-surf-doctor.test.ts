import { describe, expect, it } from 'vitest';
import {
  buildProbeHeaders,
  doctorExitCode,
  DEFAULT_BASE_URL,
  interpretProbe,
  OTA_APP_ID,
  OTA_CHANNEL,
  parseDoctorArgs,
  runSurfDoctor,
  stripManifestSuffix,
  summarizeReports,
  warnsAboutSharedRuntimeVersion,
  SURFING_DISABLED_HEADER,
  type FetchLike,
  type PlatformReport,
} from '../mobile-ota-surf-doctor';

const report = (overrides: Partial<PlatformReport> = {}): PlatformReport => ({
  platform: 'ios',
  runtimeVersion: 'abc',
  runtimeVersionSource: 'flag',
  state: 'branches',
  branches: [{ name: 'pr-1' }],
  total: 1,
  detail: 'HTTP 200, 1 branch',
  ...overrides,
});

/** A Response stand-in carrying only what interpretProbe reads. */
const answer = (status: number, headers: Record<string, string>, body: unknown): Response =>
  ({
    status,
    headers: new Headers(headers),
    json: async () => body,
  }) as unknown as Response;

describe('stripManifestSuffix', () => {
  it('drops the /manifest segment expo-updates points at', () => {
    expect(stripManifestSuffix('https://updates.boardsesh.com/manifest')).toBe('https://updates.boardsesh.com');
    expect(stripManifestSuffix('https://updates.boardsesh.com/manifest/')).toBe('https://updates.boardsesh.com');
  });

  it('leaves a bare base URL alone', () => {
    expect(stripManifestSuffix('https://updates.boardsesh.com')).toBe('https://updates.boardsesh.com');
  });
});

describe('parseDoctorArgs', () => {
  it('defaults to the production server and both platforms', () => {
    const args = parseDoctorArgs([], {});
    expect(args.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(args.platforms).toEqual(['ios', 'android']);
    expect(args.runtimeVersion).toBeNull();
    expect(args.json).toBe(false);
  });

  it('prefers EXPO_UPDATES_URL over the default, minus its /manifest', () => {
    expect(parseDoctorArgs([], { EXPO_UPDATES_URL: 'https://example.test/manifest' }).baseUrl).toBe(
      'https://example.test',
    );
  });

  it('lets OTA_BASE_URL win over EXPO_UPDATES_URL', () => {
    const args = parseDoctorArgs([], { OTA_BASE_URL: 'https://a.test', EXPO_UPDATES_URL: 'https://b.test/manifest' });
    expect(args.baseUrl).toBe('https://a.test');
  });

  it('reads flags in both --flag value and --flag=value form', () => {
    expect(parseDoctorArgs(['--runtime-version', 'deadbeef'], {}).runtimeVersion).toBe('deadbeef');
    expect(parseDoctorArgs(['--runtime-version=deadbeef'], {}).runtimeVersion).toBe('deadbeef');
  });

  it('narrows to one platform and ignores the vp -- separator', () => {
    expect(parseDoctorArgs(['--', '--platform', 'android'], {}).platforms).toEqual(['android']);
  });

  it('rejects an unknown platform rather than probing nothing', () => {
    expect(() => parseDoctorArgs(['--platform', 'web'], {})).toThrow(/Unknown --platform/);
  });
});

describe('buildProbeHeaders', () => {
  it('sends exactly what a binary sends, and no xprem-branch', () => {
    // An absent branch header is what "I am on the channel's own branch" looks
    // like — the state a tester is in before picking a PR.
    expect(buildProbeHeaders('abc123', 'ios')).toEqual({
      'expo-app-id': OTA_APP_ID,
      'expo-channel-name': OTA_CHANNEL,
      'expo-runtime-version': 'abc123',
      'expo-platform': 'ios',
    });
    expect(buildProbeHeaders('abc123', 'ios')).not.toHaveProperty('xprem-branch');
  });
});

describe('interpretProbe', () => {
  it('reads a 404 carrying the surfing header as "switched off"', () => {
    const outcome = interpretProbe(404, new Headers({ [SURFING_DISABLED_HEADER]: 'off' }), null);
    expect(outcome.state).toBe('surfing-off');
  });

  it('does NOT read a bare 404 as "switched off"', () => {
    // A bare 404 is a wrong base URL or a stray proxy. Conflating the two would
    // send someone to the dashboard to fix a setting that is already correct.
    const outcome = interpretProbe(404, new Headers(), null);
    expect(outcome.state).toBe('unreachable');
    expect(outcome.detail).toMatch(/base URL/);
  });

  it('separates an empty list from a populated one', () => {
    expect(interpretProbe(200, new Headers(), { branches: [], total: 0 }).state).toBe('no-branches');
    const populated = interpretProbe(200, new Headers(), {
      branches: [{ name: 'pr-42', lastUpdateAt: '2026-09-01T09:26:18Z' }],
      total: 1,
    });
    expect(populated.state).toBe('branches');
    expect(populated.branches).toEqual([{ name: 'pr-42', lastUpdateAt: '2026-09-01T09:26:18Z' }]);
  });

  it('keeps the server total even when the page is truncated', () => {
    const outcome = interpretProbe(200, new Headers(), { branches: [{ name: 'pr-1' }], total: 9 });
    expect(outcome.total).toBe(9);
  });

  it('treats a 200 with the wrong shape as unreachable, not as an empty list', () => {
    // A schema change must not read as "nothing to test" — that is the silent
    // failure this whole script exists to prevent.
    expect(interpretProbe(200, new Headers(), { error: 'nope' }).state).toBe('unreachable');
    expect(interpretProbe(200, new Headers(), null).state).toBe('unreachable');
  });

  it('reports any other status as unreachable', () => {
    expect(interpretProbe(500, new Headers(), null).state).toBe('unreachable');
    expect(interpretProbe(400, new Headers(), null).detail).toBe('HTTP 400');
  });
});

describe('doctorExitCode', () => {
  it('fails when any platform refuses to surf or is unreachable', () => {
    expect(doctorExitCode([report(), report({ platform: 'android', state: 'surfing-off' })])).toBe(1);
    expect(doctorExitCode([report({ state: 'unreachable' })])).toBe(1);
  });

  it('passes on an empty list — that is a diagnosis, not a build failure', () => {
    expect(doctorExitCode([report({ state: 'no-branches', branches: [], total: 0 })])).toBe(0);
  });
});

describe('summarizeReports', () => {
  it('points a switched-off channel at the dashboard toggle', () => {
    const text = summarizeReports([report({ state: 'surfing-off', branches: [], total: 0 })], 'https://x.test').join(
      '\n',
    );
    expect(text).toMatch(/Branch surfing is OFF/);
    expect(text).toMatch(/pattern pr-\*/);
  });

  it('explains an empty list as a possible fingerprint mismatch', () => {
    const text = summarizeReports([report({ state: 'no-branches', branches: [], total: 0 })], 'https://x.test').join(
      '\n',
    );
    expect(text).toMatch(/rebase to republish/);
  });

  it('warns that a locally resolved fingerprint may be a false alarm', () => {
    const text = summarizeReports([report({ runtimeVersionSource: 'resolved' })], 'https://x.test').join('\n');
    expect(text).toMatch(/not/);
    expect(text).toMatch(/deterministic across macOS and Linux/);
  });

  it('does not add that warning for an explicitly supplied fingerprint', () => {
    const text = summarizeReports([report({ runtimeVersionSource: 'flag' })], 'https://x.test').join('\n');
    expect(text).not.toMatch(/deterministic across macOS and Linux/);
  });

  it('lists each branch with its timestamp', () => {
    const text = summarizeReports(
      [report({ branches: [{ name: 'pr-4872', lastUpdateAt: '2026-09-01T11:06:04Z' }] })],
      'https://x.test',
    ).join('\n');
    expect(text).toMatch(/pr-4872.*2026-09-01T11:06:04Z/);
  });
});

describe('runSurfDoctor', () => {
  it('probes ?all=1 with the device headers and reports branches', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return answer(200, {}, { branches: [{ name: 'pr-7' }], total: 1 });
    };
    const code = await runSurfDoctor(
      { baseUrl: 'https://x.test', platforms: ['ios'], runtimeVersion: 'abc', json: true },
      fetchImpl,
      {},
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://x.test/branch_lists?all=1');
    expect(calls[0].headers['expo-runtime-version']).toBe('abc');
  });

  it('exits 1 when the channel refuses to surf', async () => {
    const fetchImpl: FetchLike = async () => answer(404, { [SURFING_DISABLED_HEADER]: 'off' }, null);
    const code = await runSurfDoctor(
      { baseUrl: 'https://x.test', platforms: ['ios'], runtimeVersion: 'abc', json: true },
      fetchImpl,
      {},
    );
    expect(code).toBe(1);
  });

  it('falls back to EXPO_UPDATES_FINGERPRINT_OVERRIDE when no flag is given', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push(init.headers['expo-runtime-version']);
      return answer(200, {}, { branches: [], total: 0 });
    };
    await runSurfDoctor(
      { baseUrl: 'https://x.test', platforms: ['ios'], runtimeVersion: null, json: true },
      fetchImpl,
      {
        EXPO_UPDATES_FINGERPRINT_OVERRIDE: 'from-env',
      },
    );
    expect(seen).toEqual(['from-env']);
  });

  it('turns a thrown request into unreachable rather than crashing', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const code = await runSurfDoctor(
      { baseUrl: 'https://x.test', platforms: ['ios'], runtimeVersion: 'abc', json: true },
      fetchImpl,
      {},
    );
    expect(code).toBe(1);
  });
});

describe('warnsAboutSharedRuntimeVersion', () => {
  const args = (over: Partial<Parameters<typeof warnsAboutSharedRuntimeVersion>[0]> = {}) => ({
    baseUrl: 'https://x.test',
    platforms: ['ios', 'android'] as ('ios' | 'android')[],
    runtimeVersion: 'abc',
    json: false,
    ...over,
  });

  it('warns when one fingerprint is applied to both platforms', () => {
    // iOS and Android fingerprints differ, so this would make one of them read
    // "no branches" for a reason that has nothing to do with the server.
    expect(warnsAboutSharedRuntimeVersion(args())).toBe(true);
  });

  it('stays quiet for a single platform', () => {
    expect(warnsAboutSharedRuntimeVersion(args({ platforms: ['ios'] }))).toBe(false);
  });

  it('stays quiet when each platform resolves its own fingerprint', () => {
    expect(warnsAboutSharedRuntimeVersion(args({ runtimeVersion: null }))).toBe(false);
  });
});
