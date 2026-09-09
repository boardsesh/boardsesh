import { describe, expect, it } from 'vitest';
import { parseProfileArgs } from '../mobile-profile-ios';
import { validateCaptureFiles } from '../lib/ios-profile-identity';
import {
  assertMatchingCacheFiles,
  assertSameProcess,
  assertVisitedUuids,
  expectedCycleUuids,
  MEMORY_PHASES,
  parseMemoryFlowTimeoutMs,
  validateMemoryManifest,
  validateMemoryMeasurements,
  validateMemorySnapshot,
  type MemoryManifest,
} from '../lib/ios-memory-profile';

const manifest: MemoryManifest = {
  schemaVersion: 1,
  board: { name: 'tension', layoutId: 10, sizeId: 6, setIds: [12, 13], angle: 40 },
  accountId: 'local-test-account',
  renderMode: 'classic',
  catalogueSha256: 'a'.repeat(64),
  climbs: Array.from({ length: 400 }, (_, index) => ({
    uuid: `climb-${index}`,
    name: `Climb ${index}`,
    layoutId: 10,
    framesSha256: 'b'.repeat(64),
  })),
};
const processIdentity = {
  pid: 123,
  startedAt: 'Wed Sep 09 12:00:00 2026',
  executable: '/owned/Boardsesh.app/Boardsesh',
};
function snapshot(index = 0) {
  const cycle = Math.floor(index / 4) - 1;
  const phase = MEMORY_PHASES[index % 4];
  const generation = Math.floor(index / 4) + 1;
  return {
    schemaVersion: 1,
    runId: 'runtime-one',
    commandId: `command-${index}`,
    sequence: index + 1,
    cycle,
    surface: 'list',
    phase,
    timestampMs: index + 1,
    actualVisibleUuids: expectedCycleUuids(manifest, 'expanding', cycle),
    board: { ...manifest.board, setIds: '12,13' },
    accountId: manifest.accountId,
    renderModes: [manifest.renderMode],
    route: phase === 'home' ? '(tabs)/home' : '(tabs)/climbs',
    incidentalUuids: ['incidental-outside-manifest'],
    renderKeys: ['render-key-is-not-a-uuid'],
    mountedImageSurfaces: 3,
    mountedImages: 6,
    overlayIndexSize: 400,
    pendingRenders: 0,
    queuedRenders: 0,
    dispatchedRenders: 0,
    clearPending: 0,
    appState: phase === 'background' ? 'background' : 'active',
    backgroundGeneration: generation,
    clearStartedGeneration: generation,
    clearCompletedGeneration: generation,
    valid: true,
    invalidReasons: [],
  };
}
function measurements() {
  return {
    scenario: 'memory',
    configuration: 'Release',
    surface: 'list',
    workload: 'expanding',
    manifest,
    warmupCycles: 2,
    measuredCycles: 20,
    samples: Array.from({ length: 88 }, (_, index) => ({
      cycle: Math.floor(index / 4) - 1,
      phase: MEMORY_PHASES[index % 4],
      pid: 123,
      process: processIdentity,
      checkpointRequestedMs: index * 100,
      hostElapsedMs: index * 100 + 50,
      footprintMiB: 200 + index,
      snapshot: snapshot(index),
    })),
  };
}

