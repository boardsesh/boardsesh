// One artifact-only crew experiment. This helper is never imported by ordinary builds.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CREW_CROSS_FORMAT,
  assertCanonicalCrewToolchain,
  assertSimulatorBuildSource,
  crewCrossBuildArchitecture,
  readCanonicalCrewToolchain,
  readMachOArchitectures,
  simulatorArchitecture,
} from './ios-simulator-architecture.mjs';
const RUNTIME = '26.5';
const sha = (contents) => createHash('sha256').update(contents).digest('hex');
const fileSha = (path) => sha(readFileSync(path));
const isDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function command(executable, args, timeout = 10_000) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `Crew artifact command failed: ${basename(executable)} (${result.status ?? result.signal ?? 'spawn'})`,
    );
  return result.stdout.trim();
}
export function compareVersions(first, second) {
  if (![first, second].every((value) => typeof value === 'string' && /^\d+(\.\d+){0,2}$/.test(value)))
    throw new Error('Invalid deployment/SDK version.');
  const left = first.split('.').map(Number),
    right = second.split('.').map(Number);
  for (let index = 0; index < 3; index++)
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return Math.sign((left[index] ?? 0) - (right[index] ?? 0));
  return 0;
}
/** otool/vtool output for ONE selected slice; legacy Intel iPhoneOS commands imply simulator. */
export function parseCrewMachOBuild(output, architecture = 'x86_64') {
  const commands = [...output.matchAll(/\bcmd\s+(LC_BUILD_VERSION|LC_VERSION_MIN_\w+)/g)];
  if (commands.length !== 1) throw new Error('Ambiguous or unsupported Mach-O build commands.');
  const name = commands[0][1];
  output = output.slice(commands[0].index).split(/\n\s*Load command /)[0];
  let minOS, sdk, form;
  if (name === 'LC_BUILD_VERSION') {
    const platform = /^\s*platform\s+(\S+)/m.exec(output)?.[1];
    if (!['7', 'IOSSIMULATOR'].includes(platform ?? '')) throw new Error('Mach-O is not an iOS Simulator binary.');
    minOS = /^\s*minos\s+(\S+)/m.exec(output)?.[1];
    form = 'LC_BUILD_VERSION';
  } else if (name === 'LC_VERSION_MIN_IPHONEOS' && architecture === 'x86_64') {
    // iOS devices have never used x86_64. Do not apply this inference to ARM/device code.
    minOS = /^\s*version\s+(\S+)/m.exec(output)?.[1];
    form = 'legacy-x86_64-ios-simulator';
  } else throw new Error('Unsupported legacy Mach-O platform/architecture.');
  sdk = /^\s*sdk\s+(\S+)/m.exec(output)?.[1];
  if (compareVersions(minOS, RUNTIME) > 0) throw new Error('Mach-O minimum OS exceeds consumer runtime26.5.');
  compareVersions(sdk, sdk);
  return { platform: 'IOSSIMULATOR', minOS, sdk, form };
}
function macho(path) {
  const bytes = readFileSync(path);
  return ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(
    bytes.subarray(0, 4).toString('hex'),
  );
}
export function crewAppTree(appPath) {
  if (lstatSync(appPath).isSymbolicLink()) throw new Error('App root cannot be a symlink.');
  const root = realpathSync(appPath);
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw new Error('Expected a real build-product app directory.');
  const entries = [];
  const visit = (path) => {
    const stat = lstatSync(path),
      name = relative(root, path).split(sep).join('/') || '.';
    const common = { path: name, mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink()) {
      const link = command('/usr/bin/readlink', [path]);
      if (isAbsolute(link)) throw new Error('Absolute app symlink cannot relocate safely.');
      const target = realpathSync(path),
        targetRelative = relative(root, target);
      if (isAbsolute(targetRelative) || targetRelative === '..' || targetRelative.startsWith(`..${sep}`))
        throw new Error('App symlink escapes its build product.');
      // Preserve the link itself; never replace it with a resolved copy.
      entries.push({ ...common, kind: 'symlink', target: link });
    } else if (stat.isDirectory()) {
      entries.push({ ...common, kind: 'directory' });
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else if (stat.isFile()) entries.push({ ...common, kind: 'file', sha256: fileSha(path), size: stat.size });
    else throw new Error('Unsupported special file in simulator app.');
  };
  visit(root);
  return entries;
}
function readPlist(appPath) {
  return JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Info.plist')]));
}
function inspectBinary(path) {
  try {
    return {
      architectures: readMachOArchitectures(path),
      ...parseCrewMachOBuild(command('/usr/bin/xcrun', ['otool', '-arch', 'x86_64', '-l', path])),
    };
  } catch (error) {
    throw new Error(
      `Cannot verify native metadata for ${basename(path)}: ${error instanceof Error ? error.message : 'unknown format'}`,
    );
  }
}
export function inspectCrewApp(appPath, inspect = inspectBinary, plistReader = readPlist) {
  const entries = crewAppTree(appPath),
    plist = plistReader(appPath);
  if (
    plist.CFBundleIdentifier !== 'com.boardsesh.app' ||
    plist.DTPlatformName !== 'iphonesimulator' ||
    !Array.isArray(plist.CFBundleSupportedPlatforms) ||
    !plist.CFBundleSupportedPlatforms.includes('iPhoneSimulator') ||
    existsSync(join(appPath, 'main.jsbundle'))
  )
    throw new Error('Expected the simulator dev-client shell without an embedded application bundle.');
  if (
    plist.CFBundleExecutable !== 'Boardsesh' ||
    plist.DTSDKName !== 'iphonesimulator27.1' ||
    plist.DTSDKBuild !== '24A94232' ||
    plist.DTXcodeBuild !== '27A9275'
  )
    throw new Error('App plist does not match the pinned build toolchain.');
  if (compareVersions(plist.MinimumOSVersion, RUNTIME) > 0)
    throw new Error('App deployment floor exceeds runtime26.5.');
  const binaries = entries
    .filter((entry) => entry.kind === 'file' && macho(join(appPath, entry.path)))
    .map((entry) => {
      const metadata = inspect(join(appPath, entry.path));
      if (
        !Array.isArray(metadata.architectures) ||
        !metadata.architectures.includes('x86_64') ||
        metadata.platform !== 'IOSSIMULATOR' ||
        compareVersions(metadata.minOS, RUNTIME) > 0
      )
        throw new Error(`Wrong Intel simulator binary: ${entry.path}`);
      const main = ['Boardsesh', 'Boardsesh.debug.dylib'].includes(entry.path);
      if (
        main &&
        (metadata.form !== 'LC_BUILD_VERSION' ||
          metadata.architectures.length !== 1 ||
          compareVersions(metadata.sdk, '27.1') !== 0 ||
          compareVersions(metadata.minOS, plist.MinimumOSVersion) !== 0)
      )
        throw new Error(`Main/Debug binary identity mismatch: ${entry.path}`);
      return { path: entry.path, sha256: entry.sha256, ...metadata };
    });
  for (const name of ['Boardsesh', 'Boardsesh.debug.dylib'])
    if (!binaries.some((binary) => binary.path === name))
      throw new Error(`Missing native main/Debug executable: ${name}`);
  return {
    treeSha256: sha(JSON.stringify(entries)),
    entryCount: entries.length,
    binaries,
    deploymentTarget: plist.MinimumOSVersion,
  };
}
export function assertCrewContext(context) {
  if (
    !/^[a-f0-9]{40}$/.test(context?.sourceSha ?? '') ||
    !/^[a-f0-9]{40}$/.test(context?.workflowSha ?? '') ||
    !/^\d+$/.test(context?.runId ?? '') ||
    !/^\d+$/.test(context?.runAttempt ?? '') ||
    !isDigest(context?.toolingSha256)
  )
    throw new Error('Missing exact source/tooling/run artifact context.');
}
function contextFromSource(sourceRoot) {
  assertSimulatorBuildSource(sourceRoot);
  const ownFile = fileURLToPath(import.meta.url),
    sourceHelper = join(sourceRoot, 'scripts/lib/ios-crew-cross-artifact.mjs');
  if (!existsSync(sourceHelper) || readFileSync(sourceHelper, 'utf8') !== readFileSync(ownFile, 'utf8'))
    throw new Error('Historical source lacks the reviewed crew artifact harness.');
  if (command('git', ['-C', sourceRoot, 'status', '--porcelain', '--untracked-files=no']))
    throw new Error('Crew source has tracked modifications.');
  const context = {
    sourceSha: command('git', ['-C', sourceRoot, 'rev-parse', 'HEAD']),
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    toolingSha256: sha(
      readFileSync(ownFile, 'utf8') + readFileSync(join(dirname(ownFile), 'ios-simulator-architecture.mjs'), 'utf8'),
    ),
  };
  assertCrewContext(context);
  if (context.sourceSha !== process.env.GITHUB_SHA)
    throw new Error('Crew source differs from the dispatched exact candidate.');
  return context;
}
export function assertCrewSdkInventory(settings, interfaces, stubs, compatibilityArchitectures, target) {
  const simulator = settings?.SupportedTargets?.iphonesimulator;
  if (
    !simulator?.Archs?.includes('x86_64') ||
    !simulator?.ValidDeploymentTargets?.includes('16.4') ||
    interfaces.length !== 6 ||
    !interfaces.every((entry) => entry.exists === true && isDigest(entry.sha256)) ||
    stubs.length !== 4 ||
    !stubs.every((entry) => entry.x86Simulator === true && isDigest(entry.sha256)) ||
    !compatibilityArchitectures.includes('x86_64') ||
    target?.arch !== 'x86_64' ||
    target?.platform !== 'iphonesimulator' ||
    target?.moduleTriple !== 'x86_64-apple-ios-simulator'
  )
    throw new Error('Pinned SDK lacks verified x86_64 simulator support.');
  return sha(JSON.stringify({ settings: simulator, interfaces, stubs, compatibilityArchitectures, target }));
}
export function preflightCrewCrossBuild(sourceRoot) {
  const hostArchitecture = simulatorArchitecture();
  if (hostArchitecture !== 'arm64') throw new Error('Crew cross-build producer must be a validated ARM64 host.');
  const context = contextFromSource(sourceRoot),
    toolchain = readCanonicalCrewToolchain(),
    sdk = toolchain.sdkPath;
  const interfaces = ['SwiftUI', 'UIKit', 'Foundation', 'Swift', '_Concurrency', 'SwiftOnoneSupport'].map((module) => {
    const path = ['SwiftUI', 'UIKit', 'Foundation'].includes(module)
      ? join(
          sdk,
          `System/Library/Frameworks/${module}.framework/Modules/${module}.swiftmodule/x86_64-apple-ios-simulator.swiftinterface`,
        )
      : join(sdk, `usr/lib/swift/${module}.swiftmodule/x86_64-apple-ios-simulator.swiftinterface`);
    return {
      module,
      exists: existsSync(path) && lstatSync(path).isFile() && lstatSync(path).size > 0,
      sha256: existsSync(path) ? fileSha(path) : null,
    };
  });
  const stubs = ['SwiftUI', 'UIKit', 'Foundation', 'libswiftCore'].map((module) => {
    const path =
      module === 'libswiftCore'
        ? join(sdk, 'usr/lib/swift/libswiftCore.tbd')
        : join(sdk, `System/Library/Frameworks/${module}.framework/${module}.tbd`);
    const contents = readFileSync(path, 'utf8');
    return { module, x86Simulator: contents.includes('x86_64-ios-simulator'), sha256: sha(contents) };
  });
  const compatibility = readMachOArchitectures(
    join(
      toolchain.developerDir,
      'Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/iphonesimulator/libswiftCompatibilityPacks.a',
    ),
  );
  const targetInfo = JSON.parse(
    command('/usr/bin/xcrun', [
      '--sdk',
      'iphonesimulator',
      'swiftc',
      '-print-target-info',
      '-target',
      'x86_64-apple-ios16.4-simulator',
    ]),
  );
  const sdkInventorySha256 = assertCrewSdkInventory(
    JSON.parse(readFileSync(join(sdk, 'SDKSettings.json'), 'utf8')),
    interfaces,
    stubs,
    compatibility,
    targetInfo.target,
  );
  return {
    format: CREW_CROSS_FORMAT,
    ...context,
    hostArchitecture,
    targetArchitecture: 'x86_64',
    toolchain,
    sdkSupportVerified: true,
    sdkInventorySha256,
    sdkInventory: {
      interfaces,
      stubs,
      compatibilityArchitectures: compatibility,
      target: {
        arch: targetInfo.target.arch,
        platform: targetInfo.target.platform,
        moduleTriple: targetInfo.target.moduleTriple,
      },
    },
  };
}
export function assertCrewManifest(manifest, expected) {
  assertCrewContext(expected);
  assertCrewContext(manifest);
  assertCanonicalCrewToolchain(manifest.toolchain);
  for (const name of ['sourceSha', 'workflowSha', 'runId', 'runAttempt', 'toolingSha256'])
    if (manifest[name] !== expected[name]) throw new Error(`Crew artifact ${name} provenance mismatch.`);
  if (
    manifest.format !== CREW_CROSS_FORMAT ||
    manifest.hostArchitecture !== 'arm64' ||
    manifest.targetArchitecture !== 'x86_64' ||
    manifest.consumerRuntime !== RUNTIME ||
    manifest.sdkSupportVerified !== true ||
    !isDigest(manifest.sdkInventorySha256) ||
    !isDigest(manifest.archiveSha256) ||
    !isDigest(manifest.app?.treeSha256) ||
    !Array.isArray(manifest.app?.binaries) ||
    compareVersions(manifest.app.deploymentTarget, RUNTIME) > 0
  )
    throw new Error('Invalid crew artifact identity.');
  return manifest;
}
export function packCrewApp(appPath, receipt, outputDirectory, inspect = inspectBinary, plistReader = readPlist) {
  assertCrewContext(receipt);
  assertCanonicalCrewToolchain(receipt.toolchain);
  crewCrossBuildArchitecture('arm64', receipt, receipt.sourceSha, receipt.toolchain);
  const location = relative(resolve(appPath), resolve(outputDirectory));
  if (location === '' || (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`)))
    throw new Error('Artifact output must be outside the app.');
  const app = inspectCrewApp(appPath, inspect, plistReader);
  if (basename(appPath) !== 'Boardsesh.app') throw new Error('Expected Boardsesh.app build product.');
  mkdirSync(outputDirectory, { recursive: true });
  const archive = resolve(outputDirectory, 'app.tar');
  command('/usr/bin/tar', ['-cpf', archive, '-C', dirname(appPath), 'Boardsesh.app'], 60_000);
  // Archive creation must leave all original native bytes, modes and symlinks intact.
  if (inspectCrewApp(appPath, inspect, plistReader).treeSha256 !== app.treeSha256)
    throw new Error('App changed while archiving.');
  const manifest = { ...receipt, consumerRuntime: RUNTIME, archiveSha256: fileSha(archive), app };
  assertCrewManifest(manifest, receipt);
  const manifestPath = join(outputDirectory, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, archiveSha256: manifest.archiveSha256, manifestSha256: fileSha(manifestPath) };
}
export function verifyCrewArtifact(
  artifactDirectory,
  appOutput,
  expected,
  digests,
  inspect = inspectBinary,
  plistReader = readPlist,
) {
  const manifestPath = join(artifactDirectory, 'manifest.json'),
    archive = join(artifactDirectory, 'app.tar');
  if (
    !isDigest(digests?.manifestSha256) ||
    !isDigest(digests?.archiveSha256) ||
    fileSha(manifestPath) !== digests.manifestSha256 ||
    fileSha(archive) !== digests.archiveSha256
  )
    throw new Error('Crew artifact digest differs from same-run producer output.');
  const manifest = assertCrewManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), expected);
  if (manifest.archiveSha256 !== digests.archiveSha256) throw new Error('Crew archive/manifest digest mismatch.');
  const names = command('/usr/bin/tar', ['-tf', archive]).split('\n');
  if (
    !names.length ||
    names.some((name) => !/^Boardsesh\.app(?:\/|$)/.test(name) || name.split('/').includes('..') || isAbsolute(name))
  )
    throw new Error('Unsafe crew archive member.');
  const output = resolve(appOutput),
    parent = dirname(output);
  if (basename(output) !== 'Boardsesh.app' || existsSync(output))
    throw new Error('Crew extraction requires a fresh Boardsesh.app destination.');
  mkdirSync(parent, { recursive: true });
  try {
    command('/usr/bin/tar', ['-xpf', archive, '-C', parent], 60_000);
    const observed = inspectCrewApp(output, inspect, plistReader);
    if (JSON.stringify(observed) !== JSON.stringify(manifest.app))
      throw new Error('Extracted app bytes/modes/symlinks/native identity changed.');
    return manifest;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}
export function assertCrewConsumerRuntime(runtimes) {
  const ios = (runtimes?.runtimes ?? []).filter(
    (runtime) =>
      runtime.isAvailable && (runtime.identifier ?? '').startsWith('com.apple.CoreSimulator.SimRuntime.iOS-'),
  );
  if (!ios.some((runtime) => compareVersions(runtime.version, RUNTIME) === 0))
    throw new Error('Crew consumer requires an available iOS26.5 runtime.');
}
export function assertSelectedCrewRuntime(udid, devices, runtimes, expected = RUNTIME) {
  if (expected !== RUNTIME || typeof udid !== 'string' || !/^[a-f0-9-]{36}$/i.test(udid))
    throw new Error('Invalid selected crew runtime/device expectation.');
  const matches = Object.entries(devices?.devices ?? {}).flatMap(([runtimeId, entries]) =>
    Array.isArray(entries)
      ? entries
          .filter((entry) => entry?.udid?.toUpperCase() === udid.toUpperCase())
          .map((device) => ({ runtimeId, device }))
      : [],
  );
  if (matches.length !== 1 || matches[0].device.isAvailable !== true)
    throw new Error('Selected crew device runtime is missing, ambiguous or unavailable.');
  const id = matches[0].runtimeId;
  const available = (runtimes?.runtimes ?? []).filter((runtime) => runtime.identifier === id);
  if (
    available.length !== 1 ||
    available[0].isAvailable !== true ||
    !/\.iOS-/.test(id) ||
    compareVersions(available[0].version, expected) !== 0
  )
    throw new Error('Selected crew device is not on the available expected iOS26.5 runtime.');
  return id;
}
function writeJson(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(contents, null, 2) + '\n');
}
export function crewCrossArtifactMain(args = process.argv.slice(2)) {
  const [action, source, first, second, third] = args;
  if (!source || !first) throw new Error('Expected preflight|pack|verify with explicit source and paths.');
  const root = resolve(source);
  if (action === 'preflight') {
    const receipt = preflightCrewCrossBuild(root);
    writeJson(first, receipt);
    return receipt;
  }
  const context = contextFromSource(root);
  if (action === 'pack') {
    if (!second || !third) throw new Error('Expected pack source app receipt output-directory.');
    const receipt = JSON.parse(readFileSync(second, 'utf8'));
    crewCrossBuildArchitecture(simulatorArchitecture(), receipt, context.sourceSha, readCanonicalCrewToolchain());
    for (const name of Object.keys(context))
      if (receipt[name] !== context[name]) throw new Error('Crew preflight source/run changed.');
    const packed = packCrewApp(resolve(first), receipt, resolve(third));
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `archive-sha=${packed.archiveSha256}\nmanifest-sha=${packed.manifestSha256}\n`,
      );
    return packed.manifest;
  }
  if (action === 'verify') {
    if (!second || simulatorArchitecture() !== 'x86_64')
      throw new Error('Crew consumer must be a validated native Intel host.');
    assertCrewConsumerRuntime(JSON.parse(command('/usr/bin/xcrun', ['simctl', 'list', 'runtimes', '--json'], 30_000)));
    const manifest = verifyCrewArtifact(resolve(first), resolve(second), context, {
      archiveSha256: process.env.CREW_ARCHIVE_SHA,
      manifestSha256: process.env.CREW_MANIFEST_SHA,
    });
    return {
      verified: true,
      sourceSha: manifest.sourceSha,
      targetArchitecture: manifest.targetArchitecture,
      consumerRuntime: manifest.consumerRuntime,
      app: manifest.app,
      toolchain: manifest.toolchain,
    };
  }
  throw new Error('Unknown crew cross-artifact action.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(crewCrossArtifactMain()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Crew cross-artifact failed.');
    process.exitCode = 1;
  }
}
