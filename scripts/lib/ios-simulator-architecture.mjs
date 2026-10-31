import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A simulator app must match both Node and the Actions runner that owns its cache. */
export function simulatorArchitecture(
  nodeArchitecture = process.arch,
  runnerArchitecture = process.env.RUNNER_ARCH,
  ci = process.env.CI === 'true' || process.env.CI === '1',
) {
  const architectures = { arm64: 'arm64', x64: 'x86_64' };
  if (!Object.hasOwn(architectures, nodeArchitecture))
    throw new Error(`Unsupported simulator host: ${nodeArchitecture}`);
  const expectedRunner = nodeArchitecture === 'arm64' ? 'ARM64' : 'X64';
  if ((ci && !runnerArchitecture) || (runnerArchitecture !== undefined && runnerArchitecture !== expectedRunner))
    throw new Error(
      `Simulator Node/runner architecture mismatch: ${nodeArchitecture}/${runnerArchitecture ?? 'missing'}`,
    );
  return architectures[nodeArchitecture];
}

export function assertSimulatorCacheArchitecture(cacheKey, architecture = simulatorArchitecture()) {
  if (!['arm64', 'x86_64'].includes(architecture)) throw new Error('Unsupported simulator architecture.');
  const runnerArchitecture = architecture === 'arm64' ? 'ARM64' : 'X64';
  if (!new RegExp(`^macOS-${runnerArchitecture}-screenshot-sim-app-v[1-9][0-9]*-`).test(cacheKey))
    throw new Error('Simulator cache key does not match the validated host architecture.');
}