describe('controlled memory manifest and workloads', () => {
  it('preserves existing profiling defaults and only opts memory into Release', () => {
    const args = ['--udid', '00000000-0000-0000-0000-000000000001'];
    expect(parseProfileArgs(args)).toMatchObject({
      scenario: 'default',
      configuration: 'Release',
      port: 8097,
      inspectionOnly: false,
    });
    expect(
      parseProfileArgs([...args, '--scenario', 'memory', '--surface', 'carousel', '--workload', 'expanding']),
    ).toMatchObject({ scenario: 'memory', surface: 'carousel', workload: 'expanding' });
    expect(() => parseProfileArgs([...args, '--scenario', 'memory', '--configuration', 'Debug'])).toThrow(/Release/);
    expect(() => parseProfileArgs([...args, '--scenario', 'memory', '--workload', 'idle'])).toThrow(/idle-schedule/);
  });
  it('keeps the memory flow default and accepts only bounded integer overrides', () => {
    const args = ['--udid', '00000000-0000-0000-0000-000000000001'];
    expect(parseProfileArgs(args).memoryFlowTimeoutMs).toBe(60000);
    expect(parseMemoryFlowTimeoutMs(undefined)).toBe(60000);
    for (const timeout of ['1000', '90000', '120000']) {
      expect(parseProfileArgs([...args, '--memory-flow-timeout-ms', timeout]).memoryFlowTimeoutMs).toBe(
        Number(timeout),
      );
      expect(parseMemoryFlowTimeoutMs(Number(timeout))).toBe(Number(timeout));
    }
    for (const timeout of ['', '999', '120001', '90000.5', 'NaN', 'Infinity', '9e4', '-1'])
      expect(() => parseProfileArgs([...args, '--memory-flow-timeout-ms', timeout])).toThrow();
    for (const timeout of [null, true, NaN, Infinity, 90000.5, -1])
      expect(() => parseMemoryFlowTimeoutMs(timeout)).toThrow(/memory-flow-timeout-ms/);
  });
  it('revalidates recorded timeout bounds while accepting legacy measurements', () => {
    expect(() => validateMemoryMeasurements(measurements())).not.toThrow();
    expect(() => validateMemoryMeasurements({ ...measurements(), memoryFlowTimeoutMs: 90000 })).not.toThrow();
    expect(() => validateMemoryMeasurements({ ...measurements(), memoryFlowTimeoutMs: 120001 })).toThrow(
      /memory-flow-timeout-ms/,
    );
  });
  it('requires explicit ownership mode and failed-probe provenance for graph-only capture', () => {
    const args = [
      '--udid',
      '00000000-0000-0000-0000-000000000001',
      '--scenario',
      'memory',
      '--inspection-only',
      'true',
    ];
    expect(() => parseProfileArgs(args)).toThrow(/Ownership-only/);
    expect(() => parseProfileArgs([...args, '--inspection', 'graphs'])).toThrow(/failed-allocation-probe/);
    expect(
      parseProfileArgs([...args, '--inspection', 'graphs', '--failed-allocation-probe', '/retained/probe.json']),
    ).toMatchObject({ inspectionOnly: true, inspection: 'graphs', failedAllocationProbe: '/retained/probe.json' });
  });

  it('requires exactly400 unique compatible catalogue identities and fixed configuration', () => {
    expect(validateMemoryManifest(manifest)).toEqual(manifest);
    for (const invalid of [
      null,
      { ...manifest, climbs: manifest.climbs.slice(0, 399) },
      { ...manifest, climbs: [...manifest.climbs.slice(1), manifest.climbs[1]] },
      { ...manifest, climbs: manifest.climbs.map((climb, index) => (index ? climb : { ...climb, layoutId: 11 })) },
      { ...manifest, catalogueSha256: 'unverified' },
      { ...manifest, accountId: '' },
      { ...manifest, board: { ...manifest.board, setIds: [12, 12] } },
    ])
      expect(() => validateMemoryManifest(invalid)).toThrow();
  });
  it('reuses first20 during warmup and expands to exactly400 measured targets', () => {
    expect(expectedCycleUuids(manifest, 'expanding', -1)).toEqual(expectedCycleUuids(manifest, 'expanding', 1));
    expect(expectedCycleUuids(manifest, 'replay', 20)).toEqual(expectedCycleUuids(manifest, 'replay', 1));
    const expanded = Array.from({ length: 20 }, (_, index) =>
      expectedCycleUuids(manifest, 'expanding', index + 1),
    ).flat();
    expect(new Set(expanded).size).toBe(400);
    expect(expectedCycleUuids(manifest, 'idle', 10)).toEqual([]);
  });
  it('verifies targeted UUIDs independently from incidental viewport observations', () => {
    expect(() => assertVisitedUuids(['a', 'b', 'incidental'], ['a', 'b'], true)).not.toThrow();
    expect(() => assertVisitedUuids(['a', 'incidental'], ['a', 'b'], true)).toThrow();
    expect(() => assertVisitedUuids(['render-key'], ['a'])).toThrow();
    expect(() => assertVisitedUuids(['a', 'a'], ['a'], true)).toThrow();
  });
  it('compares cache contents independently of natural LRU touches and listing order', () => {
    const first = { path: 'board-thumbnails/a.png', bytes: 10, sha256: 'a'.repeat(64), modifiedAtMs: 100 };
    const second = { path: 'board-thumbnails/b.png', bytes: 20, sha256: 'b'.repeat(64), modifiedAtMs: 200 };
    expect(() =>
      assertMatchingCacheFiles(
        [first, second],
        [
          { ...second, modifiedAtMs: 900 },
          { ...first, modifiedAtMs: 800 },
        ],
      ),
    ).not.toThrow();
    expect(() => assertMatchingCacheFiles([first], [{ ...first, sha256: 'c'.repeat(64) }])).toThrow(
      /cache files differ/,
    );
    expect(() => assertMatchingCacheFiles([first], [{ ...first, bytes: 11 }])).toThrow(/cache files differ/);
    expect(() => assertMatchingCacheFiles([first], [first, second])).toThrow(/cache files differ/);
    expect(() => assertMatchingCacheFiles([first, second], [first])).toThrow(/cache files differ/);
  });

  it('rejects changed process starttime and changed cache bytes despite identical file names', () => {
    expect(() => assertSameProcess(processIdentity, { ...processIdentity, startedAt: 'later' })).toThrow(/replaced/);
    expect(() =>
      assertMatchingCacheFiles(
        [{ path: 'same.png', bytes: 1, sha256: 'a' }],
        [{ path: 'same.png', bytes: 1, sha256: 'b' }],
      ),
    ).toThrow(/cache files differ/);
  });
});

