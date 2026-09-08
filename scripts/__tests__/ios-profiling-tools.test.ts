import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportBuiltApp } from '../lib/ios-build-export';
import { resolveMetroHostname } from '../lib/metro-host';
import { acquireSimulatorLease, guardSimulatorCommand, selectSimulatorUdid } from '../lib/ios-simulator-lease';
import {
  assertMatchingIdentity,
  hasUsefulStartupArtifact,
  validateCaptureFiles,
  type IosAppIdentity,
} from '../lib/ios-profile-identity';
import { extractIosDeviceArgs } from '../mobile-ios-run';
import { parseProfileArgs } from '../mobile-profile-ios';

const scratch: string[] = [];
const udid = '561A4D7D-12C6-4B27-A956-A69C4436F4BE';
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'boardsesh-profile-test-'));
  scratch.push(path);
  return path;
}
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Metro host resolution', () => {
  it.each([['--host', 'localhost'], ['--host=localhost'], ['--localhost']])('advertises loopback for %j', (...args) => {
    const fallback = vi.fn(() => ({ hostname: 'host.ts.net', source: 'tailscale' as const }));
    expect(resolveMetroHostname(args, fallback).hostname).toBe('localhost');
    expect(fallback).not.toHaveBeenCalled();
  });
  it('keeps the default resolver for LAN', () => {
    expect(resolveMetroHostname(['--lan'], () => ({ hostname: 'host.ts.net', source: 'tailscale' })).hostname).toBe(
      'host.ts.net',
    );
  });
});

describe('validated build exports', () => {
  it('never publishes a stale product after a failed build', () => {
    const root = directory();
    const built = join(root, 'built.app');
    const exported = join(root, 'out/Boardsesh.app');
    mkdirSync(built);
    mkdirSync(exported, { recursive: true });
    writeFileSync(join(built, 'Info.plist'), 'plist');
    writeFileSync(join(built, 'Boardsesh'), 'stale');
    writeFileSync(join(exported, 'Boardsesh'), 'previous good');
    expect(() => exportBuiltApp(65, built, join(root, 'out'))).toThrow(/refusing any pre-existing/);
    expect(readFileSync(join(exported, 'Boardsesh'), 'utf8')).toBe('previous good');
  });
  it('preserves the prior export when a successful build produced an incomplete app', () => {
    const root = directory();
    mkdirSync(join(root, 'out/Boardsesh.app'), { recursive: true });
    writeFileSync(join(root, 'out/Boardsesh.app/Boardsesh'), 'previous');
    expect(() => exportBuiltApp(0, join(root, 'missing.app'), join(root, 'out'))).toThrow(/complete/);
    expect(readFileSync(join(root, 'out/Boardsesh.app/Boardsesh'), 'utf8')).toBe('previous');
  });
  it('publishes a validated successful build', () => {
    const root = directory();
    const built = join(root, 'built.app');
    mkdirSync(built);
    writeFileSync(join(built, 'Info.plist'), 'plist');
    writeFileSync(join(built, 'Boardsesh'), 'new');
    const destination = exportBuiltApp(0, built, join(root, 'out'));
    expect(readFileSync(join(destination, 'Boardsesh'), 'utf8')).toBe('new');
  });
});

