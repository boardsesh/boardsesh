import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseArgs as parseBuildArgs } from '../mobile-build-sim-app';
import {
  assertCanonicalCrewToolchain,
  crewCrossBuildArchitecture,
  CREW_CROSS_FORMAT,
  CREW_DEVELOPER_DIR,
  type CrewToolchainIdentity,
} from '../lib/ios-simulator-architecture.mjs';
import {
  assertCrewConsumerRuntime,
  assertCrewManifest,
  assertCrewSdkInventory,
  assertSelectedCrewRuntime,
  crewAppTree,
  inspectCrewApp,
  packCrewApp,
  parseCrewMachOBuild,
  verifyCrewArtifact,
  type CrewInspect,
  type CrewReceipt,
} from '../lib/ios-crew-cross-artifact.mjs';
const digest = 'a'.repeat(64),
  sourceSha = 'b'.repeat(40);
const toolchain: CrewToolchainIdentity = {
  developerDir: CREW_DEVELOPER_DIR,
  realDeveloperDir: CREW_DEVELOPER_DIR,
  realAppPath: '/Applications/Xcode_27.1.app',
  compilerPath: `${CREW_DEVELOPER_DIR}/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-driver`,
  xcodeVersion: '27.1',
  xcodeBuild: '27A9275',
  sdkVersion: '27.1',
  sdkBuild: '24A94232',
  sdkPath: `${CREW_DEVELOPER_DIR}/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator27.1.sdk`,
  realSdkPath: `${CREW_DEVELOPER_DIR}/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator27.1.sdk`,
  swiftVersion: 'Apple Swift version 6.4 (fixture only; actual patch/tag must be observed)',
};
const receipt: CrewReceipt = {
  format: CREW_CROSS_FORMAT,
  sourceSha,
  workflowSha: 'c'.repeat(40),
  runId: '123',
  runAttempt: '1',
  toolingSha256: digest,
  hostArchitecture: 'arm64',
  targetArchitecture: 'x86_64',
  toolchain,
  sdkSupportVerified: true,
  sdkInventorySha256: digest,
};
const fixtures = JSON.parse(readFileSync('scripts/__tests__/fixtures/crew-cross-macho.json', 'utf8')) as {
  main: string;
  vendor: string;
  legacy: string;
};
const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), '7154-cross-'));
  scratch.push(path);
  return path;
}
const plist = () => ({
  CFBundleIdentifier: 'com.boardsesh.app',
  CFBundleExecutable: 'Boardsesh',
  CFBundleSupportedPlatforms: ['iPhoneSimulator'],
  DTPlatformName: 'iphonesimulator',
  DTSDKName: 'iphonesimulator27.1',
  DTSDKBuild: '24A94232',
  DTXcodeBuild: '27A9275',
  MinimumOSVersion: '16.4',
});
const inspect: CrewInspect = (path) => ({
  architectures: basename(path) === 'vendor' ? ['arm64', 'x86_64'] : ['x86_64'],
  platform: 'IOSSIMULATOR',
  minOS: basename(path) === 'vendor' ? '15.1' : '16.4',
  sdk: basename(path) === 'vendor' ? '18.5' : '27.1',
  form: 'LC_BUILD_VERSION',
});
function app() {
  const root = directory(),
    path = join(root, 'Boardsesh.app');
  mkdirSync(path);
  writeFileSync(join(path, 'Info.plist'), 'fixture metadata');
  for (const name of ['Boardsesh', 'Boardsesh.debug.dylib', 'vendor'])
    writeFileSync(join(path, name), Buffer.from('cffaedfe00000000', 'hex'));
  chmodSync(join(path, 'Boardsesh'), 0o755);
  return { root, path };
}

