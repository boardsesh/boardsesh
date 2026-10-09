import {
  validateGeneratedTelemetryInventories,
  validateProfileAutolinking,
} from '../mobile-profile-validate-autolinking';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfileControl, ProfileCycle } from '../lib/mobile-profile-control';
import { androidProcessPid, assertDeviceProcessPid, iosProcessPid } from '../lib/mobile-profile-device';
import {
  exportedIdentity,
  validateBackendDelta,
  validateBackendProof,
  validateProfileFlow,
  validateTraceHandoff,
  waitForTraceHandoff,
  traceReadinessTimeoutMs,
  traceReadinessRequest,
  awaitProfileLifecycleHook,
} from '../lib/mobile-profile-harness';
import type { PreparedProfile } from '../lib/mobile-profile-prepare';
import {
  injectProfileTemplates,
  parseMobileProfileArgs,
  prepareProfile,
  privateAddress,
  templateHash,
  validateProfileFixtures,
} from '../lib/mobile-profile-prepare';
import {
  assertEmbeddedProfileIdentity,
  assertTelemetryNativeAbsent,
  parseAck,
  parseHello,
  segmentCpu,
  touchSampleWindows,
  type ProfileAck,
  type ProfileExpectedIdentity,
} from '../lib/mobile-profile-protocol';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryDirectories: string[] = [];
function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'boardsesh-mobile-profile-test-'));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('bounded optional capture lifecycle admission', () => {
  it('retires pending admission when control fails, before later host launch or marks', async () => {
    vi.useFakeTimers();
    let failure: Error | undefined;
    let hookSignal: AbortSignal | undefined;
    let finish: (() => void) | undefined;
    const launch = vi.fn();
    const mark = vi.fn();
    const admission = awaitProfileLifecycleHook(
      async (signal) => {
        hookSignal = signal;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        if (!signal.aborted) launch();
      },
      new AbortController().signal,
      () => failure,
    ).then(mark);
    const rejected = expect(admission).rejects.toThrow('Disconnected');
    await Promise.resolve();
    failure = new Error('Disconnected');
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(hookSignal?.aborted).toBe(true);
    finish!();
    await Promise.resolve();
    expect(launch).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
  });
  it('awaits admission before subsequent measurement work', async () => {
    const order: string[] = [];
    let finishAdmission: (() => void) | undefined;
    const admitted = awaitProfileLifecycleHook(
      async () => {
        order.push('admission-start');
        await new Promise<void>((resolve) => {
          finishAdmission = resolve;
        });
        order.push('admission-end');
      },
      new AbortController().signal,
      () => undefined,
    ).then(() => order.push('first-mark'));
    await Promise.resolve();
    expect(order).toEqual(['admission-start']);
    finishAdmission!();
    await admitted;
    expect(order).toEqual(['admission-start', 'admission-end', 'first-mark']);
  });

  it('retires a timed-out callback and never admits its late completion', async () => {
    vi.useFakeTimers();
    let hookSignal: AbortSignal | undefined;
    let finishAdmission: (() => void) | undefined;
    const mark = vi.fn();
    const admission = awaitProfileLifecycleHook(
      async (signal) => {
        hookSignal = signal;
        await new Promise<void>((resolve) => {
          finishAdmission = resolve;
        });
      },
      new AbortController().signal,
      () => undefined,
      20,
    ).then(mark);
    const rejected = expect(admission).rejects.toThrow('deadline exceeded');
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(hookSignal?.aborted).toBe(true);
    finishAdmission!();
    await Promise.resolve();
    expect(mark).not.toHaveBeenCalled();
  });

  it('does not start host launch work when cancelled before callback dispatch', async () => {
    const capture = new AbortController();
    const launch = vi.fn(async () => {});
    const admission = awaitProfileLifecycleHook(launch, capture.signal, () => undefined);
    capture.abort();
    await expect(admission).rejects.toThrow('interrupted');
    expect(launch).not.toHaveBeenCalled();
  });

  it('cancels in-flight host work and rejects admission', async () => {
    const capture = new AbortController();
    let signal: AbortSignal | undefined;
    const admission = awaitProfileLifecycleHook(
      async (hookSignal) => {
        signal = hookSignal;
        await new Promise<void>(() => {});
      },
      capture.signal,
      () => undefined,
    );
    await Promise.resolve();
    capture.abort();
    await expect(admission).rejects.toThrow('interrupted');
    expect(signal?.aborted).toBe(true);
  });

  it('rejects control failure before and after an awaited hook', async () => {
    const launch = vi.fn(async () => {});
    await expect(
      awaitProfileLifecycleHook(launch, new AbortController().signal, () => new Error('Disconnected')),
    ).rejects.toThrow('Disconnected');
    expect(launch).not.toHaveBeenCalled();
    let failure: Error | undefined;
    await expect(
      awaitProfileLifecycleHook(
        async () => {
          failure = new Error('Disconnected');
        },
        new AbortController().signal,
        () => failure,
      ),
    ).rejects.toThrow('Disconnected');
  });

  it('aborts the hook signal on callback failure and rejects unbounded deadlines', async () => {
    let signal: AbortSignal | undefined;
    await expect(
      awaitProfileLifecycleHook(
        async (hookSignal) => {
          signal = hookSignal;
          throw new Error('Launch proof rejected');
        },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow('Launch proof rejected');
    expect(signal?.aborted).toBe(true);
    for (const timeout of [0, 30_001, 1.5, NaN])
      await expect(
        awaitProfileLifecycleHook(
          async () => {},
          new AbortController().signal,
          () => undefined,
          timeout,
        ),
      ).rejects.toThrow('bounded');
  });
});

describe('conditioned native trace handoff', () => {
  function readyRecord() {
    const hello = parseHello(helloCandidate(), expected);
    return {
      hello,
      record: {
        pid: hello.native.pid,
        runId: hello.runId,
        buildId: hello.buildId,
        sourceCommit: hello.sourceCommit,
        instrumentationSha256: hello.instrumentationSha256,
        fixtureManifestSha256: hello.fixtureManifestSha256,
        template: 'Time Profiler',
        timeLimitSeconds: 240,
        startedAt: new Date(Date.now() - 100).toISOString(),
        activeObservedAt: new Date().toISOString(),
        scope: 'xctrace-cli-recording-active-output',
      },
    };
  }
  it('keeps the untraced default and permits only an explicit conditioned iOS 90-second policy', () => {
    const context = { platform: 'ios' as const, uiDriver: 'wda' as const, warmups: 1, cycles: 1, handoffFile: 'owned' };
    expect(traceReadinessTimeoutMs(undefined, { ...context, handoffFile: undefined })).toBe(30_000);
    expect(traceReadinessTimeoutMs(undefined, { ...context, platform: 'android', uiDriver: 'maestro' })).toBe(30_000);
    expect(traceReadinessTimeoutMs('90000', context)).toBe(90_000);
    for (const invalid of ['', '30000', '90000.0', '90000.5', '90001', 'Infinity', '90e3', '-90000'])
      expect(() => traceReadinessTimeoutMs(invalid, context)).toThrow('exactly');
    for (const invalidContext of [
      { ...context, handoffFile: undefined },
      { ...context, platform: 'android' as const },
      { ...context, uiDriver: 'maestro' as const },
      { ...context, warmups: 0 },
      { ...context, warmups: Number.NaN },
      { ...context, cycles: 2 },
    ])
      expect(() => traceReadinessTimeoutMs('90000', invalidContext)).toThrow('conditioned');
  });
  it('accepts validated active output after 30 seconds within the explicit 90-second absolute deadline', async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    mkdirSync(join(directory, 'trace-handoffs'));
    const filename = join(directory, 'trace-handoffs', '11111111-1111-1111-1111-111111111111.ready.json');
    const { hello, record } = readyRecord();
    const request = traceReadinessRequest(90_000);
    const ready = waitForTraceHandoff(
      filename,
      directory,
      hello,
      Date.parse(request.requestedAt),
      () => undefined,
      90_000,
      request,
    );
    await vi.advanceTimersByTimeAsync(35_000);
    writeFileSync(
      filename,
      JSON.stringify({ ...record, startedAt: request.requestedAt, activeObservedAt: new Date().toISOString() }),
    );
    await vi.advanceTimersByTimeAsync(50);
    expect((await ready).pid).toBe(hello.native.pid);
  });
  it('preserves the default deadline and cannot revive a timed-out handoff with late facts', async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    mkdirSync(join(directory, 'trace-handoffs'));
    const filename = join(directory, 'trace-handoffs', '11111111-1111-1111-1111-111111111111.ready.json');
    const { hello, record } = readyRecord();
    const result = waitForTraceHandoff(filename, directory, hello, 0, () => undefined).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toBeInstanceOf(Error);
    expect(String(await result)).toContain('deadline');
    writeFileSync(filename, JSON.stringify(record));
    await vi.advanceTimersByTimeAsync(100);
    expect(String(await result)).toContain('deadline');
  });
  it('uses the original absolute deadline instead of restarting the budget after setup', async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    mkdirSync(join(directory, 'trace-handoffs'));
    const filename = join(directory, 'trace-handoffs', '11111111-1111-1111-1111-111111111111.ready.json');
    const { hello } = readyRecord();
    const request = traceReadinessRequest(90_000);
    await vi.advanceTimersByTimeAsync(20_000);
    let settled = false;
    const result = waitForTraceHandoff(filename, directory, hello, 0, () => undefined, 90_000, request).catch(
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await vi.advanceTimersByTimeAsync(69_950);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(String(await result)).toContain('deadline');
  });
  it('still rejects retired control, stale PID and outside paths under the 90-second policy', async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    mkdirSync(join(directory, 'trace-handoffs'));
    const filename = join(directory, 'trace-handoffs', '11111111-1111-1111-1111-111111111111.ready.json');
    const { hello, record } = readyRecord();
    let retired: Error | undefined;
    const result = waitForTraceHandoff(filename, directory, hello, 0, () => retired, 90_000).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(31_000);
    retired = new Error('retired control');
    writeFileSync(filename, JSON.stringify(record));
    await vi.advanceTimersByTimeAsync(50);
    expect(String(await result)).toContain('retired control');
    writeFileSync(filename, JSON.stringify({ ...record, pid: hello.native.pid + 1 }));
    await expect(waitForTraceHandoff(filename, directory, hello, 0, () => undefined, 90_000)).rejects.toThrow(
      'mismatch',
    );
    await expect(
      waitForTraceHandoff(join(directory, 'outside.json'), directory, hello, 0, () => undefined, 90_000),
    ).rejects.toThrow('owned');
  });
  it('rejects an invalid or extended absolute deadline', async () => {
    const directory = temporaryDirectory();
    mkdirSync(join(directory, 'trace-handoffs'));
    const filename = join(directory, 'trace-handoffs', '11111111-1111-1111-1111-111111111111.ready.json');
    const { hello } = readyRecord();
    const request = traceReadinessRequest(90_000);
    await expect(
      waitForTraceHandoff(filename, directory, hello, 0, () => undefined, 90_000, {
        ...request,
        deadlineMonotonicNs: (BigInt(request.deadlineMonotonicNs) + 1n).toString(),
      }),
    ).rejects.toThrow('deadline mismatch');
    for (const timeout of [90_001, 1.5, Number.NaN])
      await expect(waitForTraceHandoff(filename, directory, hello, 0, () => undefined, timeout)).rejects.toThrow(
        'bounded',
      );
  });
  it('accepts only recording-active facts for the validated process and source', () => {
    const { hello, record } = readyRecord();
    expect(validateTraceHandoff(record, hello, Date.now() - 1000).pid).toBe(hello.native.pid);
    for (const mismatch of [
      { pid: hello.native.pid + 1 },
      { runId: 'another-process' },
      { sourceCommit: 'stale' },
      { scope: 'spawned-only' },
      { timeLimitSeconds: 180 },
      { template: 'unknown' },
    ])
      expect(() => validateTraceHandoff({ ...record, ...mismatch }, hello, Date.now() - 1000)).toThrow('mismatch');
  });
  it('rejects recordings started before final conditioning and invalid clocks', () => {
    const { hello, record } = readyRecord();
    expect(() => validateTraceHandoff(record, hello, Date.now())).toThrow('clock');
    expect(() => validateTraceHandoff({ ...record, activeObservedAt: 'invalid' }, hello, 0)).toThrow('clock');
  });
  it('waits for a scoped regular readiness file without executing a UI callback', async () => {
    const directory = temporaryDirectory();
    mkdirSync(join(directory, 'trace-handoffs'));
    const filename = join(directory, 'trace-handoffs', '11111111-1111-1111-1111-111111111111.ready.json');
    const { hello, record } = readyRecord();
    const ready = waitForTraceHandoff(filename, directory, hello, Date.now() - 1000, () => undefined, 500);
    writeFileSync(filename, JSON.stringify(record));
    expect((await ready).pid).toBe(hello.native.pid);
  });
  it('fails closed for outside paths, symlinks and absent readiness', async () => {
    const directory = temporaryDirectory();
    mkdirSync(join(directory, 'trace-handoffs'));
    const filename = join(directory, 'trace-handoffs', '11111111-1111-1111-1111-111111111111.ready.json');
    const { hello, record } = readyRecord();
    await expect(
      waitForTraceHandoff(join(directory, 'outside.json'), directory, hello, 0, () => undefined, 25),
    ).rejects.toThrow('owned');
    await expect(waitForTraceHandoff(filename, directory, hello, 0, () => undefined, 25)).rejects.toThrow('deadline');
    writeFileSync(join(directory, 'outside.json'), JSON.stringify(record));
    symlinkSync(join(directory, 'outside.json'), filename);
    await expect(waitForTraceHandoff(filename, directory, hello, 0, () => undefined, 25)).rejects.toThrow('file');
  });
  it('retires an interrupted or unbounded handoff before accepting facts', async () => {
    const directory = temporaryDirectory();
    mkdirSync(join(directory, 'trace-handoffs'));
    const filename = join(directory, 'trace-handoffs', '11111111-1111-1111-1111-111111111111.ready.json');
    const { hello, record } = readyRecord();
    writeFileSync(filename, JSON.stringify(record));
    await expect(waitForTraceHandoff(filename, directory, hello, 0, () => new Error('retired'), 25)).rejects.toThrow(
      'retired',
    );
    await expect(
      waitForTraceHandoff(filename, directory, hello, 0, () => undefined, Number.POSITIVE_INFINITY),
    ).rejects.toThrow('bounded');
  });
});

