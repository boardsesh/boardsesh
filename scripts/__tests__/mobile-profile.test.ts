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
import { validateBackendDelta, validateBackendProof, validateProfileFlow } from '../lib/mobile-profile-harness';
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
