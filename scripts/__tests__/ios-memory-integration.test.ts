/// <reference types="node" />
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryCollector, parseMemoryCommand } from '../../packages/mobile/src/lib/profiling/memory-collector';
import { validateOwnershipMeasurements, type MemoryManifest, type MemoryWorkload } from '../lib/ios-memory-profile';

const simulation = vi.hoisted(() => ({
  collector: null as ReturnType<typeof createMemoryCollector> | null,
  directory: '',
  clock: 0,
  pid: 100,
  running: false,
  launches: 0,
  workload: 'replay' as MemoryWorkload,
  wrongTarget: false,
  wrongAngle: false,
  sampleCommands: 0,
  usableGraphs: true,
  drift: 'none' as 'none' | 'runtime' | 'process',
  processReplaced: false,
  graphPids: [] as number[],
  graphDirectories: [] as string[],
  flowTimeouts: [] as number[],
  maestroFailure: null as { status: number | null; signal: string | null; errorCode: string } | null,
  calls: [] as { pid: number; action: string; phase: string; cycle: number }[],
  readSnapshot: null as (() => string) | null,
  swipe: null as ((filename: string) => void) | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const filesystem = await importOriginal<typeof import('node:fs')>();
  return {
    ...filesystem,
    readFileSync: (path: string, ...args: unknown[]) => {
      if (String(path).endsWith('memory-latest.json')) return simulation.readSnapshot!();
      return Reflect.apply(filesystem.readFileSync, filesystem, [path, ...args]);
    },
  };
});
vi.mock('node:perf_hooks', () => ({ performance: { now: () => (simulation.clock += 10) } }));
vi.mock('../lib/ios-simulator-lease', () => ({ guardSimulatorCommand: vi.fn() }));
vi.mock('../lib/ios-memory-tools', () => ({
  readProcessIdentity: (pid: number) => ({
    pid,
    startedAt: simulation.processReplaced ? 'replaced-process' : `process-${pid}`,
    executable: '/owned/Boardsesh',
  }),
  captureOwnershipEvidence: vi.fn(),
  captureOwnershipCheckpoint: async (identity: { pid: number }, directory: string) => {
    simulation.graphPids.push(identity.pid);
    simulation.graphDirectories.push(directory);
    return { cleanupConfirmed: true, reports: [{ name: 'leaks', usable: simulation.usableGraphs }] };
  },
  verifyFailedAllocationProbe: () => ({
    recorderPid: 99,
    recorderAbsent: true,
    recorderGroupAbsent: true,
    allocationValid: false,
    observedAt: '2026-09-09T00:00:00.000Z',
    method: 'mocked ESRCH probe',
  }),
}));
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawnSync: (command: string, args: string[], options: { timeout: number }) => {
    if (command === 'sample') {
      simulation.sampleCommands += 1;
      writeFileSync(args[args.indexOf('-file') + 1], 'Physical footprint: 200M');
    } else if (command === 'maestro') {
      simulation.flowTimeouts.push(options.timeout);
      simulation.swipe!(args.at(-1)!);
      if (simulation.maestroFailure) {
        const { status, signal, errorCode } = simulation.maestroFailure;
        return { status, signal, error: Object.assign(new Error('spawn failed'), { code: errorCode }) };
      }
    } else throw new Error(`Unexpected command: ${command}`);
    return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  },
}));

import { captureMemory } from '../lib/ios-memory-capture';

const manifest: MemoryManifest = {
  schemaVersion: 1,
  board: { name: 'tension', layoutId: 10, sizeId: 6, setIds: [12, 13], angle: 40 },
  accountId: 'local-account',
  renderMode: 'aura',
  catalogueSha256: 'a'.repeat(64),
  climbs: Array.from({ length: 400 }, (_, index) => ({
    uuid: `climb-${index}`,
    name: `Climb ${index}`,
    layoutId: 10,
    framesSha256: 'b'.repeat(64),
  })),
};
const drained = { overlayIndexSize: 200, pendingRenders: 0, queuedRenders: 0, dispatchedRenders: 0 };