const expected: ProfileExpectedIdentity = {
  platform: 'ios',
  buildId: 'build-a',
  sourceCommit: 'source-a',
  instrumentationSha256: 'instrument-a',
  fixtureManifestSha256: 'fixture-a',
  embeddedBundleSha256: 'bundle-a',
  artifactSha256: 'artifact-a',
};
function helloCandidate() {
  return {
    type: 'hello',
    protocolVersion: 1,
    runId: 'runtime-one',
    telemetryIsolation: { observeNativePresent: false, appMetricsNativePresent: false },
    ...expected,
    native: {
      platform: 'ios',
      appId: 'com.boardsesh.app.perf',
      physical: true,
      configuration: 'Release',
      otaEnabled: false,
      pid: 42,
      model: 'iPhone14,2',
      osVersion: '26.0',
      cpuClock: 'getrusage-self-user-plus-system-ms',
      embeddedBundleSha256: expected.embeddedBundleSha256,
      artifactSha256: expected.artifactSha256,
    },
  };
}
function acknowledgement(
  boundary: 'start' | 'end',
  cpuMs: number,
  monotonicMs: number,
  counters = { renders: 1 },
): ProfileAck {
  return {
    type: 'ack',
    requestId: 'request',
    sessionId: 'session',
    runId: 'runtime-one',
    segment: 'climbs',
    boundary,
    snapshot: { pid: 42, cpuMs, monotonicMs },
    counters,
  };
}