describe('canonical ARM-to-Intel crew build contract', () => {
  it('accepts only the exact stable tuple and observes rather than guesses Swift patch/tag', () => {
    expect(assertCanonicalCrewToolchain(toolchain)).toEqual(toolchain);
    for (const mutation of [
      { xcodeBuild: '27B999' },
      { xcodeVersion: '27.2' },
      { sdkBuild: 'other' },
      { realDeveloperDir: '/alias' },
      { realAppPath: '/alias' },
      { realSdkPath: '/alias' },
      { compilerPath: '/other/swiftc' },
    ])
      expect(() => assertCanonicalCrewToolchain({ ...toolchain, ...mutation })).toThrow('canonical stable');
  });
  it('accepts an actual SDK version symlink within the pinned bundle and rejects escapes', () => {
    const root = directory(),
      sdkRoot = join(root, 'Platforms/iPhoneSimulator.platform/Developer/SDKs');
    mkdirSync(join(sdkRoot, 'iPhoneSimulator.sdk'), { recursive: true });
    symlinkSync('iPhoneSimulator.sdk', join(sdkRoot, 'iPhoneSimulator27.1.sdk'));
    const realSdkPath = realpathSync(join(sdkRoot, 'iPhoneSimulator27.1.sdk')).replace(
      realpathSync(root),
      CREW_DEVELOPER_DIR,
    );
    expect(assertCanonicalCrewToolchain({ ...toolchain, realSdkPath })).toMatchObject({ realSdkPath });
    expect(() => assertCanonicalCrewToolchain({ ...toolchain, realSdkPath: '/outside/iPhoneSimulator.sdk' })).toThrow();
    expect(() =>
      assertCanonicalCrewToolchain({
        ...toolchain,
        realSdkPath: realSdkPath.replace('Xcode_27.1.app', 'Xcode_27.2_Release_Candidate.app'),
      }),
    ).toThrow();
  });
  it('requires a coherent receipt and observed compiler identity for the explicit cross target', () => {
    expect(crewCrossBuildArchitecture('arm64', receipt, sourceSha, toolchain)).toBe('x86_64');
    for (const mutation of [
      { targetArchitecture: 'arm64' },
      { hostArchitecture: 'x86_64' },
      { sourceSha: 'd'.repeat(40) },
      { sdkSupportVerified: false },
      { sdkInventorySha256: '' },
    ])
      expect(() => crewCrossBuildArchitecture('arm64', { ...receipt, ...mutation }, sourceSha, toolchain)).toThrow();
    expect(() => crewCrossBuildArchitecture('x86_64', receipt, sourceSha, toolchain)).toThrow();
    expect(() =>
      crewCrossBuildArchitecture('arm64', receipt, sourceSha, {
        ...toolchain,
        swiftVersion: 'Apple Swift version changed',
      }),
    ).toThrow('changed after preflight');
  });
  it('requires actual interfaces, link stubs, compatibility slice and target metadata', () => {
    const settings = {
      SupportedTargets: { iphonesimulator: { Archs: ['arm64', 'x86_64'], ValidDeploymentTargets: ['16.4'] } },
    };
    const interfaces = Array.from({ length: 6 }, () => ({ exists: true, sha256: digest }));
    const stubs = Array.from({ length: 4 }, () => ({ x86Simulator: true, sha256: digest }));
    const target = { arch: 'x86_64', platform: 'iphonesimulator', moduleTriple: 'x86_64-apple-ios-simulator' };
    expect(assertCrewSdkInventory(settings, interfaces, stubs, ['x86_64', 'arm64'], target)).toHaveLength(64);
    expect(() =>
      assertCrewSdkInventory(
        settings,
        [{ ...interfaces[0], exists: false }, ...interfaces.slice(1)],
        stubs,
        ['x86_64'],
        target,
      ),
    ).toThrow();
    expect(() => assertCrewSdkInventory(settings, interfaces, stubs, ['arm64'], target)).toThrow();
    expect(() =>
      assertCrewSdkInventory(
        settings,
        interfaces,
        [{ ...stubs[0], x86Simulator: false }, ...stubs.slice(1)],
        ['x86_64'],
        target,
      ),
    ).toThrow();
    expect(() =>
      assertCrewSdkInventory(settings, interfaces, stubs, ['x86_64'], { ...target, platform: 'macosx' }),
    ).toThrow();
  });
});

