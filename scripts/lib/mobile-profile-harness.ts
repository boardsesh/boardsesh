import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadavg } from 'node:os';
import { parseAllDocuments } from 'yaml';
import { readAppIdentity } from './ios-profile-identity';
import { ProfileControl, type ProfileMark } from './mobile-profile-control';
import { assertDeviceProcessPid, selectedDeviceProcessPid } from './mobile-profile-device';
import {
  PROFILE_TEMPLATES,
  templateHash,
  validateLocalEndpoint,
  validateProfileFixtures,
  type PreparedProfile,
  type ProfileOptions,
} from './mobile-profile-prepare';
import {
  PROFILE_APP_ID,
  assertTelemetryNativeAbsent,
  assertEmbeddedProfileIdentity,
  objectRecord,
  requiredString,
  segmentCpu,
  touchSampleWindows,
  sha256,
  type ProfileExpectedIdentity,
  type ProfileHello,
} from './mobile-profile-protocol';

export function validateTraceHandoff(candidate: unknown, hello: ProfileHello, earliestStart: number) {
  const record = objectRecord(candidate);
  for (const key of ['buildId', 'sourceCommit', 'instrumentationSha256', 'fixtureManifestSha256', 'runId'] as const)
    if (record[key] !== hello[key]) throw new Error('Trace handoff identity/readiness mismatch');
  if (
    record.pid !== hello.native.pid ||
    record.runId !== hello.runId ||
    record.buildId !== hello.buildId ||
    record.scope !== 'xctrace-cli-recording-active-output' ||
    !['Time Profiler', 'Animation Hitches'].includes(String(record.template)) ||
    record.timeLimitSeconds !== 240
  )
    throw new Error('Trace handoff identity/readiness mismatch');
  const startedAt = Date.parse(requiredString(record.startedAt, 'trace start'));
  const activeAt = Date.parse(requiredString(record.activeObservedAt, 'trace active observation'));
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(activeAt) ||
    startedAt < earliestStart ||
    activeAt < startedAt ||
    activeAt > Date.now() + 5000
  )
    throw new Error('Trace handoff clock mismatch');
  return {
    pid: hello.native.pid,
    runId: hello.runId,
    buildId: hello.buildId,
    sourceCommit: hello.sourceCommit,
    instrumentationSha256: hello.instrumentationSha256,
    fixtureManifestSha256: hello.fixtureManifestSha256,
    template: record.template,
    timeLimitSeconds: 240,
    startedAt: record.startedAt,
    activeObservedAt: record.activeObservedAt,
    scope: record.scope,
    coverageScope:
      'CLI active output is a readiness observation; actual native trace coverage requires PID/window validation.',
  };
}

function validateTraceHandoffPath(filename: string, runDirectory: string) {
  const handoffDirectory = join(realpathSync(runDirectory), 'trace-handoffs');
  if (
    dirname(resolve(filename)) !== join(resolve(runDirectory), 'trace-handoffs') ||
    realpathSync(dirname(filename)) !== handoffDirectory ||
    !/^[a-f0-9-]{36}\.ready\.json$/.test(filename.split('/').at(-1) ?? '')
  )
    throw new Error('Trace handoff must use the owned run directory');
}

export function traceReadinessTimeoutMs(
  override: string | undefined,
  context: Pick<ProfileOptions, 'platform' | 'uiDriver' | 'warmups' | 'cycles'> & { handoffFile?: string },
) {
  if (override === undefined) return 30_000;
  if (
    !context.handoffFile ||
    context.platform !== 'ios' ||
    context.uiDriver !== 'wda' ||
    !Number.isInteger(context.warmups) ||
    context.warmups < 1 ||
    context.cycles !== 1
  )
    throw new Error('Trace readiness override requires conditioned physical iOS handoff');
  if (override !== '90000') throw new Error('Trace readiness override must be exactly 90000 milliseconds');
  return 90_000;
}

