import { createHash } from 'node:crypto';

export const PROFILE_APP_ID = 'com.boardsesh.app.perf';
export const PROFILE_SCHEME = 'boardsesh-perf';
export const PROFILE_PROTOCOL_VERSION = 1;
export type ProfilePlatform = 'ios' | 'android';
export type ProfileBoundary = 'start' | 'end' | 'sample';

export interface ProfileExpectedIdentity {
  platform: ProfilePlatform;
  buildId: string;
  sourceCommit: string;
  instrumentationSha256: string;
  fixtureManifestSha256: string;
  embeddedBundleSha256: string;
  artifactSha256: string;
}

export interface ProfileNativeIdentity {
  appId: string;
  configuration: string;
  platform: ProfilePlatform;
  physical: boolean;
  pid: number;
  model: string;
  osVersion: string;
  otaEnabled: boolean;
  embeddedBundleSha256: string;
  artifactSha256: string;
  cpuClock: string;
}

export interface ProfileHello {
  type: 'hello';
  protocolVersion: number;
  runId: string;
  buildId: string;
  sourceCommit: string;
  instrumentationSha256: string;
  fixtureManifestSha256: string;
  native: ProfileNativeIdentity;
  telemetryIsolation: { observeNativePresent: false; appMetricsNativePresent: false };
}

export interface ProfileSnapshot {
  cpuMs: number;
  monotonicMs: number;
  pid: number;
}

export interface ProfileAck {
  type: 'ack';
  requestId: string;
  sessionId: string;
  runId: string;
  segment: string;
  boundary: ProfileBoundary;
  snapshot: ProfileSnapshot;
  counters: Record<string, number>;
}

export function objectRecord(candidate: unknown): Record<string, unknown> {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Expected an object');
  return candidate as Record<string, unknown>;
}

export function requiredString(candidate: unknown, name: string): string {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 256)
    throw new Error(`Invalid ${name}`);
  return candidate;
}

function finiteNonnegative(candidate: unknown, name: string): number {
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) throw new Error(`Invalid ${name}`);
  return candidate;
}

export function parseSnapshot(candidate: unknown): ProfileSnapshot {
  const snapshot = objectRecord(candidate);
  const pid = finiteNonnegative(snapshot.pid, 'PID');
  if (!Number.isSafeInteger(pid) || pid === 0) throw new Error('Invalid PID');
  return {
    cpuMs: finiteNonnegative(snapshot.cpuMs, 'CPU milliseconds'),
    monotonicMs: finiteNonnegative(snapshot.monotonicMs, 'native monotonic milliseconds'),
    pid,
  };
}

export function parseHello(candidate: unknown, expected: ProfileExpectedIdentity): ProfileHello {
  const hello = objectRecord(candidate);
  const native = objectRecord(hello.native);
  const telemetryIsolation = objectRecord(hello.telemetryIsolation);
  if (telemetryIsolation.observeNativePresent !== false || telemetryIsolation.appMetricsNativePresent !== false)
    throw new Error('Profiling runtime must exclude native Observe and AppMetrics collectors');
  if (hello.type !== 'hello' || hello.protocolVersion !== PROFILE_PROTOCOL_VERSION)
    throw new Error('Unsupported profiling protocol');
  for (const key of ['buildId', 'sourceCommit', 'instrumentationSha256', 'fixtureManifestSha256'] as const) {
    if (hello[key] !== expected[key]) throw new Error(`Runtime identity mismatch: ${key}`);
  }
  if (
    native.appId !== PROFILE_APP_ID ||
    native.configuration !== 'Release' ||
    native.platform !== expected.platform ||
    native.physical !== true ||
    native.otaEnabled !== false
  ) {
    throw new Error('Runtime must be the physical Release profiling clone with OTA disabled');
  }
  if (
    native.embeddedBundleSha256 !== expected.embeddedBundleSha256 ||
    native.artifactSha256 !== expected.artifactSha256
  )
    throw new Error('Runtime artifact hashes differ from the source-built export');
  const pid = finiteNonnegative(native.pid, 'native PID');
  if (!Number.isSafeInteger(pid) || pid === 0) throw new Error('Invalid native PID');
  const cpuClock =
    expected.platform === 'ios' ? 'getrusage-self-user-plus-system-ms' : 'android-process-elapsed-cpu-ms';
  if (native.cpuClock !== cpuClock) throw new Error('Native process CPU clock mismatch');
  return {
    type: 'hello',
    protocolVersion: PROFILE_PROTOCOL_VERSION,
    runId: requiredString(hello.runId, 'runtime ID'),
    buildId: expected.buildId,
    sourceCommit: expected.sourceCommit,
    instrumentationSha256: expected.instrumentationSha256,
    fixtureManifestSha256: expected.fixtureManifestSha256,
    telemetryIsolation: { observeNativePresent: false, appMetricsNativePresent: false },
    native: {
      appId: PROFILE_APP_ID,
      configuration: 'Release',
      platform: expected.platform,
      physical: true,
      pid,
      model: requiredString(native.model, 'device model'),
      osVersion: requiredString(native.osVersion, 'OS version'),
      otaEnabled: false,
      embeddedBundleSha256: expected.embeddedBundleSha256,
      artifactSha256: expected.artifactSha256,
      cpuClock,
    },
  };
}