describe('real Apple metadata formatting and vendor compatibility', () => {
  it('parses actual app and older vendor LC_BUILD_VERSION formatting', () => {
    expect(parseCrewMachOBuild(fixtures.main)).toMatchObject({ platform: 'IOSSIMULATOR', minOS: '16.4', sdk: '26.5' });
    expect(parseCrewMachOBuild(fixtures.vendor)).toMatchObject({ minOS: '15.1', sdk: '18.5' });
    expect(parseCrewMachOBuild(fixtures.main.replace('IOSSIMULATOR', '7'))).toMatchObject({ platform: 'IOSSIMULATOR' });
  });
  it('scopes a legacy Intel simulator command after LC_SOURCE_VERSION', () => {
    expect(parseCrewMachOBuild(fixtures.legacy)).toEqual({
      platform: 'IOSSIMULATOR',
      minOS: '13.0',
      sdk: '14.0',
      form: 'legacy-x86_64-ios-simulator',
    });
    expect(() => parseCrewMachOBuild(fixtures.legacy, 'arm64')).toThrow('legacy');
  });
  it('rejects macOS/device/unknown/ambiguous platforms and an excessive runtime floor', () => {
    for (const platform of ['MACOS', 'IOS', '2', 'UNKNOWN'])
      expect(() => parseCrewMachOBuild(fixtures.main.replace('IOSSIMULATOR', platform))).toThrow('Simulator');
    expect(() => parseCrewMachOBuild(fixtures.main.replace('minos 16.4', 'minos 27.1'))).toThrow('runtime26.5');
    expect(() => parseCrewMachOBuild(fixtures.main + fixtures.vendor)).toThrow('Ambiguous');
  });
});