export function traceReadinessRequest(timeoutMs: number) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90_000)
    throw new Error('Trace handoff timeout must be bounded');
  const requestedMonotonicNs = process.hrtime.bigint();
  const requestedEpochMs = Date.now();
  return {
    timeoutMs,
    requestedAt: new Date(requestedEpochMs).toISOString(),
    requestedMonotonicNs: requestedMonotonicNs.toString(),
    deadlineAt: new Date(requestedEpochMs + timeoutMs).toISOString(),
    deadlineMonotonicNs: (requestedMonotonicNs + BigInt(timeoutMs) * 1_000_000n).toString(),
    clockScope: 'UTC observations and shared-host monotonic hrtime; neither is the phone CPU clock.',
  };
}

export async function waitForTraceHandoff(
  filename: string,
  runDirectory: string,
  hello: ProfileHello,
  earliestStart: number,
  failure: () => Error | undefined,
  timeoutMs = 30_000,
  request?: ReturnType<typeof traceReadinessRequest>,
) {
  validateTraceHandoffPath(filename, runDirectory);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90_000)
    throw new Error('Trace handoff timeout must be bounded');
  const readiness = request ?? traceReadinessRequest(timeoutMs);
  if (
    readiness.timeoutMs !== timeoutMs ||
    !Number.isFinite(Date.parse(readiness.requestedAt)) ||
    Date.parse(readiness.deadlineAt) - Date.parse(readiness.requestedAt) !== timeoutMs ||
    !/^\d+$/.test(readiness.requestedMonotonicNs) ||
    !/^\d+$/.test(readiness.deadlineMonotonicNs) ||
    BigInt(readiness.requestedMonotonicNs) > process.hrtime.bigint() ||
    BigInt(readiness.deadlineMonotonicNs) - BigInt(readiness.requestedMonotonicNs) !== BigInt(timeoutMs) * 1_000_000n
  )
    throw new Error('Trace handoff absolute deadline mismatch');
  const deadline = BigInt(readiness.deadlineMonotonicNs);
  while (process.hrtime.bigint() < deadline) {
    const controlFailure = failure();
    if (controlFailure) throw controlFailure;
    if (existsSync(filename)) {
      const status = lstatSync(filename);
      if (!status.isFile() || status.isSymbolicLink() || status.size > 4096)
        throw new Error('Invalid trace handoff file');
      return validateTraceHandoff(JSON.parse(readFileSync(filename, 'utf8')) as unknown, hello, earliestStart);
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
  }
  throw new Error('Trace recording readiness deadline exceeded');
}

export interface ValidatedFlow {
  marks: ProfileMark[];
  files: { path: string; sha256: string }[];
  sha256: string;
}

