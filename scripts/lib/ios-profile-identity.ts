import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

export interface IosAppIdentity {
  bundleIdentifier: string;
  executableUuid: string;
  executableSha256: string;
  embeddedBundleSha256: string | null;
}

export function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readPlistString(plistPath: string, key: string): string {
  return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plistPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A necessary Debug/Metro check; matching RN alone does not prove native ABI compatibility. */
export function assertAppReactNativeVersion(
  appPath: string,
  configuration: 'Debug' | 'Release',
  mobileDirectory: string,
): void {
  // Release carries its own JS bundle; it need not match this checkout's Metro.
  if (configuration === 'Release') return;
  const nativePlist = join(appPath, 'React-Core_privacy.bundle', 'Info.plist');
  let nativeVersion: string;
  try {
    nativeVersion = readPlistString(nativePlist, 'CFBundleShortVersionString');
    if (!nativeVersion) throw new Error('Missing React Native version.');
  } catch {
    throw new Error(
      `Cannot verify cached Debug app React Native version from ${nativePlist}. Select or rebuild a Debug app with readable React-Core metadata before running the smoke check.`,
    );
  }
  let installedVersion: string;
  try {
    const requireFromMobile = createRequire(join(mobileDirectory, 'package.json'));
    const packagePath = requireFromMobile.resolve('react-native/package.json');
    const packageVersion = objectRecord(JSON.parse(readFileSync(packagePath, 'utf8')))?.version;
    if (typeof packageVersion !== 'string' || !packageVersion.trim()) throw new Error('Missing installed version.');
    installedVersion = packageVersion.trim();
  } catch {
    throw new Error(
      `Cannot read the installed React Native version for ${mobileDirectory}. Prepare this checkout's mobile dependencies before running the smoke check.`,
    );
  }
  if (nativeVersion !== installedVersion) {
    throw new Error(
      `Cached Debug app uses React Native ${nativeVersion}, but this checkout installs ${installedVersion}. Select or rebuild a matching Debug app before running the smoke check.`,
    );
  }
}

export function readAppIdentity(appPath: string, configuration: 'Debug' | 'Release'): IosAppIdentity {
  const plist = (key: string) => readPlistString(join(appPath, 'Info.plist'), key);
  const executable = join(appPath, plist('CFBundleExecutable'));
  const uuid = execFileSync('xcrun', ['dwarfdump', '--uuid', executable], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /UUID: ([0-9A-F-]+) \(([^)]+)\)/i.exec(line))
    .filter((match) => match !== null)
    .map((match) => `${match[1]} (${match[2]})`)
    .sort()
    .join(', ');
  if (!uuid) throw new Error(`Executable has no UUID: ${executable}`);
  const bundlePath = join(appPath, 'main.jsbundle');
  if (configuration === 'Release' && !existsSync(bundlePath))
    throw new Error('Release profiling requires an embedded bundle.');
  return {
    bundleIdentifier: plist('CFBundleIdentifier'),
    executableUuid: uuid,
    executableSha256: fileSha256(executable),
    embeddedBundleSha256: existsSync(bundlePath) ? fileSha256(bundlePath) : null,
  };
}

export function assertMatchingIdentity(expected: IosAppIdentity, actual: IosAppIdentity): void {
  for (const field of ['bundleIdentifier', 'executableUuid', 'executableSha256', 'embeddedBundleSha256'] as const) {
    if (expected[field] !== actual[field])
      throw new Error(`Installed app identity changed: ${field}. Capture is invalid.`);
  }
}

function objectRecord(candidate: unknown): Record<string, unknown> | null {
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}

/** A useful Home commit must come from a complete, identifiable runtime artifact. */
export function hasUsefulStartupArtifact(artifact: unknown): boolean {
  const recorded = objectRecord(artifact);
  if (typeof recorded?.runId !== 'string' || recorded.runId.trim().length === 0 || !Array.isArray(recorded.marks))
    return false;
  let usefulMarks = 0;
  for (const candidate of recorded.marks) {
    const mark = objectRecord(candidate);
    if (
      typeof mark?.name !== 'string' ||
      typeof mark.timestampMs !== 'number' ||
      !Number.isFinite(mark.timestampMs) ||
      mark.timestampMs < 0
    )
      return false;
    if (mark.name === 'home.useful.commit') {
      if (typeof mark.outcome !== 'string' || !['content', 'empty', 'offline', 'error'].includes(mark.outcome))
        return false;
      usefulMarks += 1;
    }
  }
  // Duplicate first-useful marks are ambiguous, even if one looks plausible.
  return usefulMarks === 1;
}