describe('same-run untouched native artifact', () => {
  it('round-trips a relative framework symlink, executable permissions and vendor FAT bytes', () => {
    const { root, path } = app();
    mkdirSync(join(path, 'Frameworks'));
    symlinkSync('../vendor', join(path, 'Frameworks', 'Vendor'));
    const before = crewAppTree(path),
      output = join(root, 'handoff');
    const packed = packCrewApp(path, receipt, output, inspect, plist);
    expect(crewAppTree(path)).toEqual(before);
    const received = join(root, 'received', 'Boardsesh.app');
    const verified = verifyCrewArtifact(output, received, receipt, packed, inspect, plist);
    expect(verified).toEqual(packed.manifest);
    expect(crewAppTree(received)).toEqual(before);
    expect(verified.app.binaries.find((binary) => binary.path === 'vendor')?.architectures).toEqual([
      'arm64',
      'x86_64',
    ]);
  });
  it('accepts a vendor FAT legacy Intel simulator slice with its older deployment floor', () => {
    const { path } = app();
    const identity = inspectCrewApp(
      path,
      (binary) =>
        basename(binary) === 'vendor'
          ? { architectures: ['arm64', 'x86_64'], ...parseCrewMachOBuild(fixtures.legacy) }
          : inspect(binary),
      plist,
    );
    expect(identity.binaries.find((binary) => binary.path === 'vendor')).toMatchObject({
      minOS: '13.0',
      sdk: '14.0',
      form: 'legacy-x86_64-ios-simulator',
    });
  });
  it('rejects absolute producer links and relative links escaping the app', () => {
    const { root, path } = app();
    symlinkSync(join(path, 'vendor'), join(path, 'absolute'));
    expect(() => crewAppTree(path)).toThrow('Absolute');
    rmSync(join(path, 'absolute'));
    writeFileSync(join(root, 'outside'), 'outside');
    symlinkSync('../outside', join(path, 'escape'));
    expect(() => crewAppTree(path)).toThrow('escapes');
  });
  it('rejects wrong shell/platform/app bundle and requires single-slice main/debug', () => {
    const { path } = app();
    expect(() => inspectCrewApp(path, (binary) => ({ ...inspect(binary), architectures: ['arm64'] }), plist)).toThrow(
      'Intel',
    );
    expect(() =>
      inspectCrewApp(path, (binary) => ({ ...inspect(binary), architectures: ['arm64', 'x86_64'] }), plist),
    ).toThrow('Main/Debug');
    expect(() => inspectCrewApp(path, inspect, () => ({ ...plist(), CFBundleIdentifier: 'foreign' }))).toThrow(
      'dev-client',
    );
    expect(() => inspectCrewApp(path, (binary) => ({ ...inspect(binary), platform: 'MACOS' }), plist)).toThrow('Intel');
    writeFileSync(join(path, 'main.jsbundle'), 'application JS');
    expect(() => inspectCrewApp(path, inspect, plist)).toThrow('dev-client');
  });
  it('binds source/workflow/run/attempt/tooling identity, not an ARM cache label', () => {
    const { root, path } = app(),
      packed = packCrewApp(path, receipt, join(root, 'export'), inspect, plist);
    for (const mutation of [
      { sourceSha: 'e'.repeat(40) },
      { workflowSha: 'f'.repeat(40) },
      { runId: '999' },
      { runAttempt: '2' },
      { toolingSha256: 'e'.repeat(64) },
    ])
      expect(() => assertCrewManifest(packed.manifest, { ...receipt, ...mutation })).toThrow('provenance');
    expect(() => assertCrewManifest({ ...packed.manifest, targetArchitecture: 'arm64' }, receipt)).toThrow('identity');
  });
  it('refuses an otherwise digest-consistent archive with a foreign top-level member', () => {
    const { root, path } = app(),
      output = join(root, 'export'),
      packed = packCrewApp(path, receipt, output, inspect, plist);
    mkdirSync(join(root, 'Other.app'));
    writeFileSync(join(root, 'Other.app', 'file'), 'foreign');
    expect(spawnSync('/usr/bin/tar', ['-cpf', join(output, 'app.tar'), '-C', root, 'Other.app']).status).toBe(0);
    const archiveSha256 = createHash('sha256')
      .update(readFileSync(join(output, 'app.tar')))
      .digest('hex');
    const manifest = { ...packed.manifest, archiveSha256 };
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest));
    const manifestSha256 = createHash('sha256')
      .update(readFileSync(join(output, 'manifest.json')))
      .digest('hex');
    expect(() =>
      verifyCrewArtifact(
        output,
        join(root, 'foreign', 'Boardsesh.app'),
        receipt,
        { archiveSha256, manifestSha256 },
        inspect,
        plist,
      ),
    ).toThrow('archive member');
  });
  it('rejects tampered archive, tampered compiler manifest and extracted binary metadata drift', () => {
    const { root, path } = app(),
      output = join(root, 'export'),
      packed = packCrewApp(path, receipt, output, inspect, plist);
    const archive = readFileSync(join(output, 'app.tar'));
    writeFileSync(join(output, 'app.tar'), Buffer.concat([archive, Buffer.from('tamper')]));
    expect(() =>
      verifyCrewArtifact(output, join(root, 'receive1', 'Boardsesh.app'), receipt, packed, inspect, plist),
    ).toThrow('digest');
    writeFileSync(join(output, 'app.tar'), archive);
    const manifestBytes = readFileSync(join(output, 'manifest.json'));
    writeFileSync(
      join(output, 'manifest.json'),
      manifestBytes.toString().replace('Apple Swift version', 'Modified Swift version'),
    );
    expect(() =>
      verifyCrewArtifact(output, join(root, 'receive2', 'Boardsesh.app'), receipt, packed, inspect, plist),
    ).toThrow('digest');
    writeFileSync(join(output, 'manifest.json'), manifestBytes);
    expect(() =>
      verifyCrewArtifact(
        output,
        join(root, 'receive3', 'Boardsesh.app'),
        receipt,
        packed,
        (binary) => ({ ...inspect(binary), sdk: '26.5' }),
        plist,
      ),
    ).toThrow('identity');
  });
});

