import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandOutcome,
  commandReceipt,
  deadlineFlags,
  firstAbortRecorder,
  firstFailureRecorder,
  waitForCommandSettlement,
  type CommandOutcome,
} from '../lib/session-input-observation/commands';
import { SESSION_INPUT_NATIVE_HASHES } from '../lib/session-input-observation/cached-app';
import {
  assertObservationViewport,
  assertOriginalCachedIdentity,
  inspectVisibility,
} from '../lib/session-input-observation/guards';

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});
const fixture = JSON.parse(
  readFileSync('scripts/fixtures/session-input-observation/visibility-geometry.json', 'utf8'),
) as {
  cases: {
    name: string;
    pixelWidth: number;
    pixelHeight: number;
    hierarchy: {
      attributes: Record<string, string>;
      children: { attributes: Record<string, string>; children: { attributes: Record<string, string> }[] }[];
    };
  }[];
};
const receipt = (outcome: CommandOutcome, extra: Partial<Parameters<typeof commandReceipt>[0]> = {}) =>
  commandReceipt({
    label: 'launch-1',
    executable: '/usr/bin/xcrun',
    operation: 'launch',
    ownedUdid: 'E78F9F0D-DD89-4F63-845A-08896005E2A2',
    startedAt: '2026-10-31T18:00:00Z',
    completedAt: '2026-10-31T18:00:01Z',
    elapsedSeconds: 1,
    timeoutMs: 30_000,
    outcome,
    flags: deadlineFlags(),
    abort: null,
    controllerAborted: false,
    stdout: '',
    stderr: '',
    metro: { pid: 123, exitCode: null, signal: null },
    ...extra,
  });
async function runningChild(ignoreTerm = false) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''}process.stdout.write('ready');setInterval(()=>{},1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  children.push(child);
  const settlement = waitForCommandSettlement(child);
  await once(child.stdout!, 'data');
  return { child, settlement };
}