function observeList() {
  const collector = simulation.collector!;
  collector.route('(tabs)/climbs');
  collector.board({ ...manifest.board, setIds: manifest.board.setIds.join(',') });
  collector.account(manifest.accountId);
  collector.rendered('list-render', 'list-key', manifest.renderMode);
  collector.visible('list', 'list', ['climb-0']);
}
function driver() {
  return {
    terminate() {
      simulation.running = false;
    },
    launch() {
      if (!simulation.running) {
        simulation.pid += 1;
        simulation.launches += 1;
        simulation.running = true;
        simulation.collector = createMemoryCollector(true, `runtime-${simulation.pid}`, () => (simulation.clock += 10));
      }
      simulation.collector!.appState('active');
      return simulation.pid;
    },
    startup: async () => {
      simulation.collector!.board({
        ...manifest.board,
        angle: simulation.wrongAngle ? 30 : 40,
        setIds: manifest.board.setIds.join(','),
      });
      simulation.collector!.account(manifest.accountId);
      return {};
    },
    navigate(route: string) {
      if (route === 'climbs') observeList();
      else {
        simulation.collector!.route('(tabs)/home');
        simulation.collector!.visible('list', 'list', []);
        simulation.collector!.visible('carousel', 'carousel', []);
      }
    },
    simctl(args: string[]) {
      if (args[0] === 'get_app_container') return simulation.directory;
      if (args[0] === 'launch' && args[2] === 'com.apple.Preferences') {
        const collector = simulation.collector!;
        collector.appState('background');
        collector.clearCompleted(collector.clearStarted(), true);
        return '';
      }
      throw new Error(`Unexpected simulator operation: ${args.join(' ')}`);
    },
    footprint: () => 200,
  };
}