describe('native mobile profiling protocol', () => {
  it('rejects a remaining native collector in the export or runtime registry', () => {
    expect(() => assertTelemetryNativeAbsent(Buffer.from('ordinary native code'), 'ios')).not.toThrow();
    expect(() => assertTelemetryNativeAbsent(Buffer.from('ObserveModule'), 'ios')).toThrow('collector');
    expect(() =>
      assertTelemetryNativeAbsent(Buffer.from('Lexpo/modules/appmetrics/AppMetricsModule;'), 'android'),
    ).toThrow('collector');
    expect(() =>
      parseHello(
        { ...helloCandidate(), telemetryIsolation: { observeNativePresent: true, appMetricsNativePresent: false } },
        expected,
      ),
    ).toThrow('collectors');
    expect(() => parseHello({ ...helloCandidate(), telemetryIsolation: undefined }, expected)).toThrow();
    const directory = temporaryDirectory(),
      provider = join(directory, 'ExpoModulesProvider.swift');
    writeFileSync(provider, 'return [MobileCpuProfileModule.self]');
    expect(validateGeneratedTelemetryInventories([provider])[0].nativeTelemetryModulesAbsent).toBe(true);
    writeFileSync(provider, 'return [ObserveModule.self]');
    expect(() => validateGeneratedTelemetryInventories([provider])).toThrow('inventory');
  });

  it('rejects cached embedded source/build metadata before installation', () => {
    expect(() => assertEmbeddedProfileIdentity(Buffer.from(JSON.stringify(expected)), expected)).not.toThrow();
    expect(() =>
      assertEmbeddedProfileIdentity(Buffer.from(JSON.stringify({ ...expected, buildId: 'prior-build' })), expected),
    ).toThrow('buildId');
    expect(() =>
      assertEmbeddedProfileIdentity(Buffer.from(JSON.stringify(expected) + '[profile-diagnostic-only]'), expected),
    ).toThrow('Diagnostic-only');
    expect(() => exportedIdentity({ diagnosticOnly: true } as PreparedProfile, '/never-read-artifact')).toThrow(
      'Diagnostic-only',
    );
  });
  it('binds the native PID to the unique clone process on the selected physical device', () => {
    expect(androidProcessPid('42\n')).toBe(42);
    expect(() => androidProcessPid('42 43')).toThrow('exactly one');
    expect(() => androidProcessPid('')).toThrow();
    const process = { executable: '/private/containers/BoardseshPerf.app/BoardseshPerf', processIdentifier: 42 };
    expect(
      iosProcessPid(
        {
          result: {
            runningProcesses: [process, { executable: '/prod/Boardsesh.app/Boardsesh', processIdentifier: 43 }],
          },
        },
        'BoardseshPerf',
      ),
    ).toBe(42);
    expect(() => iosProcessPid({ result: { runningProcesses: [process, process] } }, 'BoardseshPerf')).toThrow(
      'exactly one',
    );
    expect(() => assertDeviceProcessPid(42, 43)).toThrow('selected physical');
  });
  it('uses cumulative CPU milliseconds and native elapsed seconds without claiming UI latency', () => {
    const measured = segmentCpu(
      { pid: 42, cpuMs: 1250, monotonicMs: 1000 },
      { pid: 42, cpuMs: 1500, monotonicMs: 3000 },
    );
    expect(measured.cpuSeconds).toBe(0.25);
    expect(measured.elapsedSeconds).toBe(2);
    expect(measured.cpuCorePercent).toBe(12.5);
    expect(() => segmentCpu({ pid: 42, cpuMs: 1, monotonicMs: 1 }, { pid: 43, cpuMs: 2, monotonicMs: 2 })).toThrow(
      'process',
    );
  });
  it('requires observed physical Release clone identity and exact installed artifact hashes', () => {
    expect(parseHello(helloCandidate(), expected).native.pid).toBe(42);
    for (const patch of [
      { physical: false },
      { otaEnabled: true },
      { configuration: 'Debug' },
      { appId: 'com.boardsesh.app' },
      { artifactSha256: 'stale' },
    ]) {
      const candidate = helloCandidate();
      Object.assign(candidate.native, patch);
      expect(() => parseHello(candidate, expected)).toThrow();
    }
    expect(() => parseHello({ ...helloCandidate(), buildId: 'old' }, expected)).toThrow('buildId');
  });
  it('rejects incomplete/out-of-order cycles, process changes, and disappearing counters', () => {
    const marks = [
      { segment: 'climbs', boundary: 'start' as const },
      { segment: 'climbs', boundary: 'end' as const },
    ];
    const cycle = new ProfileCycle(parseHello(helloCandidate(), expected), marks);
    expect(() => cycle.complete()).toThrow('Incomplete');
    expect(() => cycle.accept(acknowledgement('end', 5, 5))).toThrow('order');
    cycle.accept(acknowledgement('start', 100, 1000));
    expect(() => cycle.accept({ ...acknowledgement('end', 300, 2000), counters: {} })).toThrow('counter');
    expect(() => cycle.accept({ ...acknowledgement('end', 300, 2000), runId: 'new-process' })).toThrow('identity');
    cycle.accept(acknowledgement('end', 300, 2000, { renders: 4 }));
    cycle.complete();
    expect(cycle.segments[0].counterDeltas).toEqual({ renders: 3 });
  });
  it('pairs only adjacent native touch samples and retains the fixed-tail elapsed window', () => {
    const before = {
      ...acknowledgement('start', 10, 100),
      boundary: 'sample' as const,
      segment: 'climbs.touch01.before',
    };
    const after = { ...acknowledgement('end', 30, 1150), boundary: 'sample' as const, segment: 'climbs.touch01.after' };
    const windows = touchSampleWindows([before, after]);
    expect(windows[0].cpu.cpuSeconds).toBe(0.02);
    expect(windows[0].cpu.elapsedSeconds).toBe(1.05);
    expect(() => touchSampleWindows([before])).toThrow('incomplete');
    expect(() => touchSampleWindows([before, { ...after, runId: 'changed' }])).toThrow('identity');
    expect(() => touchSampleWindows([before, after, before, after])).toThrow('reused');
  });
  it('validates counter integers and snapshot clocks', () => {
    expect(() => parseAck({ ...acknowledgement('start', -1, 2) })).toThrow('CPU');
    expect(() => parseAck({ ...acknowledgement('start', 1, 2), counters: { renders: 0.5 } })).toThrow('counter');
  });
  it('acknowledges fixed settling before the native end snapshot and rejects a counter reset between cycles', async () => {
    vi.useFakeTimers();
    class NativeSocket extends EventEmitter {
      readyState = 1;
      clock = 0;
      count = 0;
      resetCounter = false;
      send(bytes: string, callback?: (error?: Error) => void) {
        const request = JSON.parse(bytes) as Record<string, unknown>;
        if (request.type === 'mark') {
          this.clock += 1000;
          this.count += 1;
          this.emit(
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'ack',
                requestId: request.requestId,
                sessionId: request.sessionId,
                runId: 'runtime-one',
                segment: request.segment,
                boundary: request.boundary,
                snapshot: { pid: 42, cpuMs: this.clock / 10, monotonicMs: this.clock },
                counters: { renders: this.resetCounter ? 0 : this.count },
              }),
            ),
          );
        }
        callback?.();
      }
      close() {
        this.readyState = 3;
      }
    }
    const control = new ProfileControl(expected, 'app-token', 5000, 1000);
    const socket = new NativeSocket();
    const transport = control as unknown as { sockets: EventEmitter; server: EventEmitter };
    transport.sockets.emit('connection', socket, { url: '/?token=app-token' });
    socket.emit('message', Buffer.from(JSON.stringify(helloCandidate())));
    const post = (boundary: 'start' | 'end') =>
      new Promise<number>((resolveStatus) => {
        const request = Object.assign(new EventEmitter(), { method: 'POST', url: '/mark' });
        let status = 0;
        const response = Object.assign(new EventEmitter(), {
          writableEnded: false,
          writeHead(code: number) {
            status = code;
          },
          end() {
            this.writableEnded = true;
            resolveStatus(status);
          },
        });
        transport.server.emit('request', request, response);
        request.emit('data', Buffer.from(JSON.stringify({ token: control.sessionToken, segment: 'climbs', boundary })));
        request.emit('end');
      });
    const marks = [
      { segment: 'climbs', boundary: 'start' as const },
      { segment: 'climbs', boundary: 'end' as const },
    ];
    control.beginCycle(marks);
    expect(await post('start')).toBe(200);
    const pendingEnd = post('end');
    await vi.advanceTimersByTimeAsync(999);
    expect(socket.count).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pendingEnd).toBe(200);
    expect(socket.count).toBe(2);
    expect(control.finishCycle().segments[0].cpu.cpuSeconds).toBe(0.1);
    control.beginCycle(marks);
    socket.resetCounter = true;
    expect(await post('start')).toBe(409);
    expect(control.failure?.message).toContain('counter');
    await control.close();
  });
  it('rejects stale native requests and retires disconnected runtimes', async () => {
    class NativeSocket extends EventEmitter {
      readyState = 1;
      send(bytes: string, callback?: (error?: Error) => void) {
        const request = JSON.parse(bytes) as Record<string, unknown>;
        if (request.type === 'mark')
          this.emit(
            'message',
            Buffer.from(
              JSON.stringify({
                ...acknowledgement('start', 1, 2),
                requestId: 'stale-request',
                sessionId: request.sessionId,
              }),
            ),
          );
        callback?.();
      }
      close() {
        this.readyState = 3;
      }
    }
    const control = new ProfileControl(expected, 'app-token');
    const socket = new NativeSocket();
    (control as unknown as { sockets: EventEmitter }).sockets.emit('connection', socket, { url: '/?token=app-token' });
    socket.emit('message', Buffer.from(JSON.stringify(helloCandidate())));
    await expect(control.mark({ segment: 'climbs', boundary: 'start' })).rejects.toThrow('Stale');
    await control.close();
    const disconnected = new ProfileControl(expected, 'app-token');
    const disconnectedSocket = new NativeSocket();
    (disconnected as unknown as { sockets: EventEmitter }).sockets.emit('connection', disconnectedSocket, {
      url: '/?token=app-token',
    });
    disconnectedSocket.emit('message', Buffer.from(JSON.stringify(helloCandidate())));
    disconnectedSocket.emit('close');
    await expect(disconnected.mark({ segment: 'climbs', boundary: 'start' })).rejects.toThrow('disconnected');
    await disconnected.close();
  });
  it('retires timed-out requests permanently; late ACKs cannot produce success', async () => {
    vi.useFakeTimers();
    class FakeSocket extends EventEmitter {
      readyState = 1;
      sent: Record<string, unknown>[] = [];
      send(bytes: string, callback?: (error?: Error) => void) {
        this.sent.push(JSON.parse(bytes) as Record<string, unknown>);
        callback?.();
      }
      close() {
        this.readyState = 3;
      }
    }
    const control = new ProfileControl(expected, 'app-token', 50);
    const socket = new FakeSocket();
    const transport = control as unknown as { sockets: EventEmitter };
    transport.sockets.emit('connection', socket, { url: '/?token=app-token' });
    socket.emit('message', Buffer.from(JSON.stringify(helloCandidate())));
    const pending = control.mark({ segment: 'climbs', boundary: 'start' });
    const rejected = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(51);
    await rejected;
    const request = socket.sent.at(-1)!;
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          ...acknowledgement('start', 1, 2),
          requestId: request.requestId,
          sessionId: request.sessionId,
        }),
      ),
    );
    expect(control.failure?.message).toContain('timed out');
    await expect(control.mark({ segment: 'climbs', boundary: 'end' })).rejects.toThrow('timed out');
    await control.close();
  });
});