describe('actual selected crew runtime boundary', () => {
  const udid = '00000000-0000-0000-0000-000000000001',
    id = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
  const devices = { devices: { [id]: [{ udid, isAvailable: true }] } };
  const runtimes = { runtimes: [{ identifier: id, version: '26.5', isAvailable: true }] };
  it('allows available26.5 and validates each selected UDID independently', () => {
    assertCrewConsumerRuntime(runtimes);
    expect(assertSelectedCrewRuntime(udid, devices, runtimes)).toBe(id);
    expect(() => assertSelectedCrewRuntime(udid.replace(/1$/, '2'), devices, runtimes)).toThrow('missing');
  });
  it('rejects missing, ambiguous, unavailable or wrong actual selected runtimes', () => {
    expect(() => assertSelectedCrewRuntime(udid, devices, { runtimes: [] })).toThrow('expected');
    expect(() =>
      assertSelectedCrewRuntime(udid, { devices: { [id]: [{ udid, isAvailable: false }] } }, runtimes),
    ).toThrow('unavailable');
    expect(() =>
      assertSelectedCrewRuntime(
        udid,
        {
          devices: {
            [id]: [
              { udid, isAvailable: true },
              { udid, isAvailable: true },
            ],
          },
        },
        runtimes,
      ),
    ).toThrow('ambiguous');
    expect(() =>
      assertSelectedCrewRuntime(udid, devices, { runtimes: [{ ...runtimes.runtimes[0], version: '27.1' }] }),
    ).toThrow('expected');
    expect(() => assertCrewConsumerRuntime({ runtimes: [{ ...runtimes.runtimes[0], isAvailable: false }] })).toThrow(
      'available',
    );
  });
  it('checks both roles at the existing deferred prepare function, before boot/install', () => {
    const source = readFileSync('scripts/showcase-video-record.ts', 'utf8');
    const selected = source.indexOf('const device = findOrCreateIosDevice('),
      guard = source.indexOf('assertSelectedCrewRuntime(', selected);
    expect(source).toMatch(/assertSelectedCrewRuntime\(\s*device\.udid,/);
    expect(guard).toBeGreaterThan(selected);
    expect(guard).toBeLessThan(source.indexOf('bootDevice(device)', selected));
    expect(source.slice(selected, guard)).toContain('if (expectedRuntime)');
  });
});

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = { 'runs-on'?: string; if?: string; needs?: string; env?: Record<string, string>; steps: Step[] };
const measurement = () =>
  (parse(readFileSync('.github/workflows/mobile-store-videos-measure.yml', 'utf8')) as { jobs: Record<string, Job> })
    .jobs;
const evaluate = (expression: string, mode: string, result = 'skipped', cancelled = false) =>
  runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
    inputs: { mode },
    needs: { 'crew-app': { result } },
    cancelled: () => cancelled,
  }) as unknown;