export function parseAck(candidate: unknown): ProfileAck {
  const ack = objectRecord(candidate);
  if (ack.type !== 'ack' || !['start', 'end', 'sample'].includes(String(ack.boundary)))
    throw new Error('Invalid snapshot acknowledgement');
  const counters = objectRecord(ack.counters);
  if (Object.keys(counters).length > 128) throw new Error('Too many profiling counters');
  const boundedCounters: Record<string, number> = {};
  for (const [name, count] of Object.entries(counters)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(name) || !Number.isSafeInteger(count) || Number(count) < 0)
      throw new Error('Invalid profiling counter');
    boundedCounters[name] = Number(count);
  }
  return {
    type: 'ack',
    requestId: requiredString(ack.requestId, 'request ID'),
    sessionId: requiredString(ack.sessionId, 'session ID'),
    runId: requiredString(ack.runId, 'runtime ID'),
    segment: requiredString(ack.segment, 'segment'),
    boundary: ack.boundary as ProfileBoundary,
    snapshot: parseSnapshot(ack.snapshot),
    counters: boundedCounters,
  };
}

export function segmentCpu(before: ProfileSnapshot, after: ProfileSnapshot) {
  if (before.pid !== after.pid || after.cpuMs < before.cpuMs || after.monotonicMs <= before.monotonicMs)
    throw new Error('CPU segment crossed a process change or invalid clock boundary');
  const cpuSeconds = (after.cpuMs - before.cpuMs) / 1000;
  const elapsedSeconds = (after.monotonicMs - before.monotonicMs) / 1000;
  return {
    cpuSeconds,
    elapsedSeconds,
    cpuCorePercent: (100 * cpuSeconds) / elapsedSeconds,
    meaning:
      'Cumulative self-process CPU work across acknowledged native boundaries; elapsed time is the denominator, not UI latency or presented FPS.',
  };
}

/** Optional literal sample pairs bracket cached physical touches, excluding explicit AX queries. */
export function touchSampleWindows(acknowledgements: readonly ProfileAck[]) {
  const windows: {
    window: string;
    group: string;
    before: ProfileAck;
    after: ProfileAck;
    cpu: ReturnType<typeof segmentCpu>;
  }[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < acknowledgements.length; index++) {
    const before = acknowledgements[index];
    const match = /^(.*)\.(touch\d+)\.(before|after)$/.exec(before.segment);
    if (!match) continue;
    const window = `${match[1]}.${match[2]}`;
    const after = acknowledgements[++index];
    if (
      match[3] !== 'before' ||
      before.boundary !== 'sample' ||
      seen.has(window) ||
      !after ||
      after.segment !== `${window}.after` ||
      after.boundary !== 'sample' ||
      before.runId !== after.runId ||
      before.sessionId !== after.sessionId
    )
      throw new Error('Cached touch sample pair is incomplete, reused or crosses runtime identity');
    seen.add(window);
    windows.push({ window, group: match[1], before, after, cpu: segmentCpu(before.snapshot, after.snapshot) });
  }
  return windows;
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Hermes keeps these ASCII literals. This pre-install gate complements, never replaces, the native HELLO. */
export function assertEmbeddedProfileIdentity(
  bundle: Buffer,
  expected: Pick<
    ProfileExpectedIdentity,
    'buildId' | 'sourceCommit' | 'instrumentationSha256' | 'fixtureManifestSha256'
  >,
): void {
  for (const key of ['buildId', 'sourceCommit', 'instrumentationSha256', 'fixtureManifestSha256'] as const) {
    if (!expected[key] || !bundle.includes(Buffer.from(expected[key], 'utf8')))
      throw new Error(
        `Embedded profiling identity is missing: ${key}; rebuild with Metro cache reset before installing`,
      );
  }
}

/** Native executable / DEX inventory, not the separate Hermes JS bundle. */
export function assertTelemetryNativeAbsent(bytes: Buffer, platform: ProfilePlatform): void {
  const forbidden =
    platform === 'ios'
      ? [
          'ObserveModule',
          'AppMetricsModule',
          'ObservabilityManager',
          'ObserveAppDelegateSubscriber',
          'AppMetricsAppDelegateSubscriber',
        ]
      : ['Lexpo/modules/observe/', 'Lexpo/modules/appmetrics/'];
  for (const symbol of forbidden)
    if (bytes.includes(Buffer.from(symbol)))
      throw new Error(`Native telemetry collector remains in ${platform} artifact: ${symbol}`);
}