describe('passive command settlement and diagnostic redaction', () => {
  it('retains a real nonzero exit without inventing signal or timeout', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(23)'], { stdio: 'ignore' });
    children.push(child);
    const result = receipt(await waitForCommandSettlement(child));
    expect(result).toMatchObject({
      status: 23,
      exitCode: 23,
      signal: null,
      spawnErrno: null,
      timeoutFired: false,
      hardTimeoutFired: false,
      firstAbort: null,
    });
  });
  it('retains real spawn errno and settles once even when close follows error', async () => {
    const child = spawn('/boardsesh-test-does-not-exist', [], { stdio: 'ignore' });
    children.push(child);
    const outcome = await waitForCommandSettlement(child);
    expect(outcome).toMatchObject({
      status: -1,
      exitCode: null,
      signal: null,
      spawnErrno: 'ENOENT',
      settledBy: 'error',
    });
    const emitter = new EventEmitter();
    const settlement = waitForCommandSettlement(emitter as unknown as Pick<ChildProcess, 'once'>);
    emitter.emit('error', { code: 'EACCES', message: 'password=private' });
    emitter.emit('exit', 0, null);
    emitter.emit('close', 9, 'SIGKILL');
    expect(await settlement).toEqual(commandOutcome(null, null, 'error', { code: 'EACCES' }));
  });
  it('distinguishes a real external SIGTERM from a configured deadline', async () => {
    const { child, settlement } = await runningChild();
    child.kill('SIGTERM');
    expect(receipt(await settlement)).toMatchObject({
      status: -1,
      exitCode: null,
      signal: 'SIGTERM',
      timeoutMs: 30_000,
      timeoutFired: false,
      stopEscalationFired: false,
      controllerAborted: false,
    });
  });
  it('reports actual soft/escalation callbacks separately from a global abort', async () => {
    const { child, settlement } = await runningChild(true);
    const flags = deadlineFlags();
    const soft = setTimeout(() => {
      flags.timeoutFired = true;
      child.kill('SIGTERM');
    }, 10);
    const hard = setTimeout(() => {
      flags.stopEscalationFired = true;
      child.kill('SIGKILL');
    }, 40);
    const outcome = await settlement;
    clearTimeout(soft);
    clearTimeout(hard);
    expect(receipt(outcome, { timeoutMs: 10, flags })).toMatchObject({
      signal: 'SIGKILL',
      exitCode: null,
      timeoutFired: true,
      stopEscalationFired: true,
      hardTimeoutFired: false,
      firstAbort: null,
    });
    const aborts = firstAbortRecorder();
    aborts.record('SIGTERM');
    aborts.record('observation_deadline');
    expect(
      receipt(commandOutcome(null, 'SIGTERM', 'exit'), { controllerAborted: true, abort: aborts.current() }),
    ).toMatchObject({ timeoutFired: false, controllerAborted: true, firstAbort: { source: 'SIGTERM' } });
  });
  it('retains a separately fired hard deadline rather than inferring it from the signal', async () => {
    const { child, settlement } = await runningChild(true);
    const flags = deadlineFlags();
    const timer = setTimeout(() => {
      flags.hardTimeoutFired = true;
      child.kill('SIGKILL');
    }, 10);
    const result = receipt(await settlement, { flags });
    clearTimeout(timer);
    expect(result).toMatchObject({
      signal: 'SIGKILL',
      hardTimeoutFired: true,
      timeoutFired: false,
      stopEscalationFired: false,
    });
  });
  it('retains only native error enums/numbers and exact successful launch PID', () => {
    const result = receipt(commandOutcome(60, null, 'exit'), {
      stderr: 'domain=NSPOSIXErrorDomain, code=60: password=private token=private',
      stdout: 'com.boardsesh.app: 987\nsecret=private',
    });
    expect(result.nativeReason).toEqual({ domain: 'NSPOSIXErrorDomain', code: 60 });
    expect(result.launchedAppPid).toBeNull();
    expect(
      receipt(commandOutcome(0, null, 'exit'), { stdout: 'com.boardsesh.app: 987\npassword=private' }).launchedAppPid,
    ).toBe(987);
    expect(receipt(commandOutcome(0, null, 'exit'), { stdout: 'different.app: 987' }).launchedAppPid).toBeNull();
    expect(
      receipt(commandOutcome(1, null, 'exit'), { stderr: 'a totally unrecognized secret message' }).nativeReason,
    ).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/password|token|private|stdout|stderr/);
    const aborts = firstAbortRecorder();
    aborts.record('critical_server_exit', { name: 'https://private', error: { code: 'secret', message: 'private' } });
    expect(aborts.current()).toMatchObject({ server: null, spawnErrno: 'unrecognized_errno' });
    expect(JSON.stringify(aborts.current())).not.toContain('private');
  });
  it('freezes the first failing command before later sensor/capture/cleanup failures', () => {
    const failures = firstFailureRecorder();
    const original = receipt(commandOutcome(null, 'SIGTERM', 'exit'));
    const first = failures.freeze('launch-1_command_failed', original);
    failures.freeze('screenshot_command_failed', receipt(commandOutcome(9, null, 'exit')));
    failures.freeze('cleanup_failed');
    expect(failures.current()).toBe(first);
    expect(first).toEqual({ code: 'launch-1_command_failed', command: original });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.command)).toBe(true);
  });
});