beforeEach(() => {
  simulation.directory = mkdtempSync(join(tmpdir(), 'boardsesh-memory-integration-'));
  simulation.clock = 0;
  simulation.pid = 100;
  simulation.running = false;
  simulation.launches = 0;
  simulation.calls = [];
  simulation.flowTimeouts = [];
  simulation.maestroFailure = null;
  simulation.wrongTarget = false;
  simulation.wrongAngle = false;
  simulation.sampleCommands = 0;
  simulation.usableGraphs = true;
  simulation.graphPids = [];
  simulation.graphDirectories = [];
  simulation.drift = 'none';
  simulation.processReplaced = false;
  simulation.workload = 'replay';
  writeFileSync(join(simulation.directory, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(
    join(simulation.directory, 'failed-probe.json'),
    JSON.stringify({ recorderPid: 99, status: null, timedOut: true }),
  );
  simulation.readSnapshot = () => {
    const command = parseMemoryCommand(
      JSON.parse(readFileSync(join(simulation.directory, 'Documents/boardsesh-profile/memory-command.json'), 'utf8')),
    );
    if (!command) throw new Error('Runner wrote an invalid mailbox command.');
    const collector = simulation.collector!;
    simulation.calls.push({ pid: simulation.pid, action: command.action, phase: command.phase, cycle: command.cycle });
    if (command.action === 'begin') collector.begin(command);
    if (simulation.wrongAngle)
      collector.board({ ...manifest.board, angle: 30, setIds: manifest.board.setIds.join(',') });
    if (command.action === 'scroll' || command.action === 'open') {
      if (!collector.isArmed(command)) throw new Error('Runner controls an unarmed or replaced runtime.');
      if (command.action === 'scroll') {
        collector.visible('list', 'list', [simulation.wrongTarget ? 'wrong-climb' : command.targetUuid!]);
      } else {
        collector.route('play');
        collector.visible('list', 'list', []);
        collector.visible('carousel', 'carousel', [command.targetUuid!]);
      }
    }
    const snapshot = collector.snapshot(command, drained);
    if (command.cycle === 1 && command.action === 'scroll') {
      if (simulation.drift === 'runtime') snapshot.runId = 'replaced-runtime';
      if (simulation.drift === 'process') simulation.processReplaced = true;
    }
    return JSON.stringify(snapshot);
  };
  simulation.swipe = (filename) => {
    const cycle = Number(/memory-(-?\d+)-browse/.exec(filename)?.[1]);
    const first = simulation.workload === 'expanding' && cycle > 0 ? (cycle - 1) * 20 : 0;
    for (let offset = 1; offset < 20; offset++)
      simulation.collector!.visible('carousel', 'carousel', [`climb-${first + offset}`]);
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  rmSync(simulation.directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('host runner and real diagnostic collector lifecycle', () => {
  it.each([
    ['list', undefined],
    ['carousel', undefined],
    ['carousel', 90000],
  ] as const)(
    'completes %s arming, controls, background and recovery across fresh processes',
    async (surface, memoryFlowTimeoutMs) => {
      simulation.workload = surface === 'carousel' ? 'expanding' : 'replay';
      const result = await captureMemory(
        {
          runDir: simulation.directory,
          udid: '00000000-0000-0000-0000-000000000001',
          appId: 'com.boardsesh.app',
          configuration: 'Release',
          surface,
          memoryFlowTimeoutMs,
          workload: simulation.workload,
          memoryManifest: join(simulation.directory, 'manifest.json'),
          compareCache: null,
          idleSchedule: null,
          inspection: 'none',
        },
        driver(),
      );
      expect(result.memoryFlowTimeoutMs).toBe(memoryFlowTimeoutMs ?? 60000);
      expect(JSON.parse(readFileSync(join(simulation.directory, 'memory-run-options.json'), 'utf8'))).toEqual({
        memoryFlowTimeoutMs: memoryFlowTimeoutMs ?? 60000,
      });
      if (surface === 'carousel') {
        expect(simulation.flowTimeouts).toHaveLength(42);
        expect(existsSync(join(simulation.directory, 'memory-1-browse-prewarm-result.json'))).toBe(true);
        expect(existsSync(join(simulation.directory, 'memory-1-browse-measurement-result.json'))).toBe(true);
        expect(new Set(simulation.flowTimeouts)).toEqual(new Set([memoryFlowTimeoutMs ?? 60000]));
      }
      if (!('samples' in result)) throw new Error('Expected ordinary measurement samples.');
      expect(result.samples).toHaveLength(88);
      expect(simulation.launches).toBe(2);
      expect(
        new Set(result.samples.map((sample) => sample.snapshot && (sample.snapshot as { runId: string }).runId)),
      ).toEqual(new Set(['runtime-102']));
      expect(result.samples.filter((sample) => sample.phase === 'background')).toHaveLength(22);
      expect(result.samples.filter((sample) => sample.phase === 'home')).toHaveLength(22);
      expect(simulation.calls.some((call) => call.action === 'scroll')).toBe(true);
      expect(simulation.calls.some((call) => call.action === 'open')).toBe(surface === 'carousel');
    },
  );
  it.each([
    { status: null, signal: 'SIGTERM', errorCode: 'ETIMEDOUT' },
    { status: 0, signal: null, errorCode: 'ETIMEDOUT' },
    { status: 0, signal: null, errorCode: 'ENOBUFS' },
  ])('rejects a prewarm with spawn error $errorCode even at exit status $status', async (failure) => {
    simulation.maestroFailure = failure;
    await expect(
      captureMemory(
        {
          runDir: simulation.directory,
          udid: '00000000-0000-0000-0000-000000000001',
          appId: 'com.boardsesh.app',
          configuration: 'Release',
          surface: 'carousel',
          workload: 'replay',
          memoryManifest: join(simulation.directory, 'manifest.json'),
          compareCache: null,
          idleSchedule: null,
          inspection: 'none',
          memoryFlowTimeoutMs: 90000,
        },
        driver(),
      ),
    ).rejects.toThrow(/90000 ms/);
    expect(
      JSON.parse(readFileSync(join(simulation.directory, 'memory-1-browse-prewarm-result.json'), 'utf8')),
    ).toMatchObject({
      timeoutMs: 90000,
      status: failure.status,
      signal: failure.signal,
      errorCode: failure.errorCode,
      timedOut: failure.errorCode === 'ETIMEDOUT',
      durationMs: expect.any(Number),
    });
    expect(simulation.flowTimeouts).toEqual([90000]);
    expect(simulation.sampleCommands).toBe(0);
    expect(simulation.launches).toBe(1);
    expect(JSON.parse(readFileSync(join(simulation.directory, 'memory-samples.json'), 'utf8'))).toEqual([]);
    expect(existsSync(join(simulation.directory, 'ordinary-measurements.json'))).toBe(false);
  });
  it('rejects a UUID-mismatched recycled viewport before accepting a capture', async () => {
    simulation.wrongTarget = true;
    await expect(
      captureMemory(
        {
          runDir: simulation.directory,
          udid: '00000000-0000-0000-0000-000000000001',
          appId: 'com.boardsesh.app',
          configuration: 'Release',
          surface: 'list',
          workload: 'replay',
          memoryManifest: join(simulation.directory, 'manifest.json'),
          compareCache: null,
          idleSchedule: null,
          inspection: 'none',
        },
        driver(),
      ),
    ).rejects.toThrow(/snapshot/i);
  });
  it('rejects a different actual board angle despite all expected UUIDs being present', async () => {
    simulation.wrongAngle = true;
    await expect(
      captureMemory(
        {
          runDir: simulation.directory,
          udid: '00000000-0000-0000-0000-000000000001',
          appId: 'com.boardsesh.app',
          configuration: 'Release',
          surface: 'list',
          workload: 'replay',
          memoryManifest: join(simulation.directory, 'manifest.json'),
          compareCache: null,
          idleSchedule: null,
          inspection: 'none',
        },
        driver(),
      ),
    ).rejects.toThrow(/configuration\/account/);
  });
  it.each(['empty', 'matching', 'mismatch', 'additional mismatch'] as const)(
    'validates the idle reference cache automatically: %s',
    async (cacheCase) => {
      const cacheDirectory = join(simulation.directory, 'Library/Caches/board-thumbnails');
      if (cacheCase !== 'empty') {
        mkdirSync(cacheDirectory, { recursive: true });
        writeFileSync(join(cacheDirectory, 'board.png'), 'original cached image');
      }
      const options = {
        runDir: simulation.directory,
        udid: '00000000-0000-0000-0000-000000000001',
        appId: 'com.boardsesh.app',
        configuration: 'Release' as const,
        surface: 'list' as const,
        workload: 'replay' as const,
        memoryManifest: join(simulation.directory, 'manifest.json'),
        compareCache: null,
        idleSchedule: null,
        inspection: 'none' as const,
      };
      const reference = await captureMemory(options, driver());
      if (!('samples' in reference)) throw new Error('Expected ordinary reference samples.');
      const referencePath = join(simulation.directory, 'reference.json');
      const { memoryFlowTimeoutMs: _legacyTimeout, ...legacyReference } = reference;
      if (cacheCase === 'empty') {
        for (const inventories of [
          undefined,
          null,
          [],
          [{ cycle: 20, files: [] }],
          [
            { cycle: 0, files: [] },
            { cycle: 0, files: [] },
          ],
          [{ cycle: 0, files: 'malformed' }],
          [{ cycle: 0, files: [{ path: 'board.png', bytes: 1, sha256: 'not-a-hash' }] }],
        ]) {
          writeFileSync(referencePath, JSON.stringify({ ...legacyReference, inventories }));
          await expect(
            captureMemory({ ...options, workload: 'idle', idleSchedule: referencePath }, driver()),
          ).rejects.toThrow(/cache.*inventory/);
          expect(simulation.launches).toBe(2);
        }
      }
      writeFileSync(referencePath, JSON.stringify(legacyReference));
      await expect(
        captureMemory(
          { ...options, workload: 'idle', idleSchedule: referencePath, memoryFlowTimeoutMs: 90000 },
          driver(),
        ),
      ).rejects.toThrow(/same --memory-flow-timeout-ms/);
      expect(simulation.launches).toBe(2);
      if (cacheCase === 'mismatch') writeFileSync(join(cacheDirectory, 'board.png'), 'changed cached image');
      const additionalCachePath = join(simulation.directory, 'additional-cache.json');
      if (cacheCase === 'additional mismatch') writeFileSync(additionalCachePath, JSON.stringify([]));
      vi.useFakeTimers();
      const pending = captureMemory(
        {
          ...options,
          workload: 'idle',
          idleSchedule: referencePath,
          compareCache: cacheCase === 'additional mismatch' ? additionalCachePath : null,
        },
        driver(),
      );
      if (cacheCase === 'mismatch' || cacheCase === 'additional mismatch') {
        const rejection = expect(pending).rejects.toThrow(/cache files differ/);
        await vi.runAllTimersAsync();
        await rejection;
        const partial = JSON.parse(readFileSync(join(simulation.directory, 'memory-samples.json'), 'utf8')) as {
          cycle: number;
        }[];
        expect(partial).toHaveLength(8);
        expect(partial.every((sample) => sample.cycle <= 0)).toBe(true);
        expect(
          JSON.parse(readFileSync(join(simulation.directory, 'ordinary-measurements.json'), 'utf8')),
        ).toMatchObject({ workload: 'replay' });
        return;
      }
      await vi.runAllTimersAsync();
      const idle = await pending;
      if (!('samples' in idle)) throw new Error('Expected ordinary idle samples.');
      expect(simulation.launches).toBe(4);
      expect(idle.samples).toHaveLength(88);
      for (const [index, sample] of idle.samples.entries()) {
        expect(Math.abs(sample.hostElapsedMs - reference.samples[index].hostElapsedMs)).toBeLessThanOrEqual(2000);
        expect((sample.snapshot as { actualVisibleUuids: string[] }).actualVisibleUuids).toEqual([]);
      }
    },
  );
});

function ownershipOptions() {
  return {
    runDir: simulation.directory,
    udid: '00000000-0000-0000-0000-000000000001',
    appId: 'com.boardsesh.app',
    configuration: 'Release' as const,
    surface: 'list' as const,
    workload: 'replay' as const,
    memoryManifest: join(simulation.directory, 'manifest.json'),
    compareCache: null,
    idleSchedule: null,
    inspection: 'graphs' as const,
    inspectionOnly: true,
    failedAllocationProbe: join(simulation.directory, 'failed-probe.json'),
  };
}

describe('standalone survivor-graph investigation', () => {
  it('records 88 checkpoints and two graphs in one fresh process without ordinary samples', async () => {
    const result = await captureMemory(ownershipOptions(), driver());
    if (!('observations' in result)) throw new Error('Expected separate ownership observations.');
    expect(result.scenario).toBe('ownership');
    expect(result.memoryFlowTimeoutMs).toBe(60000);
    expect(() => validateOwnershipMeasurements({ ...result, memoryFlowTimeoutMs: 120001 })).toThrow(
      /memory-flow-timeout-ms/,
    );
    expect(result.observations).toHaveLength(88);
    expect(result.workloadCompleted).toBe(true);
    expect(result.graphComparisonAvailable).toBe(true);
    expect(simulation.launches).toBe(1);
    expect(simulation.graphPids).toEqual([101, 101]);
    expect(simulation.graphDirectories.map((directory) => directory.split('/').at(-1))).toEqual(['home-0', 'home-20']);
    expect(simulation.sampleCommands).toBe(0);
    expect(result).not.toHaveProperty('samples');
    expect(existsSync(join(simulation.directory, 'memory-samples.json'))).toBe(false);
    expect(existsSync(join(simulation.directory, 'ordinary-measurements.json'))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(simulation.directory, 'ownership/capture-validity.json'), 'utf8')),
    ).toMatchObject({ valid: true, completed: true, scenario: 'ownership', graphComparisonAvailable: true });
  });
  it('rejects unavailable graphs while preserving a separately completed browsing workload', async () => {
    simulation.usableGraphs = false;
    await expect(captureMemory(ownershipOptions(), driver())).rejects.toThrow(/graph/i);
    expect(
      JSON.parse(readFileSync(join(simulation.directory, 'ownership/capture-validity.json'), 'utf8')),
    ).toMatchObject({ valid: false, completed: false, workloadCompleted: true, graphComparisonAvailable: false });
    expect(JSON.parse(readFileSync(join(simulation.directory, 'ownership/observations.json'), 'utf8'))).toHaveLength(
      88,
    );
    expect(simulation.sampleCommands).toBe(0);
  });
  it.each(['runtime', 'process'] as const)(
    'rejects %s replacement during the measured graph workload',
    async (drift) => {
      simulation.drift = drift;
      await expect(captureMemory(ownershipOptions(), driver())).rejects.toThrow(/snapshot|replaced/i);
      expect(
        JSON.parse(readFileSync(join(simulation.directory, 'ownership/capture-validity.json'), 'utf8')),
      ).toMatchObject({ valid: false, completed: false, workloadCompleted: false });
      expect(simulation.graphPids).toEqual([101]);
      expect(simulation.sampleCommands).toBe(0);
    },
  );
  it('rejects an unobserved target without falsely completing an ownership capture', async () => {
    simulation.wrongTarget = true;
    await expect(captureMemory(ownershipOptions(), driver())).rejects.toThrow(/snapshot/i);
    expect(
      JSON.parse(readFileSync(join(simulation.directory, 'ownership/capture-validity.json'), 'utf8')),
    ).toMatchObject({ valid: false, completed: false, workloadCompleted: false });
    expect(simulation.graphPids).toEqual([]);
  });
});