function fixtures(directory: string): void {
  const privacy = {
    operationName: 'PrivacyChanged',
    documentHash: 'privacy-doc',
    variablesHash: 'privacy-vars',
    status: 200,
    query: 'subscription PrivacyChanged { privacyChanged }',
    response: { data: { privacyChanged: true } },
  };
  const deletions = {
    operationName: 'SyncDeletions',
    documentHash: 'deletions-doc',
    variablesHash: 'deletions-vars',
    status: 200,
    response: {
      data: { syncDeletions: { deletions: [], hasMore: false, cursor: { updatedAt: '2026-01-01', syncSeq: '0' } } },
    },
  };
  writeFileSync(join(directory, 'privacy.json'), JSON.stringify(privacy));
  writeFileSync(join(directory, 'deletions.json'), JSON.stringify(deletions));
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({
      accountEmail: 'fixture@example.invalid',
      frozenNow: '2026-10-09T00:00:00Z',
      graphql: [
        { ...privacy, file: 'privacy.json' },
        { ...deletions, file: 'deletions.json' },
      ],
    }),
  );
}

describe('mobile profile preparation and workload eligibility', () => {
  it('requires production initial privacy signal and explicit deletion fixture', () => {
    const directory = temporaryDirectory();
    fixtures(directory);
    expect(validateProfileFixtures(directory)).toMatch(/^[a-f0-9]{64}$/);
    const privacy = JSON.parse(readFileSync(join(directory, 'privacy.json'), 'utf8')) as {
      response: { data: { privacyChanged: boolean } };
    };
    privacy.response.data.privacyChanged = false;
    writeFileSync(join(directory, 'privacy.json'), JSON.stringify(privacy));
    expect(() => validateProfileFixtures(directory)).toThrow('initial true');
  });
  it('evaluates injected config through plain Node Expo loader, isolates native identity, and disables OTA', () => {
    const checkout = temporaryDirectory(),
      mobile = join(checkout, 'packages/mobile');
    mkdirSync(join(mobile, 'plugins'), { recursive: true });
    mkdirSync(join(mobile, 'app'));
    mkdirSync(join(mobile, 'modules/live-activity/ios'), { recursive: true });
    symlinkSync(join(ROOT, 'packages/mobile/node_modules'), join(mobile, 'node_modules'), 'dir');
    writeFileSync(
      join(mobile, 'package.json'),
      JSON.stringify({
        ...JSON.parse(readFileSync(join(ROOT, 'packages/mobile/package.json'), 'utf8')),
        name: 'profile-config-test',
        version: '1.0.0',
        expo: {
          autolinking: {
            buildFromSource: ['expo-observe', 'expo-app-metrics', '@expo/ui'],
            android: { exclude: ['custom-module'] },
          },
        },
      }),
    );
    writeFileSync(
      join(mobile, 'app.config.ts'),
      `export default () => ({name:'Boardsesh',slug:'boardsesh',ios:{bundleIdentifier:'com.boardsesh.app',entitlements:{'com.apple.security.application-groups':['group.com.boardsesh.app']}},android:{package:'com.boardsesh.app'},plugins:[],extra:{eas:{projectId:'project',observe:{endpointUrl:'https://o.expo.dev'}}}});`,
    );
    writeFileSync(
      join(mobile, 'app/_layout.tsx'),
      "import { ObserveRoot } from 'expo-observe';\nexport default function Layout() { return null; }",
    );
    writeFileSync(
      join(mobile, 'modules/live-activity/ios/SharedConstants.swift'),
      'let group="group.com.boardsesh.app"; let signal="com.boardsesh.app.queueNavigate"',
    );
    injectProfileTemplates(checkout);
    // The Gradle expo-constants config task invokes plain node, not a TS import loader.
    const mobileRequire = createRequire(join(ROOT, 'packages/mobile/package.json'));
    const expoRequire = createRequire(mobileRequire.resolve('expo/package.json'));
    const configLoader = expoRequire('@expo/config') as {
      getConfig(path: string): {
        exp: {
          ios: { bundleIdentifier: string };
          android: { package: string };
          scheme: string;
          updates: { enabled: boolean };
          extra: { eas: { projectId: string; observe: { endpointUrl?: string } } };
        };
      };
    };
    const previousBackend = process.env.EXPO_PUBLIC_BACKEND_URL;
    process.env.EXPO_PUBLIC_BACKEND_URL = 'http://127.0.0.1:8198';
    const config = configLoader.getConfig(mobile).exp;
    if (previousBackend === undefined) delete process.env.EXPO_PUBLIC_BACKEND_URL;
    else process.env.EXPO_PUBLIC_BACKEND_URL = previousBackend;
    expect(config.ios.bundleIdentifier).toBe('com.boardsesh.app.perf');
    expect(config.android.package).toBe('com.boardsesh.app.perf');
    expect(config.scheme).toBe('boardsesh-perf');
    expect(config.updates.enabled).toBe(false);
    expect(config.extra.eas.projectId).toBe('project');
    expect(config.extra.eas.observe.endpointUrl).toBe('http://127.0.0.1:8198');
    const isolationProof = validateProfileAutolinking(checkout);
    expect(isolationProof.platforms.map((proof) => proof.platform)).toEqual(['apple', 'android']);
    expect(isolationProof.platforms.every((proof) => proof.nativeTelemetryModulesAbsent)).toBe(true);
    const injectedPackage = JSON.parse(readFileSync(join(mobile, 'package.json'), 'utf8'));
    expect(injectedPackage.expo.autolinking.buildFromSource).toEqual(['@expo/ui']);
    expect(injectedPackage.expo.autolinking.android.exclude).toEqual([
      'custom-module',
      'expo-observe',
      'expo-app-metrics',
    ]);
    expect(readFileSync(join(mobile, 'src/lib/observe-bootstrap.ts'), 'utf8')).toContain('setObserveRuntime(null)');
    expect(readFileSync(join(mobile, 'app/_layout.tsx'), 'utf8')).not.toContain("from 'expo-observe'");
    const plugin = createRequire(join(mobile, 'plugins/with-mobile-profile.cjs'))('./with-mobile-profile.cjs') as (
      configuration: object,
    ) => object;
    expect(() => plugin(config)).not.toThrow();
    expect(readFileSync(join(mobile, 'modules/live-activity/ios/SharedConstants.swift'), 'utf8')).toContain(
      'com.boardsesh.app.perf.queueNavigate',
    );
    expect(templateHash()).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects injection into this execution checkout before changing any app source', async () => {
    const directory = temporaryDirectory();
    const fixtureDirectory = join(directory, 'fixtures');
    mkdirSync(fixtureDirectory);
    fixtures(fixtureDirectory);
    const options = parseMobileProfileArgs([
      'prepare',
      '--source-ref',
      'HEAD',
      '--platform',
      'ios',
      '--device',
      '00008110-000229023460201E',
      '--fixtures',
      fixtureDirectory,
      '--run-dir',
      directory,
      '--checkout',
      ROOT,
      '--backend-url',
      'http://127.0.0.1:8198',
      '--control-url',
      'ws://127.0.0.1:8199',
    ]);
    const before = readFileSync(join(ROOT, 'packages/mobile/app.config.ts'), 'utf8');
    await expect(prepareProfile(options, ROOT)).rejects.toThrow('Refusing');
    expect(readFileSync(join(ROOT, 'packages/mobile/app.config.ts'), 'utf8')).toBe(before);
  });
  it('allows only local endpoint addresses and physical identifiers', () => {
    expect(privateAddress('192.168.1.10')).toBe(true);
    expect(privateAddress('172.31.1.1')).toBe(true);
    expect(privateAddress('172.32.1.1')).toBe(false);
    expect(privateAddress('8.8.8.8')).toBe(false);
  });
  it('rejects included destructive commands and conditional marks while preserving explicit native boundaries', () => {
    const directory = temporaryDirectory(),
      flow = join(directory, 'flow.yaml');
    const mark = resolve(ROOT, 'scripts/fixtures/mobile-profile/mark.js');
    const header = 'appId: com.boardsesh.app.perf\n---\n';
    writeFileSync(
      flow,
      header +
        `- runScript:\n    file: ${mark}\n    env: { SEGMENT: climbs, BOUNDARY: start }\n- assertVisible: {id: climb-row}\n- runScript:\n    file: ${mark}\n    env: { SEGMENT: climbs, BOUNDARY: end }\n`,
    );
    expect(validateProfileFlow(flow).marks).toHaveLength(2);
    writeFileSync(join(directory, 'include.yaml'), header + '- clearState: true\n');
    writeFileSync(flow, header + '- runFlow: include.yaml\n');
    expect(() => validateProfileFlow(flow)).toThrow('clearState');
    writeFileSync(
      flow,
      header +
        `- runFlow:\n    when: {visible: Home}\n    commands:\n      - runScript:\n          file: ${mark}\n          env: {SEGMENT: climbs, BOUNDARY: start}\n`,
    );
    expect(() => validateProfileFlow(flow)).toThrow('unconditional');
    writeFileSync(flow, header + '- openLink: {link: "com.boardsesh.app://home"}\n');
    expect(() => validateProfileFlow(flow)).toThrow('isolated');
  });
  it('baselines old fixture misses but rejects new misses and wrong loaded manifest', () => {
    const before = validateBackendProof(
      {
        mode: 'replay',
        processInstanceId: 'backend-one',
        fixtureManifestSHA256: 'manifest',
        hits: 9,
        misses: 1,
        recorded: 0,
        redacted: 0,
      },
      'manifest',
    );
    expect(() => validateBackendDelta(before, { ...before, hits: 20 })).not.toThrow();
    expect(() => validateBackendDelta(before, { ...before, hits: 20, misses: 2 })).toThrow('misses');
    expect(() => validateBackendDelta(before, { ...before, processInstanceId: 'backend-two', hits: 20 })).toThrow(
      'restarted',
    );
    expect(() => validateBackendProof({ ...before, fixtureManifestSHA256: 'old' }, 'manifest')).toThrow('exact');
  });
});