describe('artifact-only measurement lane and preserved ordinary behavior', () => {
  it('runs a canonical secrets-free ARM producer only for record-crew, with no cache', () => {
    const producer = measurement()['crew-app'];
    expect(producer['runs-on']).toBe('xcode-27');
    expect(producer.env?.DEVELOPER_DIR).toBe(CREW_DEVELOPER_DIR);
    expect(evaluate(producer.if!, 'record-crew')).toBe(true);
    expect(evaluate(producer.if!, 'measure')).toBe(false);
    const serialized = JSON.stringify(producer);
    for (const forbidden of [
      'secrets.',
      'SCREENSHOT_USER_',
      'SHOWCASE_SECONDARY_',
      'actions/cache/',
      'simctl',
      'video:record',
    ])
      expect(serialized).not.toContain(forbidden);
    const preflight = producer.steps.findIndex(
      (step) => step.name === 'Verify exact stable toolchain and Intel simulator SDK support',
    );
    const build = producer.steps.findIndex(
      (step) => step.name === 'Build the original Intel simulator product once on ARM',
    );
    expect(preflight).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(preflight);
    expect(producer.steps[build].run).toContain('--crew-cross-build-receipt metrics/crew-toolchain.json');
    expect(producer.steps[build].run).toContain('build metrics/crew-cross-build.json');
    const pack = producer.steps.find(
      (step) => step.name === 'Archive the untouched original app with exact provenance',
    );
    expect(pack?.run).toContain('packages/mobile/ios/build/Build/Products/Debug-iphonesimulator/Boardsesh.app');
    const upload = producer.steps.find((step) => step.uses === 'actions/upload-artifact@v4');
    expect(upload?.with?.['retention-days']).toBe(1);
    expect(upload?.with?.['include-hidden-files']).toBe(true);
    expect(String(upload?.with?.path).trim().split('\n')).toEqual([
      '.boardsesh/crew-cross-export/app.tar',
      '.boardsesh/crew-cross-export/manifest.json',
    ]);
  });
  it('does not reuse/build/save an Intel cache in the crew consumer and verifies before capture', () => {
    const consumer = measurement().record;
    expect(consumer['runs-on']).toBe('macos-26-intel');
    expect(consumer.needs).toBe('crew-app');
    for (const result of ['failure', 'skipped', 'cancelled'])
      expect(evaluate(consumer.if!, 'record-crew', result)).toBe(false);
    expect(evaluate(consumer.if!, 'record-crew', 'success')).toBe(true);
    for (const mode of ['measure', 'record-english', 'record-profile', 'diagnose-profile-filter'])
      expect(evaluate(consumer.if!, mode)).toBe(true);
    expect(evaluate(consumer.if!, 'measure', 'skipped', true)).toBe(false);
    for (const step of consumer.steps.filter(
      (step) =>
        step.uses?.startsWith('actions/cache/') ||
        step.run?.includes('mobile:build-sim-app') ||
        step.name === 'Compute screenshot app cache key' ||
        step.name === 'Validate actual simulator app slices before use',
    )) {
      expect(step.if).toBeDefined();
      expect(evaluate(step.if!, 'record-crew')).toBe(false);
    }
    const download = consumer.steps.find((step) => step.uses === 'actions/download-artifact@v4');
    expect(download?.with).toEqual({
      name: 'crew-cross-native-${{ github.run_id }}-${{ github.run_attempt }}',
      path: '.boardsesh/crew-cross-received',
    });
    const verify = consumer.steps.findIndex(
      (step) => step.name === 'Verify exact artifact and Intel runtime before any installation',
    );
    const capture = consumer.steps.findIndex((step) => step.name === 'Record one English crew take without publishing');
    expect(verify).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(capture);
    expect(consumer.steps[verify].env).toMatchObject({
      CREW_ARCHIVE_SHA: '${{ needs.crew-app.outputs.archive-sha }}',
      CREW_MANIFEST_SHA: '${{ needs.crew-app.outputs.manifest-sha }}',
    });
    expect(consumer.steps[capture].env?.BOARDSESH_CREW_EXPECT_IOS_RUNTIME).toBe('26.5');
  });
  it('keeps the cross target explicit, skips arbitrary retry and bypasses ordinary export only there', () => {
    expect(parseBuildArgs(['--crew-cross-build-receipt', '/fixture/receipt.json']).crewCrossBuildReceipt).toBe(
      '/fixture/receipt.json',
    );
    expect(parseBuildArgs([]).crewCrossBuildReceipt).toBeUndefined();
    const builder = readFileSync('scripts/mobile-build-sim-app.ts', 'utf8');
    expect(builder).toContain("...(crewCrossBuild ? ['ONLY_ACTIVE_ARCH=NO'] : [])");
    expect(builder).toContain('if (status !== 0 && !options.crewCrossBuildReceipt)');
    expect(builder).toMatch(/crewCrossBuildArchitecture\(\s*architecture,/);
    const retained = builder.indexOf('Cross-build product retained untouched');
    expect(retained).toBeGreaterThan(-1);
    expect(retained).toBeLessThan(builder.indexOf('const destination = exportBuiltApp'));
    expect(builder).toMatch(
      /xcodebuild\(\s*options\.configuration,\s*targetArchitecture,\s*Boolean\(options\.crewCrossBuildReceipt\),?\s*\)/,
    );
  });
});
