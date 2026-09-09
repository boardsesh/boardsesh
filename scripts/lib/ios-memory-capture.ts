/// <reference types="node" />
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { guardSimulatorCommand } from './ios-simulator-lease';
import { fileSha256 } from './ios-profile-identity';
import {
  assertMatchingCacheFiles,
  assertMemoryEnvironment,
  assertSameProcess,
  assertVisitedUuids,
  cacheFileIdentities,
  expectedCycleUuids,
  MEMORY_PHASES,
  memoryDistribution,
  parseMemoryFlowTimeoutMs,
  record,
  startingCacheFiles,
  validateMemoryManifest,
  validateMemoryMeasurements,
  validateOwnershipMeasurements,
  usableSurvivorGraph,
  validateMemorySnapshot,
  type MemoryManifest,
  type MemoryPhase,
  type MemorySample,
  type MemorySurface,
  type MemoryWorkload,
} from './ios-memory-profile';
import {
  captureOwnershipEvidence,
  captureOwnershipCheckpoint,
  readProcessIdentity,
  verifyFailedAllocationProbe,
} from './ios-memory-tools';

export interface MemoryCaptureOptions {
  runDir: string;
  udid: string;
  appId: string;
  configuration: 'Debug' | 'Release';
  surface: MemorySurface;
  workload: MemoryWorkload;
  memoryManifest: string;
  memoryFlowTimeoutMs?: number;
  compareCache: string | null;
  idleSchedule: string | null;
  inspection: 'none' | 'ownership' | 'graphs';
  inspectionOnly?: boolean;
  failedAllocationProbe?: string | null;
}
interface MemoryCaptureDriver {
  simctl(args: string[]): string;
  launch(): number;
  terminate(): void;
  navigate(route: string): void;
  startup(): Promise<unknown>;
  footprint(report: string): number | null;
}
const pause = (milliseconds: number) => new Promise<void>((resolvePause) => setTimeout(resolvePause, milliseconds));
const save = (directory: string, filename: string, artifact: unknown) =>
  writeFileSync(join(directory, filename), JSON.stringify(artifact, null, 2));
const escapeRegex = (label: string) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Normal production route, rows, gestures, suggestion queue and renderer. UUID exports verify the text selectors. */
export function memoryCarouselFlow(
  appId: string,
  manifest: MemoryManifest,
  workload: MemoryWorkload,
  cycle: number,
): string {
  const uuids = expectedCycleUuids(manifest, workload, cycle);
  const climbs = uuids.map((uuid) => manifest.climbs.find((climb) => climb.uuid === uuid)!);
  return (
    `appId: ${JSON.stringify(appId)}\n---\n` +
    climbs
      .slice(1)
      .map(
        (climb) =>
          '- swipe:\n    start: 85%,40%\n    end: 15%,40%\n    duration: 450\n- waitForAnimationToEnd\n' +
          `- extendedWaitUntil:\n    visible:\n      text: ${JSON.stringify('.*' + escapeRegex(climb.name) + '.*')}\n    timeout: 10000\n`,
      )
      .join('')
  );
}

function runFlow(options: MemoryCaptureOptions, filename: string, content: string, timeout: number) {
  const path = join(options.runDir, filename + '.yaml');
  writeFileSync(path, content);
  const args = ['--device', options.udid, 'test', path];
  guardSimulatorCommand('maestro', args, process.cwd());
  const startedAt = performance.now();
  const result = spawnSync('maestro', args, { timeout, stdio: 'pipe' });
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code ?? null;
  save(options.runDir, filename + '-result.json', {
    timeoutMs: timeout,
    status: result.status,
    signal: result.signal ?? null,
    errorCode,
    timedOut: errorCode === 'ETIMEDOUT',
    durationMs: performance.now() - startedAt,
  });
  writeFileSync(
    join(options.runDir, filename + '.log'),
    Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]),
  );
  if (result.error || result.status !== 0)
    throw new Error(`Memory workload flow ${filename} failed or timed out (limit ${timeout} ms).`);
}