/** Flatten only unconditional flow includes; measured marks cannot hide in a conditional/loop. */
export function validateProfileFlow(filename: string): ValidatedFlow {
  const files = new Map<string, string>();
  const marks: ProfileMark[] = [];
  const activeFiles = new Set<string>();
  const markerHash = sha256(readFileSync(join(PROFILE_TEMPLATES, 'mark.js')));
  const forbidden = new Set([
    'clearState',
    'clearKeychain',
    'clearAppData',
    'uninstallApp',
    'resetApp',
    'stopApp',
    'evalScript',
  ]);
  const inspect = (candidate: unknown, directory: string, bounded = false): void => {
    if (Array.isArray(candidate)) {
      for (const command of candidate) inspect(command, directory, bounded);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    const command = objectRecord(candidate);
    for (const [name, argument] of Object.entries(command)) {
      if (forbidden.has(name) && argument !== false)
        throw new Error(`Destructive/unspecified Maestro command forbidden: ${name}`);
      if (name === 'launchApp')
        throw new Error(
          'Launch the clone externally after control readiness; flow cannot restart the identified runtime',
        );
      if (name === 'openLink') {
        const link = typeof argument === 'string' ? argument : requiredString(objectRecord(argument).link, 'deep link');
        if (!link.startsWith('boardsesh-perf://'))
          throw new Error('Flow links must target the isolated profiling scheme');
      }
      if (name === 'runScript') {
        const script = typeof argument === 'string' ? { file: argument } : objectRecord(argument);
        const path = realpathSync(resolve(directory, requiredString(script.file, 'mark script')));
        const hash = sha256(readFileSync(path));
        if (hash !== markerHash) throw new Error('Only the reviewed profiling mark script may run in measured flows');
        if (bounded) throw new Error('Measured boundaries must have unconditional, explicit order');
        files.set(path, hash);
        const environment = objectRecord(script.env);
        const segment = requiredString(environment.SEGMENT, 'segment');
        if (
          !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(segment) ||
          !['start', 'end', 'sample'].includes(String(environment.BOUNDARY))
        )
          throw new Error('Literal segment/boundary required');
        marks.push({ segment, boundary: environment.BOUNDARY as ProfileMark['boundary'] });
      } else if (name === 'runFlow') {
        const include = typeof argument === 'string' ? { file: argument } : objectRecord(argument);
        if (include.file) {
          if (bounded || include.when)
            throw new Error('Conditional file flows are not supported in a fixed segmented workload');
          visit(resolve(directory, requiredString(include.file, 'included flow')));
        } else if (include.commands) inspect(include.commands, directory, bounded || Boolean(include.when));
        else throw new Error('Empty flow include');
      } else if (name === 'repeat') {
        inspect(argument, directory, true);
      } else if (typeof argument === 'object') inspect(argument, directory, bounded);
    }
  };
  const visit = (path: string): void => {
    const absolute = realpathSync(path);
    if (activeFiles.has(absolute)) throw new Error('Recursive Maestro flow include');
    activeFiles.add(absolute);
    const contents = readFileSync(absolute, 'utf8');
    files.set(absolute, sha256(contents));
    const documents = parseAllDocuments(contents);
    if (documents.some((document) => document.errors.length)) throw new Error('Invalid Maestro YAML');
    const header = objectRecord(documents[0]?.toJSON() as unknown);
    if (header.appId !== PROFILE_APP_ID) throw new Error('Every flow must target the profiling clone appId');
    if (header.onFlowStart || header.onFlowComplete) throw new Error('Hidden Maestro hooks are not supported');
    for (const document of documents.slice(1)) inspect(document.toJSON() as unknown, dirname(absolute));
    activeFiles.delete(absolute);
  };
  visit(filename);
  let current: string | undefined;
  const completed = new Set<string>();
  for (const mark of marks) {
    if (mark.boundary === 'start') {
      if (current || completed.has(mark.segment)) throw new Error('Segments must be unique and non-overlapping');
      current = mark.segment;
    } else if (mark.boundary === 'end') {
      if (current !== mark.segment) throw new Error('Segment has no matching start');
      completed.add(current);
      current = undefined;
    }
  }
  if (current || completed.size === 0) throw new Error('Flow must contain complete start/end segments');
  const recordedFiles = [...files].map(([path, hash]) => ({ path, sha256: hash }));
  return { marks, files: recordedFiles, sha256: sha256(JSON.stringify(recordedFiles.map(({ sha256: hash }) => hash))) };
}

export interface BackendProof {
  mode: 'replay';
  processInstanceId: string;
  fixtureManifestSHA256: string;
  hits: number;
  misses: number;
  recorded: number;
  redacted: number;
}

export function validateBackendProof(candidate: unknown, manifestHash: string): BackendProof {
  const proof = objectRecord(candidate);
  requiredString(proof.processInstanceId, 'backend process instance');
  if (proof.mode !== 'replay' || proof.fixtureManifestSHA256 !== manifestHash)
    throw new Error('Backend is not replaying the exact loaded fixture manifest');
  for (const key of ['hits', 'misses', 'recorded', 'redacted']) {
    if (!Number.isSafeInteger(proof[key]) || Number(proof[key]) < 0)
      throw new Error('Invalid backend process counters');
  }
  if (proof.recorded !== 0 || proof.redacted !== 0)
    throw new Error('Recording/redacted fixtures are not eligible for acceptance');
  return proof as unknown as BackendProof;
}

export function validateBackendDelta(before: BackendProof, after: BackendProof): void {
  if (
    before.processInstanceId !== after.processInstanceId ||
    before.fixtureManifestSHA256 !== after.fixtureManifestSHA256 ||
    after.hits < before.hits ||
    after.misses !== before.misses ||
    after.recorded !== before.recorded ||
    after.redacted !== before.redacted
  )
    throw new Error('Replay backend changed/restarted or new fixture misses appeared during capture');
}

async function backendProof(origin: string, hash: string): Promise<BackendProof> {
  const response = await fetch(new URL('/__screenshot-backend/status', origin), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Replay backend identity/status unavailable');
  return validateBackendProof((await response.json()) as unknown, hash);
}

export function exportedIdentity(prepared: PreparedProfile, appPath: string): ProfileExpectedIdentity {
  if (prepared.diagnosticOnly === true || prepared.acceptanceEligible === false)
    throw new Error('Diagnostic-only builds are excluded from profiling capture and acceptance');
  let artifactSha256: string, embeddedBundleSha256: string;
  if (prepared.platform === 'ios') {
    const identity = readAppIdentity(appPath, 'Release');
    if (identity.bundleIdentifier !== PROFILE_APP_ID || !identity.embeddedBundleSha256)
      throw new Error('Export must be the embedded Release profiling clone');
    const updates = execFileSync(
      'plutil',
      ['-extract', 'EXUpdatesEnabled', 'raw', '-o', '-', join(appPath, 'Expo.plist')],
      { encoding: 'utf8' },
    ).trim();
    if (updates !== 'false' && updates !== '0') throw new Error('Exported OTA must be explicitly disabled');
    const executable = execFileSync(
      'plutil',
      ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(appPath, 'Info.plist')],
      { encoding: 'utf8' },
    ).trim();
    assertTelemetryNativeAbsent(readFileSync(join(appPath, executable)), 'ios');
    artifactSha256 = identity.executableSha256;
    embeddedBundleSha256 = identity.embeddedBundleSha256;
    assertEmbeddedProfileIdentity(readFileSync(join(appPath, 'main.jsbundle')), prepared);
  } else {
    const dexEntries = execFileSync('unzip', ['-Z1', appPath], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
      .split('\n')
      .filter((entry) => /^classes(?:[0-9]+)?\.dex$/.test(entry));
    if (!dexEntries.length) throw new Error('APK has no native DEX class inventory');
    for (const entry of dexEntries)
      assertTelemetryNativeAbsent(
        execFileSync('unzip', ['-p', appPath, entry], { maxBuffer: 150 * 1024 * 1024 }),
        'android',
      );
    artifactSha256 = sha256(readFileSync(appPath));
    const bundle = execFileSync('unzip', ['-p', appPath, 'assets/index.android.bundle'], {
      maxBuffer: 100 * 1024 * 1024,
    });
    embeddedBundleSha256 = sha256(bundle);
    assertEmbeddedProfileIdentity(bundle, prepared);
  }
  return {
    platform: prepared.platform,
    sourceCommit: prepared.sourceCommit,
    buildId: prepared.buildId,
    instrumentationSha256: prepared.instrumentationSha256,
    fixtureManifestSha256: prepared.fixtureManifestSha256,
    artifactSha256,
    embeddedBundleSha256,
  };
}

export async function captureProfile(options: ProfileOptions): Promise<void> {
  if (!options.appPath || !options.flow) throw new Error('Capture requires --app-path and --flow');
  const prepared = JSON.parse(readFileSync(join(options.runDir, 'prepare.json'), 'utf8')) as PreparedProfile;
  const savedBuildEnvironment = objectRecord(
    JSON.parse(readFileSync(join(options.runDir, 'build-env.json'), 'utf8')) as unknown,
  );
  if (savedBuildEnvironment.EXPO_PUBLIC_MOBILE_PROFILE_DIAGNOSTIC_ONLY === '1')
    throw new Error('Diagnostic-only build environment cannot be measured by the acceptance capture');
  for (const key of ['platform', 'device', 'sourceRef', 'backendUrl', 'controlUrl'] as const)
    if (prepared[key] !== options[key]) throw new Error(`Capture/prepare mismatch: ${key}`);
  if (
    prepared.schemaVersion !== 1 ||
    prepared.appId !== PROFILE_APP_ID ||
    prepared.configuration !== 'Release' ||
    prepared.instrumentationSha256 !== templateHash()
  )
    throw new Error('Stale or unsupported prepared instrumentation');
  const fixtureHash = validateProfileFixtures(options.fixtures);
  if (
    fixtureHash !== prepared.fixtureManifestSha256 ||
    realpathSync(options.fixtures) !== realpathSync(prepared.fixtureDirectory)
  )
    throw new Error('Capture fixtures differ from the prepared build');
  await validateLocalEndpoint(options.backendUrl, 'http:');
  const endpoint = await validateLocalEndpoint(options.controlUrl, 'ws:');
  if (options.uiDriver === 'wda') {
    if (!options.wdaUrl)
      throw new Error('Physical iOS capture requires --wda-url for the independently owned signed runner');
    await validateLocalEndpoint(options.wdaUrl, 'http:');
  }
  const validatedFlow = validateProfileFlow(options.flow);
  const expected = exportedIdentity(prepared, options.appPath);
  const traceHandoffFile = process.env.BOARDSESH_PROFILE_TRACE_READY_FILE;
  if (traceHandoffFile) {
    validateTraceHandoffPath(traceHandoffFile, options.runDir);
    if (
      options.platform !== 'ios' ||
      options.uiDriver !== 'wda' ||
      options.warmups < 1 ||
      options.cycles !== 1 ||
      existsSync(traceHandoffFile)
    )
      throw new Error('Trace capture requires physical iOS conditioning, one measured cycle and a fresh handoff file');
  }
  const traceReadyTimeoutMs = traceReadinessTimeoutMs(process.env.BOARDSESH_PROFILE_TRACE_READY_TIMEOUT_MS, {
    ...options,
    handoffFile: traceHandoffFile,
  });
  const buildEnvironment = objectRecord(
    JSON.parse(readFileSync(join(options.runDir, 'build-env.json'), 'utf8')) as unknown,
  );
  if (buildEnvironment.EXPO_PUBLIC_MOBILE_PROFILE_BUILD_ID !== prepared.buildId)
    throw new Error('Build environment/prepare identity mismatch');
  const control = new ProfileControl(
    expected,
    requiredString(buildEnvironment.EXPO_PUBLIC_MOBILE_PROFILE_TOKEN, 'app control token'),
    5000,
    options.endSettleMs,
  );
  const captureDirectory = join(
    options.runDir,
    'captures',
    new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8),
  );
  mkdirSync(captureDirectory, { recursive: true });
  let ownedChild: ChildProcess | undefined;
  let failure: string | undefined;
  let traceHandoff: ReturnType<typeof validateTraceHandoff> | undefined;
  let traceReadiness: ReturnType<typeof traceReadinessRequest> | undefined;
  const cycles: unknown[] = [];
  const startedAt = new Date().toISOString();
  const abort = () => {
    control.retire(new Error('Capture interrupted'));
    ownedChild?.kill('SIGTERM');
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const initialBackend = await backendProof(options.backendUrl, fixtureHash);
    await control.listen(Number(endpoint.port || 80), options.controlBind);
    console.log(
      JSON.stringify({
        controlReady: true,
        appId: PROFILE_APP_ID,
        device: options.device,
        readinessDeadlineSeconds: 45,
        next: 'Launch the installed clone now; capture will start after native identity acknowledgement.',
      }),
    );
    const hello = await control.waitForHello();
    assertDeviceProcessPid(
      hello.native.pid,
      selectedDeviceProcessPid(options.platform, options.device, options.appPath, captureDirectory),
    );
    writeFileSync(join(captureDirectory, 'runtime-identity.json'), JSON.stringify(hello, null, 2) + '\n');
    for (let index = 0; index < options.warmups + options.cycles; index += 1) {
      if (control.failure) throw control.failure;
      if (traceHandoffFile && index === options.warmups) {
        traceReadiness = traceReadinessRequest(traceReadyTimeoutMs);
        console.log(
          JSON.stringify({
            traceHandoffAwaiting: true,
            captureDirectory,
            pid: hello.native.pid,
            runId: hello.runId,
            buildId: hello.buildId,
            traceReadiness,
          }),
        );
        traceHandoff = await waitForTraceHandoff(
          traceHandoffFile,
          options.runDir,
          hello,
          Date.parse(traceReadiness.requestedAt),
          () => control.failure,
          traceReadyTimeoutMs,
          traceReadiness,
        );
      }
      assertDeviceProcessPid(
        hello.native.pid,
        selectedDeviceProcessPid(options.platform, options.device, options.appPath, captureDirectory),
      );
      // Re-read flow hashes immediately before each cycle; editing during capture is invalid.
      if (validateProfileFlow(options.flow).sha256 !== validatedFlow.sha256)
        throw new Error('Measured flow changed during capture');
      const beforeBackend = await backendProof(options.backendUrl, fixtureHash);
      validateBackendDelta(initialBackend, beforeBackend);
      const hostLoadBefore = loadavg();
      const idleBefore = await control.mark({ segment: 'pre-flow-idle', boundary: 'sample' });
      if (options.idleMs) await new Promise((resolveIdle) => setTimeout(resolveIdle, options.idleMs));
      const beforeRequestHostAt = new Date().toISOString();
      const before = await control.mark({ segment: 'whole-cycle', boundary: 'sample' });
      const beforeAckHostAt = new Date().toISOString();
      control.beginCycle(validatedFlow.marks);
      const cycleDirectory = join(captureDirectory, `cycle-${index + 1}`);
      mkdirSync(cycleDirectory);
      const log = createWriteStream(join(cycleDirectory, `${options.uiDriver}.log`));
      await new Promise<void>((resolveRun, reject) => {
        const markerHost = ['0.0.0.0', '::'].includes(options.controlBind) ? '127.0.0.1' : options.controlBind;
        const markerUrl = new URL(
          '/mark',
          `http://${markerHost.includes(':') ? `[${markerHost}]` : markerHost}:${endpoint.port || 80}`,
        ).href;
        const uiCommand = options.uiDriver === 'wda' ? process.execPath : 'maestro';
        const uiArguments =
          options.uiDriver === 'wda'
            ? [
                '--import',
                'tsx',
                resolve(dirname(fileURLToPath(import.meta.url)), '../mobile-profile-ui-driver.ts'),
                options.wdaUrl!,
                options.flow!,
                cycleDirectory,
                options.device,
              ]
            : [
                '--device',
                options.device,
                'test',
                '--debug-output',
                cycleDirectory,
                '-e',
                `PROFILE_MARK_URL=${markerUrl}`,
                '-e',
                `PROFILE_SESSION_TOKEN=${control.sessionToken}`,
                options.flow!,
              ];
        ownedChild = spawn(uiCommand, uiArguments, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PROFILE_MARK_URL: markerUrl,
            PROFILE_SESSION_TOKEN: control.sessionToken,
            PROFILE_EXPECTED_APP_PID: String(hello.native.pid),
          },
        });
        ownedChild.stdout?.pipe(log, { end: false });
        ownedChild.stderr?.pipe(log, { end: false });
        const timer = setTimeout(() => {
          control.retire(new Error('Physical UI cycle exceeded the 180-second deadline'));
          ownedChild?.kill('SIGTERM');
          reject(control.failure);
        }, 180_000);
        ownedChild.once('error', (error) => {
          clearTimeout(timer);
          log.end();
          reject(error);
        });
        ownedChild.once('exit', (code, signal) => {
          clearTimeout(timer);
          ownedChild = undefined;
          log.end();
          if (code === 0 && !control.failure) resolveRun();
          else reject(control.failure ?? new Error(`Physical ${options.uiDriver} workload failed: ${code ?? signal}`));
        });
      });
      const completed = control.finishCycle();
      const afterRequestHostAt = new Date().toISOString();
      const after = await control.mark({ segment: 'whole-cycle', boundary: 'sample' });
      const afterAckHostAt = new Date().toISOString();
      const afterBackend = await backendProof(options.backendUrl, fixtureHash);
      validateBackendDelta(beforeBackend, afterBackend);
      if (validateProfileFlow(options.flow).sha256 !== validatedFlow.sha256)
        throw new Error('Measured flow changed during capture');
      cycles.push({
        cycle: index + 1,
        warmup: index < options.warmups,
        before,
        after,
        hostClockBounds: {
          beforeRequestHostAt,
          beforeAckHostAt,
          afterRequestHostAt,
          afterAckHostAt,
          scope: 'Host request/ACK receipt bounds for native snapshots; host and native clocks remain distinct.',
        },
        wholeCycle: segmentCpu(before.snapshot, after.snapshot),
        idle: options.idleMs
          ? {
              before: idleBefore,
              after: before,
              cpu: segmentCpu(idleBefore.snapshot, before.snapshot),
              requestedIdleMs: options.idleMs,
              scope:
                'No host gestures during this pre-flow window. Native background/sync/control work remains included; first window may include startup work.',
            }
          : null,
        segments: completed.segments,
        acknowledgements: completed.acknowledgements,
        touchWindows: touchSampleWindows(completed.acknowledgements),
        backend: { before: beforeBackend, after: afterBackend },
        hostLoadBefore,
        hostLoadAfter: loadavg(),
      });
      writeFileSync(join(captureDirectory, 'cycles.json'), JSON.stringify(cycles, null, 2) + '\n');
      console.log(
        JSON.stringify({
          cycle: index + 1,
          warmup: index < options.warmups,
          completed: true,
          nativeCpuSeconds: segmentCpu(before.snapshot, after.snapshot).cpuSeconds,
        }),
      );
    }
    validateBackendDelta(initialBackend, await backendProof(options.backendUrl, fixtureHash));
    const endingIdentity = exportedIdentity(prepared, options.appPath);
    if (JSON.stringify(endingIdentity) !== JSON.stringify(expected)) throw new Error('Export changed during capture');
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    control.retire(new Error(failure));
  } finally {
    ownedChild?.kill('SIGTERM');
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
    await control.close();
    writeFileSync(
      join(captureDirectory, 'measurements.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          suite: options.suite,
          configuration: 'Release',
          platform: options.platform,
          device: options.device,
          sourceCommit: prepared.sourceCommit,
          identity: expected,
          runtime: control.hello,
          runtimeObserved: control.observedHello,
          fixtureScope:
            'Production initial PrivacyChanged true next remains open; explicit recorded SyncDeletions fixtures. No live API.',
          flow: validatedFlow,
          warmups: options.warmups,
          measuredCycles: options.cycles,
          instrumentedTrace: Boolean(traceHandoffFile),
          cpuAcceptanceEligible: !traceHandoffFile,
          traceHandoff: traceHandoff ?? null,
          traceReadyTimeoutMs: traceHandoffFile ? traceReadyTimeoutMs : null,
          traceReadiness: traceReadiness ?? null,
          requestedIdleMs: options.idleMs,
          requestedEndSettleMs: options.endSettleMs,
          endSettleScope:
            'Optional fixed host timer before end ACK includes native background CPU; actual native elapsed is measured. No frame completion or UI latency claim.',
          uiDriver: options.uiDriver,
          uiDriverScope:
            options.uiDriver === 'wda'
              ? 'Owned physical WDA runner with selected runner/app PID checks, preserved app attachment, explicit W3C movement duration and bounded fixed animation pauses. Same YAML logical segments/selector assertions; Android uses a different native UI driver. Whole-cycle CPU includes app work during driver attachment/accessibility checks; segment samples follow the literal native mark boundaries.'
              : 'Official Maestro physical Android driver; UI assertions and gestures are part of the workload. Host automation time is excluded from UI latency claims.',
          startedAt,
          completedAt: new Date().toISOString(),
          cycles,
          controlRoundTripsMs: control.roundTripsMs,
          metricScope:
            'Native cumulative self-process CPU; host automation/mark delays remain in elapsed denominators. No UI latency, frame, renderer-only CPU or causal attribution claim.',
        },
        null,
        2,
      ) + '\n',
    );
    writeFileSync(
      join(captureDirectory, 'validity.json'),
      JSON.stringify(
        {
          valid: !failure && !control.failure && cycles.length === options.warmups + options.cycles,
          completed: !failure && !control.failure,
          failure: failure ?? control.failure?.message ?? null,
          preservesAppData: true,
          instrumentedTrace: Boolean(traceHandoffFile),
          cpuAcceptanceEligible: !traceHandoffFile,
          traceReadyTimeoutMs: traceHandoffFile ? traceReadyTimeoutMs : null,
          traceReadiness: traceReadiness ?? null,
        },
        null,
        2,
      ) + '\n',
    );
  }
  if (failure || control.failure)
    throw new Error(`${failure ?? control.failure?.message}; invalid evidence retained at ${captureDirectory}`);
  console.log(JSON.stringify({ completed: true, valid: true, captureDirectory }));
}