describe('simulator ownership', () => {
  it('refuses foreign active ownership, including old leases', () => {
    const root = directory();
    const leases = join(root, 'leases');
    const lease = acquireSimulatorLease(udid, root, leases);
    expect(() => acquireSimulatorLease(udid, directory(), leases)).toThrow(/leased by/);
    lease.release();
    expect(existsSync(join(leases, `${udid}.lock`))).toBe(false);
  });
  it('allows explicit inherited ownership without releasing its parent', () => {
    const root = directory();
    const leases = join(root, 'leases');
    const parent = acquireSimulatorLease(udid, root, leases);
    const child = acquireSimulatorLease(udid, root, leases, parent.owner.token);
    child.release();
    expect(existsSync(join(leases, `${udid}.lock`))).toBe(true);
    parent.release();
  });
  it('does not steal an incomplete lease', () => {
    const root = directory();
    const leases = join(root, 'leases');
    mkdirSync(join(leases, `${udid}.lock`), { recursive: true });
    expect(() => acquireSimulatorLease(udid, root, leases)).toThrow(/incomplete lease/);
  });
  it('rejects ambiguous booted selection at the command boundary', () => {
    expect(() => guardSimulatorCommand('xcrun', ['simctl', 'shutdown', 'booted'], directory())).toThrow(
      /explicit UDID/,
    );
  });
  it('does not select the only booted simulator when a different device was requested', () => {
    const devices = [{ udid, name: 'Someone else simulator', state: 'Booted' }];
    expect(() => selectSimulatorUdid(devices, 'Owned simulator')).toThrow(/Select exactly one/);
    expect(selectSimulatorUdid(devices, udid)).toBe(udid);
  });
  it('leaves Android Maestro commands alone', () => {
    expect(() => guardSimulatorCommand('maestro', ['--device', 'emulator-5554', 'test'], directory())).not.toThrow();
  });
});

const identity: IosAppIdentity = {
  bundleIdentifier: 'app',
  executableUuid: 'uuid',
  executableSha256: 'binary',
  embeddedBundleSha256: 'bundle',
};
describe('capture validity', () => {
  it.each(['executableUuid', 'executableSha256', 'embeddedBundleSha256', 'bundleIdentifier'] as const)(
    'rejects a changed %s',
    (field) => {
      expect(() => assertMatchingIdentity(identity, { ...identity, [field]: 'foreign' })).toThrow(/identity changed/);
    },
  );
  it('rejects incomplete captures', () => {
    expect(() => validateCaptureFiles({}, { valid: false })).toThrow(/incomplete/);
    expect(() => validateCaptureFiles({}, {})).toThrow(/incomplete/);
    expect(() => validateCaptureFiles(null, { valid: true })).toThrow(/missing/);
    expect(() => validateCaptureFiles({}, { valid: true })).toThrow(/incomplete/);
  });
  it('requires an explicit simulator for profiling', () => {
    expect(() => parseProfileArgs(['--udid', 'booted'])).toThrow(/explicitly owned/);
    expect(parseProfileArgs(['--udid', udid, '--configuration', 'Debug', '--port', '8097']).port).toBe(8097);
  });
  it.each([['--device', udid], ['-d', udid], [`--device=${udid}`]])('normalizes Expo device flags %j', (...flags) => {
    expect(extractIosDeviceArgs(['--no-bundler', ...flags])).toEqual({ requested: udid, remaining: ['--no-bundler'] });
  });
});