describe('memory capture artifact validity', () => {
  it('validates complete88 checkpoints without changing legacy startup requirements', () => {
    const capture = measurements();
    expect(() => validateMemoryMeasurements(capture)).not.toThrow();
    expect(() =>
      validateCaptureFiles(capture, { valid: true, completed: true, configuration: 'Release' }),
    ).not.toThrow();
    expect(() =>
      validateCaptureFiles(
        { ...capture, scenario: 'default' },
        { valid: true, completed: true, configuration: 'Release' },
      ),
    ).toThrow(/ten launches/);
  });
  it.each(['runId', 'commandId', 'cycle', 'surface', 'phase', 'sequence', 'timestampMs'])(
    'rejects a stale or mismatched snapshot %s',
    (field) => {
      const captured = snapshot();
      const invalid = { ...captured, [field]: field === 'sequence' || field === 'timestampMs' ? 0 : 'wrong' };
      expect(() =>
        validateMemorySnapshot(invalid, {
          runId: captured.runId,
          commandId: captured.commandId,
          cycle: captured.cycle,
          surface: 'list',
          phase: captured.phase,
          previousSequence: 0,
          previousTimestamp: 0,
        }),
      ).toThrow();
    },
  );
  it.each(['pendingRenders', 'queuedRenders', 'dispatchedRenders', 'clearPending'])(
    'rejects outstanding %s even when exporter claims validity',
    (field) => {
      const captured = measurements();
      Object.assign(captured.samples[0].snapshot, { [field]: 1 });
      expect(() => validateMemoryMeasurements(captured)).toThrow(/outstanding/);
    },
  );
  it('rejects background without completed cache clear and incomplete captures', () => {
    const captured = measurements();
    captured.samples[2].snapshot.clearCompletedGeneration = 0;
    expect(() => validateMemoryMeasurements(captured)).toThrow(/Background/);
    expect(() => validateMemoryMeasurements({ ...measurements(), samples: [] })).toThrow(/Incomplete/);
  });
  it('rejects recycled export IDs, replaced processes, missing observations and overflow', () => {
    const recycled = measurements();
    recycled.samples[1].snapshot.commandId = recycled.samples[0].snapshot.commandId;
    expect(() => validateMemoryMeasurements(recycled)).toThrow(/Reused/);
    const replaced = measurements();
    replaced.samples[1].process = { ...processIdentity, startedAt: 'later' };
    expect(() => validateMemoryMeasurements(replaced)).toThrow(/replaced/);
    const missing = measurements();
    missing.samples[1].snapshot.actualVisibleUuids = [];
    expect(() => validateMemoryMeasurements(missing)).toThrow(/visible/);
    const overflowing = measurements();
    overflowing.samples[0].snapshot.renderKeys = Array(4097).fill('render-key');
    expect(() => validateMemoryMeasurements(overflowing)).toThrow(/overflowing/);
  });
});