export function validateCaptureFiles(measurements: unknown, validity: unknown): void {
  const recorded = objectRecord(measurements);
  const verdict = objectRecord(validity);
  if (!recorded) throw new Error('Measurements are missing.');
  if (verdict?.valid !== true || verdict.completed !== true || verdict.configuration !== recorded.configuration) {
    throw new Error(
      'Capture did not explicitly report a completed matching configuration; retain artifacts as incomplete.',
    );
  }
  if (recorded.configuration === 'Release') {
    if (
      !Array.isArray(recorded.launches) ||
      recorded.launches.length !== 10 ||
      !Array.isArray(recorded.memory) ||
      recorded.memory.length !== 20
    ) {
      throw new Error('Incomplete Release capture: expected ten launches and twenty memory cycles.');
    }
    const runtimeIds = new Set<string>();
    for (const [index, trial] of recorded.launches.entries()) {
      const launch = objectRecord(trial);
      const artifact = objectRecord(launch?.artifact);
      if (
        launch?.trial !== index + 1 ||
        !hasUsefulStartupArtifact(artifact) ||
        typeof artifact?.runId !== 'string' ||
        runtimeIds.has(artifact.runId) ||
        typeof launch.hostExportObservedMs !== 'number' ||
        !Number.isFinite(launch.hostExportObservedMs) ||
        launch.hostExportObservedMs < 0
      ) {
        throw new Error('Invalid or stale launch sample.');
      }
      runtimeIds.add(artifact.runId);
    }
    const memoryPid = objectRecord(recorded.memory[0])?.pid;
    for (const [index, observation] of recorded.memory.entries()) {
      const sample = objectRecord(observation);
      if (
        sample?.cycle !== index + 1 ||
        typeof memoryPid !== 'number' ||
        !Number.isInteger(memoryPid) ||
        memoryPid <= 0 ||
        sample.pid !== memoryPid ||
        typeof sample.footprintMiB !== 'number' ||
        !Number.isFinite(sample.footprintMiB) ||
        sample.footprintMiB <= 0
      ) {
        throw new Error('Invalid memory sample or changed process.');
      }
    }
  } else if (recorded.configuration === 'Debug') {
    if (
      recorded.warmupLoops !== 2 ||
      recorded.measuredLoops !== 5 ||
      !Array.isArray(recorded.navigation) ||
      recorded.navigation.length !== 20
    ) {
      throw new Error('Incomplete Debug capture: expected two warmups and five measured four-tab loops.');
    }
    const capabilities = objectRecord(recorded.capability);
    const react = objectRecord(capabilities?.react);
    const completeReactAttribution = react?.available === true && react.complete === true;
    const completeScenarioSamples = recorded.navigation.every(
      (observation) => objectRecord(observation)?.nativeSampleComplete === true,
    );
    if (!completeReactAttribution && !completeScenarioSamples) {
      throw new Error('Debug capture has neither complete React attribution nor complete in-scenario native samples.');
    }
    const routes = ['home', 'climbs', 'discover', 'profile'];
    for (const [index, observation] of recorded.navigation.entries()) {
      const sample = objectRecord(observation);
      const timing = objectRecord(sample?.observation);
      if (
        sample?.loop !== Math.floor(index / 4) + 1 ||
        sample.route !== routes[index % 4] ||
        sample.routeConfirmed !== true ||
        !Array.isArray(timing?.gaps) ||
        timing.gaps.length === 0 ||
        !timing.gaps.every((gap) => typeof gap === 'number' && Number.isFinite(gap) && gap >= 0)
      ) {
        throw new Error('Invalid navigation sample or missing callback observations.');
      }
    }
  } else throw new Error('Unknown profiling configuration.');
}