describe('original immutable native identity and real viewport gate', () => {
  const hashes = {
    ...SESSION_INPUT_NATIVE_HASHES,
    'Info.plist': '119d9d2701ae20b054ce3e08c4e851b653a857413cf8070e5a454cc68d6fdc60',
  };
  const metadata = {
    CFBundleIdentifier: 'com.boardsesh.app',
    DTSDKName: 'iphonesimulator26.5',
    DTXcodeBuild: '17F113',
  };
  it('requires original main/debug/plist bytes and SDK before launch, never a signed copy identity', () => {
    expect(() => assertOriginalCachedIdentity(hashes, metadata, 'arm64')).not.toThrow();
    for (const name of Object.keys(hashes))
      expect(() => assertOriginalCachedIdentity({ ...hashes, [name]: 'changed' }, metadata, 'arm64')).toThrow(
        'original_native_identity_unverified',
      );
    expect(() => assertOriginalCachedIdentity(hashes, metadata, 'x64')).toThrow();
    expect(() =>
      assertOriginalCachedIdentity(hashes, { ...metadata, DTSDKName: 'iphonesimulator27.1' }, 'arm64'),
    ).toThrow();
  });
  it('accepts actual ARM geometry and binds the foreground portrait to its fresh3x PNG', () => {
    const arm = fixture.cases[0];
    const visibility = inspectVisibility(arm.hierarchy, true);
    expect(visibility.point).toEqual({ x: 369, y: 487 });
    const viewport = {
      pixelWidth: arm.pixelWidth,
      pixelHeight: arm.pixelHeight,
      screenBounds: visibility.screenBounds,
      foregroundBundle: 'com.boardsesh.app',
      ownedUdid: 'E78F9F0D-DD89-4F63-845A-08896005E2A2',
    };
    expect(assertObservationViewport(viewport)).toMatchObject({
      width: 440,
      height: 956,
      scale: 3,
      orientation: 'portrait',
    });
    for (const changed of [
      { pixelWidth: 880, pixelHeight: 1912 },
      { pixelWidth: 2868, pixelHeight: 1320 },
      { pixelWidth: undefined },
      { foregroundBundle: 'another.app' },
      { ownedUdid: null },
      { ownedUdid: '------------------------------------' },
    ])
      expect(() => assertObservationViewport({ ...viewport, ...changed })).toThrow('portrait_viewport_unverified');
  });
  it('refuses actual clipped Intel parent/thumb before any point contact', () => {
    expect(() => inspectVisibility(fixture.cases[1].hierarchy, true)).toThrow('visibility_target_clipped');
    const thumbClipped = structuredClone(fixture.cases[0].hierarchy);
    thumbClipped.children[0].children[2].attributes.bounds = '[346,473][450,501]';
    expect(() => inspectVisibility(thumbClipped, true)).toThrow('visibility_target_clipped');
    const parentClipped = structuredClone(fixture.cases[0].hierarchy);
    parentClipped.children[0].attributes.bounds = '[32,456][486,518]';
    expect(() => inspectVisibility(parentClipped, true)).toThrow('visibility_target_clipped');
  });
  it('never substitutes a larger zero-origin AX descendant for the app viewport', () => {
    const arm = structuredClone(fixture.cases[0].hierarchy);
    arm.children.push({ attributes: { bounds: '[0,0][9999,9999]' }, children: [] });
    expect(inspectVisibility(arm, true).screenBounds).toEqual({ left: 0, top: 0, right: 440, bottom: 956 });
    arm.attributes.bounds = '[0,0][9999,9999]';
    expect(() => inspectVisibility(arm, true)).toThrow('app_viewport_unverified');
  });
  it('keeps process/launcher/transport behavior unchanged and validates PNG before a contact flow', () => {
    const source = readFileSync('scripts/observe-session-input.ts', 'utf8');
    const commands = readFileSync('scripts/lib/session-input-observation/commands.ts', 'utf8');
    expect(commands).not.toMatch(/\bfetch\(|\bspawn\(|process\.kill\(/);
    expect(source).toContain(
      "await checked(`launch-${activeAttempt}`, 'xcrun', ['simctl', 'launch', ownedUdid, 'com.boardsesh.app']);",
    );
    expect(source).toContain('timeoutMs = 30_000');
    expect(source).toContain('timeout: 15_000');
    expect(source).toContain('channel!.homeReady(), 240_000');
    expect(source).toContain('23 * 60_000');
    expect(source).not.toContain('--initialUrl');
    expect(source).toContain('com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max');
    expect(source).toContain('com.apple.CoreSimulator.SimRuntime.iOS-26-5');
    expect(source.indexOf('assertOriginalCachedIdentity(hashes')).toBeLessThan(
      source.indexOf('applyObservationWrapper(ROOT'),
    );
    expect(source.indexOf('const mask = await redactedScreenshot')).toBeLessThan(
      source.indexOf('writeFileSync(tapFlow'),
    );
    expect(source).toContain('viewport = assertObservationViewport(');
    const failure = source.slice(source.indexOf('  } catch (error) {\n    const failure = failures.freeze'));
    expect(failure.indexOf('failures.freeze')).toBeLessThan(failure.indexOf("memorySnapshot('failure')"));
    expect(source).toContain('fail(`${label}_command_failed`, result.receipt)');
  });
});