export async function captureMemory(options: MemoryCaptureOptions, driver: MemoryCaptureDriver) {
  const memoryFlowTimeoutMs = parseMemoryFlowTimeoutMs(options.memoryFlowTimeoutMs);
  const inspectionOnly = options.inspectionOnly === true;
  if (inspectionOnly && (options.inspection === 'none' || options.workload === 'idle'))
    throw new Error('Ownership-only capture requires replay/expanding with --inspection ownership or graphs.');
  const verifyPriorProbe = () => {
    if (options.inspection !== 'graphs') return null;
    if (!options.failedAllocationProbe) throw new Error('Graph fallback requires --failed-allocation-probe.');
    const priorProbe: unknown = JSON.parse(readFileSync(options.failedAllocationProbe, 'utf8'));
    return {
      path: options.failedAllocationProbe,
      sha256: fileSha256(options.failedAllocationProbe),
      cleanup: verifyFailedAllocationProbe(priorProbe, options.udid),
      recordedProbe: priorProbe,
    };
  };
  const priorProbe = verifyPriorProbe();
  if (options.configuration !== 'Release') throw new Error('Controlled memory scenarios require Release.');
  const manifest = validateMemoryManifest(JSON.parse(readFileSync(options.memoryManifest, 'utf8')) as unknown);
  const frozenHash = fileSha256(options.memoryManifest);
  save(options.runDir, 'memory-manifest.json', manifest);
  save(options.runDir, 'memory-run-options.json', { memoryFlowTimeoutMs });
  let schedule: MemorySample[] | null = null;
  let referenceCacheFiles: ReturnType<typeof startingCacheFiles> | null = null;
  let warmingWorkload: MemoryWorkload = options.workload;
  if (options.workload === 'idle') {
    if (!options.idleSchedule)
      throw new Error('Idle workload requires --idle-schedule <completed-memory-measurements.json>.');
    const reference: unknown = JSON.parse(readFileSync(options.idleSchedule, 'utf8'));
    validateMemoryMeasurements(reference);
    const referenceRecord = record(reference)!;
    if (
      referenceRecord.surface !== options.surface ||
      JSON.stringify(referenceRecord.manifest) !== JSON.stringify(manifest)
    )
      throw new Error('Idle reference must use the same surface and manifest.');
    if (parseMemoryFlowTimeoutMs(referenceRecord.memoryFlowTimeoutMs) !== memoryFlowTimeoutMs)
      throw new Error('Idle reference must use the same --memory-flow-timeout-ms.');
    referenceCacheFiles = startingCacheFiles(referenceRecord.inventories);
    schedule = referenceRecord.samples as MemorySample[];
    warmingWorkload = referenceRecord.workload as MemoryWorkload;
    if (warmingWorkload === 'idle') throw new Error('Idle controls require a browsing reference.');
  }
  driver.terminate();
  let pid = driver.launch();
  await driver.startup();
  let identity = readProcessIdentity(pid);
  const container = driver.simctl(['get_app_container', options.udid, options.appId, 'data']);
  const commandDirectory = join(container, 'Documents', 'boardsesh-profile');
  mkdirSync(commandDirectory, { recursive: true });
  const hostRunId = randomUUID();
  let runtimeId: string | undefined;
  let previousSequence = -1;
  let previousTimestamp = -1;
  const assertOwned = () => assertSameProcess(identity, readProcessIdentity(pid));
  const samples: MemorySample[] = [];
  let start = performance.now();
  const inventories: { cycle: number; files: ReturnType<typeof cacheFileIdentities> }[] = [];
  let commandOrdinal = 0;
  async function checkpoint(
    cycle: number,
    phase: MemoryPhase,
    action: 'begin' | 'checkpoint' | 'scroll' | 'open',
    transition?: () => void,
    targetIndex?: number,
    selectedWorkload = options.workload,
  ) {
    assertOwned();
    const commandId = `${hostRunId}:${cycle}:${phase}:${++commandOrdinal}`;
    const expectedUuids = expectedCycleUuids(manifest, selectedWorkload, cycle);
    const surface = selectedWorkload === 'idle' ? 'idle' : options.surface;
    const command = {
      schemaVersion: 1,
      commandId,
      runId: runtimeId,
      cycle,
      surface,
      phase,
      action,
      expectedUuids,
      ...(targetIndex !== undefined ? { targetIndex, targetUuid: manifest.climbs[targetIndex].uuid } : {}),
    };
    const temporary = join(commandDirectory, 'memory-command.next.json');
    writeFileSync(temporary, JSON.stringify(command));
    renameSync(temporary, join(commandDirectory, 'memory-command.json'));
    transition?.();
    const deadline = performance.now() + 35_000;
    while (performance.now() < deadline) {
      assertOwned();
      const path = join(commandDirectory, 'memory-latest.json');
      let snapshot: unknown;
      try {
        snapshot = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      } catch {
        await pause(100);
        continue;
      }
      const observed = record(snapshot);
      if (observed?.commandId !== commandId) {
        await pause(100);
        continue;
      }
      save(options.runDir, `snapshot-${cycle}-${phase}-${commandOrdinal}.json`, snapshot);
      validateMemorySnapshot(snapshot, {
        commandId,
        runId: runtimeId,
        cycle,
        surface,
        phase,
        previousSequence,
        previousTimestamp,
      });
      if (action !== 'begin') assertMemoryEnvironment(snapshot, manifest, selectedWorkload === 'idle');
      runtimeId = observed.runId as string;
      previousSequence = observed.sequence as number;
      previousTimestamp = observed.timestampMs as number;
      if (phase === 'browsed') {
        assertVisitedUuids(observed.actualVisibleUuids, expectedUuids, selectedWorkload !== 'idle');
      }
      return snapshot;
    }
    throw new Error(`Memory ${cycle}/${phase} lacks a fresh completed diagnostic export within 35 seconds.`);
  }
  async function setup(cycle: number, selectedWorkload: MemoryWorkload) {
    driver.navigate('home');
    await checkpoint(cycle, 'home', 'begin', undefined, undefined, selectedWorkload);
    if (selectedWorkload === 'idle') return;
    driver.navigate('climbs');
    const firstIndex = selectedWorkload === 'expanding' && cycle > 0 ? (cycle - 1) * 20 : 0;
    await checkpoint(cycle, 'settled', 'scroll', undefined, firstIndex, selectedWorkload);
    if (options.surface === 'carousel')
      await checkpoint(cycle, 'settled', 'open', undefined, firstIndex, selectedWorkload);
  }
  async function browse(
    cycle: number,
    selectedWorkload: MemoryWorkload,
    stage: 'prewarm' | 'measurement' | 'ownership',
  ) {
    if (selectedWorkload === 'idle') return;
    if (options.surface === 'carousel')
      runFlow(
        options,
        `memory-${cycle}-browse-${stage}`,
        memoryCarouselFlow(options.appId, manifest, selectedWorkload, cycle),
        memoryFlowTimeoutMs,
      );
    else {
      const firstIndex = selectedWorkload === 'expanding' && cycle > 0 ? (cycle - 1) * 20 : 0;
      for (let offset = 1; offset < 20; offset++)
        await checkpoint(cycle, 'settled', 'scroll', undefined, firstIndex + offset, selectedWorkload);
    }
  }
  async function runOwnershipInvestigation(restart: boolean) {
    const inspectionDirectory = join(options.runDir, 'ownership');
    mkdirSync(inspectionDirectory, { recursive: true });
    const observations: { cycle: number; phase: MemoryPhase; process: typeof identity; snapshot: unknown }[] = [];
    const graphCheckpoints: { cycle: number; evidence: unknown }[] = [];
    let workloadCompleted = false;
    try {
      if (restart) {
        driver.terminate();
        pid = driver.launch();
        await driver.startup();
        identity = readProcessIdentity(pid);
        runtimeId = undefined;
        previousSequence = -1;
        previousTimestamp = -1;
      }
      save(
        inspectionDirectory,
        'probe-provenance.json',
        priorProbe ?? { mode: 'new bounded Allocations probe at Home0' },
      );
      for (let cycle = -1; cycle <= 20; cycle++) {
        await setup(cycle, warmingWorkload);
        for (const phase of MEMORY_PHASES) {
          if (phase === 'browsed') await browse(cycle, warmingWorkload, 'ownership');
          if (phase === 'home') {
            if (driver.launch() !== pid) throw new Error('Inspection process restarted after backgrounding.');
            driver.navigate('home');
          }
          const snapshot = await checkpoint(
            cycle,
            phase,
            'checkpoint',
            phase === 'background'
              ? () => {
                  driver.simctl(['launch', options.udid, 'com.apple.Preferences']);
                }
              : undefined,
            undefined,
            warmingWorkload,
          );
          observations.push({ cycle, phase, process: identity, snapshot });
          save(inspectionDirectory, 'observations.json', observations);
        }
        if (cycle === 0 || cycle === 20) {
          const directory = join(inspectionDirectory, `home-${cycle}`);
          mkdirSync(directory, { recursive: true });
          save(directory, 'snapshot.json', observations.at(-1)?.snapshot);
          const cache = cacheFileIdentities(container);
          save(directory, 'cache.json', cache);
          if (cycle === 0 && options.compareCache)
            assertMatchingCacheFiles(JSON.parse(readFileSync(options.compareCache, 'utf8')) as typeof cache, cache);
          if (options.inspection === 'graphs') {
            const currentProof = verifyPriorProbe();
            if (currentProof?.sha256 !== priorProbe?.sha256)
              throw new Error('Prior Allocations probe changed during investigation.');
            save(directory, 'probe-provenance.json', currentProof);
          }
          const evidence =
            cycle === 0 && options.inspection === 'ownership'
              ? await captureOwnershipEvidence(identity, directory, options.udid)
              : await captureOwnershipCheckpoint(identity, directory);
          save(directory, 'summary.json', evidence);
          graphCheckpoints.push({ cycle, evidence });
          if (record(evidence)?.cleanupConfirmed !== true)
            throw new Error('Ownership recorder cleanup remains unconfirmed.');
        }
      }
      workloadCompleted = true;
      if (fileSha256(options.memoryManifest) !== frozenHash)
        throw new Error('Frozen memory manifest changed during investigation.');
      const artifact = {
        scenario: 'ownership',
        memoryFlowTimeoutMs,
        configuration: 'Release',
        surface: options.surface,
        workload: warmingWorkload,
        hostRunId,
        runtimeId,
        manifest,
        manifestSha256: frozenHash,
        warmupCycles: 2,
        measuredCycles: 20,
        process: identity,
        observations,
        graphCheckpoints,
        workloadCompleted,
        graphComparisonAvailable: graphCheckpoints.every(({ evidence }) => usableSurvivorGraph(evidence)),
        probe: priorProbe,
        inspection: options.inspection,
      };
      validateOwnershipMeasurements(artifact);
      save(inspectionDirectory, 'capture-validity.json', {
        valid: true,
        completed: true,
        workloadCompleted,
        graphComparisonAvailable: true,
        scenario: 'ownership',
        notes: 'Graphs require surviving-object/reference review; this is not a leak verdict.',
      });
      return artifact;
    } catch (error) {
      save(inspectionDirectory, 'capture-validity.json', {
        valid: false,
        completed: false,
        workloadCompleted,
        graphComparisonAvailable:
          graphCheckpoints.length === 2 && graphCheckpoints.every(({ evidence }) => usableSurvivorGraph(evidence)),
        scenario: 'ownership',
        error: String(error),
        notes: 'No ordinary footprint samples are implied by this supplemental workload.',
      });
      throw error;
    }
  }
  try {
    if (inspectionOnly) return await runOwnershipInvestigation(false);
    // Warm disk artifacts through the same production surface, in a separate process.
    // All expanding climbs are warmed; measured warm-ups still reuse the first twenty.
    for (let cycle = 1; cycle <= (warmingWorkload === 'expanding' ? 20 : 1); cycle++) {
      await setup(cycle, warmingWorkload);
      await browse(cycle, warmingWorkload, 'prewarm');
      await checkpoint(cycle, 'browsed', 'checkpoint', undefined, undefined, warmingWorkload);
    }
    save(options.runDir, 'warmed-cache.json', cacheFileIdentities(container));
    driver.terminate();
    pid = driver.launch();
    await driver.startup();
    identity = readProcessIdentity(pid);
    runtimeId = undefined;
    previousSequence = -1;
    previousTimestamp = -1;
    start = performance.now();
    for (let cycle = -1; cycle <= 20; cycle++) {
      await setup(cycle, options.workload);
      for (const phase of MEMORY_PHASES) {
        if (phase === 'browsed') await browse(cycle, options.workload, 'measurement');
        if (phase === 'home') {
          if (driver.launch() !== pid) throw new Error('App restarted after backgrounding.');
          driver.navigate('home');
        }
        if (schedule) {
          const target = schedule[samples.length].checkpointRequestedMs;
          const remaining = target - (performance.now() - start);
          if (remaining < -2000)
            throw new Error('Idle checkpoint missed its reference elapsed schedule by over two seconds.');
          while (target - (performance.now() - start) > 0)
            await pause(Math.min(500, target - (performance.now() - start)));
        }
        const checkpointRequestedMs = performance.now() - start;
        const snapshot = await checkpoint(
          cycle,
          phase,
          'checkpoint',
          phase === 'background'
            ? () => {
                driver.simctl(['launch', options.udid, 'com.apple.Preferences']);
              }
            : undefined,
        );
        const samplePath = join(options.runDir, `memory-${cycle}-${phase}.sample.txt`);
        assertOwned();
        const sampled = spawnSync('sample', [String(pid), '1', '-file', samplePath], {
          timeout: 15_000,
          stdio: 'pipe',
        });
        if (sampled.status !== 0 || !existsSync(samplePath)) throw new Error('Physical footprint sample failed.');
        const footprintMiB = driver.footprint(readFileSync(samplePath, 'utf8'));
        if (footprintMiB === null || !Number.isFinite(footprintMiB) || footprintMiB <= 0)
          throw new Error('Missing physical footprint.');
        assertOwned();
        const hostElapsedMs = performance.now() - start;
        if (schedule && Math.abs(hostElapsedMs - schedule[samples.length].hostElapsedMs) > 2000)
          throw new Error('Idle sample completion differs from reference by more than two seconds.');
        samples.push({
          cycle,
          phase,
          pid,
          process: identity,
          checkpointRequestedMs,
          hostElapsedMs,
          footprintMiB,
          snapshot,
        });
        save(options.runDir, 'memory-samples.json', samples);
        console.log(
          `[mobile:profile] memory ${options.surface}/${options.workload} ${cycle}/${phase}: ${footprintMiB} MiB`,
        );
      }
      if (cycle === 0) {
        const files = cacheFileIdentities(container);
        inventories.push({ cycle, files });
        save(options.runDir, 'starting-cache.json', files);
        if (referenceCacheFiles) assertMatchingCacheFiles(referenceCacheFiles, files);
        if (options.compareCache)
          assertMatchingCacheFiles(JSON.parse(readFileSync(options.compareCache, 'utf8')) as typeof files, files);
      }
      if (cycle === 20) inventories.push({ cycle, files: cacheFileIdentities(container) });
    }
    if (fileSha256(options.memoryManifest) !== frozenHash)
      throw new Error('Frozen memory manifest changed during capture.');
    const byPhase = Object.fromEntries(
      MEMORY_PHASES.map((phase) => [
        phase,
        memoryDistribution(
          samples.filter((sample) => sample.cycle > 0 && sample.phase === phase).map((sample) => sample.footprintMiB),
        ),
      ]),
    );
    const distinctVisible = new Set<string>();
    const distinctIncidental = new Set<string>();
    const growth = samples
      .filter((sample) => sample.cycle > 0 && sample.phase === 'browsed')
      .map((sample) => {
        const snapshot = record(sample.snapshot)!;
        for (const uuid of snapshot.actualVisibleUuids as string[]) distinctVisible.add(uuid);
        for (const uuid of snapshot.incidentalUuids as string[]) distinctIncidental.add(uuid);
        return {
          cycle: sample.cycle,
          footprintMiB: sample.footprintMiB,
          targetedDistinctClimbs:
            options.workload === 'idle' ? 0 : options.workload === 'replay' ? 20 : sample.cycle * 20,
          observedDistinctVisibleClimbs: distinctVisible.size,
          observedDistinctMountedOrPrefetchedClimbs: distinctIncidental.size,
        };
      });
    const measurements = {
      scenario: 'memory',
      memoryFlowTimeoutMs,
      configuration: 'Release',
      surface: options.surface,
      workload: options.workload,
      hostRunId,
      runtimeId,
      manifest,
      manifestSha256: frozenHash,
      warmupCycles: 2,
      measuredCycles: 20,
      samples,
      byPhase,
      growth,
      inventories,
      limitations: [
        'Simulator only; physical-device conclusions remain pending.',
        'Visible UUIDs include reported viewport overlap; renderer/prefetch keys are separate.',
        'Hash equality does not prove equal LRU order or allocator state.',
        'Ownership inspection runs separately from these samples.',
      ],
    };
    validateMemoryMeasurements(measurements);
    save(options.runDir, 'ordinary-measurements.json', measurements);
    if (options.inspection !== 'none') {
      try {
        await runOwnershipInvestigation(true);
      } catch {
        /* Supplemental verdict and partial observations are already retained. */
      }
    }

    return measurements;
  } finally {
    if (!inspectionOnly) save(options.runDir, 'memory-samples.json', samples);
  }
}