const require = createRequire(import.meta.url);
const { configureWatchman } = require('../../packages/mobile/metro-watchman.cjs') as {
  configureWatchman: (
    config: { resolver: { useWatchman: boolean | null } },
    env: Record<string, string>,
    run: () => { status: number | null },
  ) => void;
};
describe('Watchman opt-in', () => {
  it('does not probe or alter Expo defaults when disabled', () => {
    const config = { resolver: { useWatchman: null } };
    const probe = vi.fn(() => ({ status: 0 }));
    configureWatchman(config, {}, probe);
    expect(config.resolver.useWatchman).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
  it('fails explicitly when Watchman is unavailable', () => {
    expect(() =>
      configureWatchman({ resolver: { useWatchman: null } }, { BOARDSESH_METRO_USE_WATCHMAN: '1' }, () => ({
        status: null,
      })),
    ).toThrow(/available Watchman/);
  });
  it('enables available Watchman only when requested', () => {
    const config = { resolver: { useWatchman: null } };
    configureWatchman(config, { BOARDSESH_METRO_USE_WATCHMAN: '1' }, () => ({ status: 0 }));
    expect(config.resolver.useWatchman).toBe(true);
  });
});

describe('complete comparison sample counts', () => {
  const navigation = Array.from({ length: 20 }, (_, index) => ({
    loop: Math.floor(index / 4) + 1,
    route: ['home', 'climbs', 'discover', 'profile'][index % 4],
    observation: { gaps: [16.7] },
    routeConfirmed: true,
    nativeSampleComplete: true,
  }));
  const debug = { configuration: 'Debug', warmupLoops: 2, measuredLoops: 5, navigation };
  const verdict = { valid: true, completed: true, configuration: 'Debug' };
  it('accepts all five measured loops after two warmups', () => {
    expect(() => validateCaptureFiles(debug, verdict)).not.toThrow();
  });
  it('rejects missing loops and callback observations', () => {
    expect(() => validateCaptureFiles({ ...debug, navigation: navigation.slice(1) }, verdict)).toThrow(
      /Incomplete Debug/,
    );
    expect(() =>
      validateCaptureFiles(
        { ...debug, navigation: navigation.map((entry) => ({ ...entry, observation: { gaps: [] } })) },
        verdict,
      ),
    ).toThrow(/Invalid navigation/);
  });
  it('rejects missing Release launches and memory samples even with a successful verdict', () => {
    expect(() =>
      validateCaptureFiles(
        { configuration: 'Release', launches: [], memory: [] },
        { valid: true, completed: true, configuration: 'Release' },
      ),
    ).toThrow(/Incomplete Release/);
  });
});

function releaseCapture() {
  return {
    configuration: 'Release',
    launches: Array.from({ length: 10 }, (_, index) => ({
      trial: index + 1,
      hostExportObservedMs: 2500,
      artifact: {
        runId: `runtime-${index + 1}`,
        marks: [{ name: 'home.useful.commit', timestampMs: 1500, outcome: 'content' }],
      },
    })),
    memory: Array.from({ length: 20 }, (_, index) => ({ cycle: index + 1, pid: 1234, footprintMiB: 250 })),
  };
}
const releaseVerdict = { valid: true, completed: true, configuration: 'Release' };

describe('Release artifact integrity', () => {
  it('accepts ten distinct useful launches and twenty cycles in one process', () => {
    expect(() => validateCaptureFiles(releaseCapture(), releaseVerdict)).not.toThrow();
  });
  it.each(['content', 'empty', 'offline', 'error'])('accepts the visible %s outcome', (outcome) => {
    expect(
      hasUsefulStartupArtifact({ runId: 'runtime', marks: [{ name: 'home.useful.commit', timestampMs: 0, outcome }] }),
    ).toBe(true);
  });
  it.each([null, {}, [], { runId: 'runtime' }, { runId: 'runtime', marks: [null] }])(
    'rejects malformed artifact %j',
    (artifact) => {
      expect(hasUsefulStartupArtifact(artifact)).toBe(false);
      const recorded = releaseCapture();
      expect(() =>
        validateCaptureFiles(
          {
            ...recorded,
            launches: recorded.launches.map((launch, index) => (index === 0 ? { ...launch, artifact } : launch)),
          },
          releaseVerdict,
        ),
      ).toThrow(/Invalid or stale/);
    },
  );
  it.each(['', ' ', '\t\n'])('rejects empty runtime identity %j', (runId) => {
    const recorded = releaseCapture();
    recorded.launches[0].artifact.runId = runId;
    expect(() => validateCaptureFiles(recorded, releaseVerdict)).toThrow(/Invalid or stale/);
  });
  it.each([NaN, Infinity, -Infinity, -1, undefined, null, '1500'])(
    'rejects invalid useful timestamp %j',
    (timestampMs) => {
      const recorded = releaseCapture();
      const artifact = {
        runId: 'runtime-first',
        marks: [{ name: 'home.useful.commit', timestampMs, outcome: 'content' }],
      };
      expect(hasUsefulStartupArtifact(artifact)).toBe(false);
      expect(() =>
        validateCaptureFiles(
          { ...recorded, launches: [{ ...recorded.launches[0], artifact }, ...recorded.launches.slice(1)] },
          releaseVerdict,
        ),
      ).toThrow(/Invalid or stale/);
    },
  );
  it.each([
    [],
    [{ name: 'root.commit', timestampMs: 10 }],
    [{ name: 'home.useful.commit', timestampMs: 10, outcome: 'loading' }],
    [{ name: 'home.useful.commit', timestampMs: 10 }],
    [
      { name: 'home.useful.commit', timestampMs: 10, outcome: 'content' },
      { name: 'home.useful.commit', timestampMs: 20, outcome: 'empty' },
    ],
  ])('rejects missing, loading, or ambiguous useful commits %j', (...marks) => {
    // Vitest spreads array table rows; restore the artifact marks array.
    const recorded = releaseCapture();
    expect(() =>
      validateCaptureFiles(
        {
          ...recorded,
          launches: [
            { ...recorded.launches[0], artifact: { runId: 'runtime-first', marks } },
            ...recorded.launches.slice(1),
          ],
        },
        releaseVerdict,
      ),
    ).toThrow(/Invalid or stale/);
  });
  it('rejects a reused launch runtime and a changed memory process', () => {
    const stale = releaseCapture();
    stale.launches[1].artifact.runId = stale.launches[0].artifact.runId;
    expect(() => validateCaptureFiles(stale, releaseVerdict)).toThrow(/Invalid or stale/);
    const switched = releaseCapture();
    switched.memory[10].pid += 1;
    expect(() => validateCaptureFiles(switched, releaseVerdict)).toThrow(/changed process/);
  });
});

function debugCapture() {
  return {
    configuration: 'Debug',
    warmupLoops: 2,
    measuredLoops: 5,
    capability: { react: { available: true, complete: true }, nativeSample: { complete: true } },
    navigation: Array.from({ length: 20 }, (_, index) => ({
      loop: Math.floor(index / 4) + 1,
      route: ['home', 'climbs', 'discover', 'profile'][index % 4],
      routeConfirmed: true,
      nativeSampleComplete: false,
      observation: { gaps: [16.7] },
    })),
  };
}
const debugVerdict = { valid: true, completed: true, configuration: 'Debug' };

describe('Debug attribution and navigation integrity', () => {
  it('accepts complete React attribution without native sampling', () => {
    expect(() => validateCaptureFiles(debugCapture(), debugVerdict)).not.toThrow();
  });
  it('accepts all complete in-scenario native samples as an explicit React fallback', () => {
    const recorded = debugCapture();
    recorded.capability.react = { available: false, complete: false };
    for (const observation of recorded.navigation) observation.nativeSampleComplete = true;
    expect(() => validateCaptureFiles(recorded, debugVerdict)).not.toThrow();
  });
  it.each([false, undefined, 'true'])('rejects an unconfirmed destination %j', (routeConfirmed) => {
    const recorded = debugCapture();
    expect(() =>
      validateCaptureFiles(
        {
          ...recorded,
          navigation: recorded.navigation.map((observation, index) =>
            index === 7 ? { ...observation, routeConfirmed } : observation,
          ),
        },
        debugVerdict,
      ),
    ).toThrow(/Invalid navigation/);
  });
  it.each([
    {},
    { react: { available: true } },
    { react: { available: true, complete: false }, nativeSample: { complete: true } },
    { react: { available: false, complete: true } },
  ])('rejects missing attribution despite an idle terminal sample %j', (capability) => {
    expect(() => validateCaptureFiles({ ...debugCapture(), capability }, debugVerdict)).toThrow(
      /neither complete React/,
    );
  });
  it('rejects one incomplete scenario when React attribution is unavailable', () => {
    const recorded = debugCapture();
    recorded.capability.react = { available: false, complete: false };
    for (const observation of recorded.navigation) observation.nativeSampleComplete = true;
    recorded.navigation[12].nativeSampleComplete = false;
    expect(() => validateCaptureFiles(recorded, debugVerdict)).toThrow(/neither complete React/);
  });
});