export function readMachOArchitectures(binaryPath) {
  const result = spawnSync('lipo', ['-archs', binaryPath], {
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  if (result.status !== 0 || !result.stdout.trim())
    throw new Error(`Cannot inspect Mach-O slices: ${basename(binaryPath)}`);
  return result.stdout.trim().split(/\s+/);
}

/** Inspect actual binaries, including cache hits; names/cache labels are not slice evidence. */
export function assertAppSimulatorArchitecture(
  appPath,
  architecture = simulatorArchitecture(),
  requireDebug = true,
  inspect = readMachOArchitectures,
) {
  if (!['arm64', 'x86_64'].includes(architecture)) throw new Error('Unsupported simulator architecture.');
  if (!existsSync(join(appPath, 'Info.plist'))) throw new Error('Simulator app metadata is missing.');
  const names = ['Boardsesh'];
  if (requireDebug || existsSync(join(appPath, 'Boardsesh.debug.dylib'))) names.push('Boardsesh.debug.dylib');
  const executables = names.map((name) => {
    const binaryPath = join(appPath, name);
    if (!existsSync(binaryPath) || !lstatSync(binaryPath).isFile() || lstatSync(binaryPath).size === 0)
      throw new Error(`Simulator executable missing: ${name}`);
    const architectures = inspect(binaryPath);
    if (architectures.length !== 1 || architectures[0] !== architecture)
      throw new Error(`Wrong simulator slices for ${name}: expected ${architecture}, got ${architectures.join(',')}`);
    return { file: name, architectures, sha256: createHash('sha256').update(readFileSync(binaryPath)).digest('hex') };
  });
  return { architecture, executables };
}

/** Workflow-owned refusal: historical sources must carry this reviewed builder themselves. */
export function assertSimulatorBuildSource(sourceRoot) {
  const root = realpathSync(sourceRoot);
  const helper = join(root, 'scripts/lib/ios-simulator-architecture.mjs');
  const builder = join(root, 'scripts/mobile-build-sim-app.ts');
  if (!existsSync(helper) || !existsSync(builder) || lstatSync(helper).isSymbolicLink())
    throw new Error('Recording source predates the host-native simulator builder; select a coherent reviewed source.');
  const helperSource = readFileSync(helper, 'utf8');
  const builderSource = readFileSync(builder, 'utf8');
  if (
    helperSource !== readFileSync(fileURLToPath(import.meta.url), 'utf8') ||
    !/from ['"]\.\/lib\/ios-simulator-architecture\.mjs['"]/.test(builderSource) ||
    !/const\s+architecture\s*=\s*simulatorArchitecture\(\s*\)/.test(builderSource) ||
    !builderSource.includes('`ARCHS=${architecture}`')
  )
    throw new Error(
      'Recording source lacks the reviewed host-native architecture contract; no build/cache write permitted.',
    );
}

export function architectureGuardMain(args = process.argv.slice(2)) {
  const architecture = simulatorArchitecture();
  const [command, target, cacheKey] = args;
  if (!target) throw new Error('Expected source <root> or app <Boardsesh.app> [cache-key].');
  if (command === 'source') {
    assertSimulatorBuildSource(resolve(target));
    return { architecture, sourceSupported: true };
  }
  if (command !== 'app') throw new Error('Expected source or app architecture guard.');
  if (cacheKey !== undefined) assertSimulatorCacheArchitecture(cacheKey, architecture);
  return assertAppSimulatorArchitecture(resolve(target), architecture);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(architectureGuardMain()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Simulator architecture guard failed.');
    process.exitCode = 1;
  }
}

// This one diagnostic lane cross-compiles without changing ordinary host-native builds.
export const CREW_CROSS_FORMAT = 'boardsesh-crew-cross-build-v1';
export const CREW_DEVELOPER_DIR = '/Applications/Xcode_27.1.app/Contents/Developer';
export function assertCanonicalCrewToolchain(identity) {
  if (
    identity?.developerDir !== CREW_DEVELOPER_DIR ||
    identity?.realDeveloperDir !== CREW_DEVELOPER_DIR ||
    identity?.realAppPath !== '/Applications/Xcode_27.1.app' ||
    typeof identity?.compilerPath !== 'string' ||
    !identity.compilerPath.startsWith(`${CREW_DEVELOPER_DIR}/Toolchains/XcodeDefault.xctoolchain/usr/bin/`) ||
    identity.compilerPath.split('/').includes('..') ||
    identity?.xcodeVersion !== '27.1' ||
    identity?.xcodeBuild !== '27A9275' ||
    identity?.sdkVersion !== '27.1' ||
    identity?.sdkBuild !== '24A94232' ||
    !['iPhoneSimulator.sdk', 'iPhoneSimulator27.1.sdk'].some(
      (name) => identity?.sdkPath === `${CREW_DEVELOPER_DIR}/Platforms/iPhoneSimulator.platform/Developer/SDKs/${name}`,
    ) ||
    !['iPhoneSimulator.sdk', 'iPhoneSimulator27.1.sdk'].some(
      (name) =>
        identity?.realSdkPath === `${CREW_DEVELOPER_DIR}/Platforms/iPhoneSimulator.platform/Developer/SDKs/${name}`,
    ) ||
    typeof identity?.swiftVersion !== 'string' ||
    !identity.swiftVersion.includes('Apple Swift version ')
  )
    throw new Error('Crew cross-build requires the exact canonical stable Xcode/SDK tuple.');
  return identity;
}
function boundedCrewCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
  if (result.status !== 0) throw new Error(`Crew toolchain metadata command failed: ${basename(command)}`);
  return result.stdout.trim();
}
export function readCanonicalCrewToolchain() {
  if (
    process.env.DEVELOPER_DIR !== CREW_DEVELOPER_DIR ||
    process.env.SWIFT_EXEC ||
    process.env.SDKROOT ||
    (process.env.TOOLCHAINS && process.env.TOOLCHAINS !== 'com.apple.dt.toolchain.XcodeDefault')
  )
    throw new Error('Crew cross-build refuses alternate developer/compiler/SDK overrides.');
  const realDeveloperDir = realpathSync(CREW_DEVELOPER_DIR);
  const realAppPath = realpathSync('/Applications/Xcode_27.1.app');
  if (realDeveloperDir !== CREW_DEVELOPER_DIR || realAppPath !== '/Applications/Xcode_27.1.app')
    throw new Error('Crew canonical Xcode app/developer directory resolves to an alias.');
  const version = boundedCrewCommand(`${CREW_DEVELOPER_DIR}/usr/bin/xcodebuild`, ['-version']);
  const sdk = (flag) => boundedCrewCommand('/usr/bin/xcrun', ['--sdk', 'iphonesimulator', flag]);
  const sdkPath = sdk('--show-sdk-path');
  const compiler = `${CREW_DEVELOPER_DIR}/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc`;
  const compilerPath = realpathSync(compiler);
  if (!compilerPath.startsWith(`${CREW_DEVELOPER_DIR}/Toolchains/XcodeDefault.xctoolchain/usr/bin/`))
    throw new Error('Crew compiler resolves outside the pinned default toolchain.');
  return assertCanonicalCrewToolchain({
    realDeveloperDir,
    realAppPath,
    realSdkPath: realpathSync(sdkPath),
    compilerPath,
    developerDir: CREW_DEVELOPER_DIR,
    xcodeVersion: /^Xcode (.+)$/m.exec(version)?.[1],
    xcodeBuild: /^Build version (.+)$/m.exec(version)?.[1],
    sdkVersion: sdk('--show-sdk-version'),
    sdkBuild: sdk('--show-sdk-build-version'),
    sdkPath,
    // No guessed patch version/tag: the exact pinned Xcode bundle supplies its compiler.
    swiftVersion: boundedCrewCommand(compiler, ['--version']),
  });
}
export function crewCrossBuildArchitecture(hostArchitecture, receipt, sourceSha, observedToolchain) {
  if (
    hostArchitecture !== 'arm64' ||
    receipt?.format !== CREW_CROSS_FORMAT ||
    receipt?.hostArchitecture !== 'arm64' ||
    receipt?.targetArchitecture !== 'x86_64' ||
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    receipt?.sourceSha !== sourceSha ||
    receipt?.sdkSupportVerified !== true ||
    !/^[a-f0-9]{64}$/.test(receipt?.sdkInventorySha256 ?? '')
  )
    throw new Error('Crew cross-build requires its coherent ARM-to-Intel preflight receipt.');
  assertCanonicalCrewToolchain(receipt.toolchain);
  assertCanonicalCrewToolchain(observedToolchain);
  if (JSON.stringify(receipt.toolchain) !== JSON.stringify(observedToolchain))
    throw new Error('Crew compiler/SDK changed after preflight.');
  return 'x86_64';
}
