/// <reference types="node" />
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type MemorySurface = 'list' | 'carousel';
export type MemoryWorkload = 'replay' | 'expanding' | 'idle';
export const MEMORY_PHASES = ['settled', 'browsed', 'background', 'home'] as const;
export type MemoryPhase = (typeof MEMORY_PHASES)[number];
export const MEMORY_WARMUP_CYCLES = 2;
export const MEMORY_MEASURED_CYCLES = 20;
export const MEMORY_CLIMBS_PER_CYCLE = 20;

export interface MemoryManifest {
  schemaVersion: 1;
  board: { name: 'tension'; layoutId: number; sizeId: number; setIds: number[]; angle: number };
  accountId: string;
  renderMode: string;
  catalogueSha256: string;
  climbs: { uuid: string; name: string; layoutId: number; framesSha256: string }[];
}
export function record(candidate: unknown): Record<string, unknown> | null {
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}
const positiveInteger = (candidate: unknown): candidate is number =>
  typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0;
const sha256 = (candidate: unknown): candidate is string =>
  typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate);

/** Provenance is checked against the local catalogue by the freeze step, never inferred from UUID shape. */
export function validateMemoryManifest(candidate: unknown): MemoryManifest {
  const manifest = record(candidate);
  const board = record(manifest?.board);
  if (
    manifest?.schemaVersion !== 1 ||
    board?.name !== 'tension' ||
    !positiveInteger(board.layoutId) ||
    !positiveInteger(board.sizeId) ||
    !Array.isArray(board.setIds) ||
    board.setIds.length === 0 ||
    !board.setIds.every(positiveInteger) ||
    new Set(board.setIds).size !== board.setIds.length ||
    typeof board.angle !== 'number' ||
    !Number.isFinite(board.angle) ||
    board.angle < 0 ||
    board.angle > 90 ||
    typeof manifest.accountId !== 'string' ||
    !manifest.accountId.trim() ||
    typeof manifest.renderMode !== 'string' ||
    !manifest.renderMode.trim() ||
    !sha256(manifest.catalogueSha256) ||
    !Array.isArray(manifest.climbs) ||
    manifest.climbs.length !== 400
  )
    throw new Error(
      'Memory manifest requires 400 real Tension climbs, fixed board/account/rendering, and catalogue hash.',
    );
  const uuids = new Set<string>();
  for (const candidateClimb of manifest.climbs) {
    const climb = record(candidateClimb);
    if (
      typeof climb?.uuid !== 'string' ||
      !climb.uuid.trim() ||
      climb.uuid.length > 200 ||
      typeof climb.name !== 'string' ||
      !climb.name.trim() ||
      uuids.has(climb.uuid) ||
      climb.layoutId !== board.layoutId ||
      !sha256(climb.framesSha256)
    )
      throw new Error('Memory manifest has duplicate, malformed, or incompatible climb identities.');
    uuids.add(climb.uuid);
  }
  return manifest as unknown as MemoryManifest;
}

export function expectedCycleUuids(manifest: MemoryManifest, workload: MemoryWorkload, cycle: number): string[] {
  if (!Number.isInteger(cycle) || cycle < -1 || cycle > 20) throw new Error('Invalid memory cycle.');
  if (workload === 'idle') return [];
  // Warm-ups revisit the first slice; expanding measured cycles then cover exactly 400 climbs.
  const start = workload === 'expanding' && cycle > 0 ? (cycle - 1) * MEMORY_CLIMBS_PER_CYCLE : 0;
  return manifest.climbs.slice(start, start + MEMORY_CLIMBS_PER_CYCLE).map((climb) => climb.uuid);
}

export function assertVisitedUuids(actual: unknown, expected: readonly string[], allowIncidental = false): void {
  if (
    !Array.isArray(actual) ||
    !actual.every((uuid) => typeof uuid === 'string') ||
    new Set(actual).size !== actual.length ||
    (!allowIncidental && actual.length !== expected.length) ||
    expected.some((uuid) => !actual.includes(uuid))
  )
    throw new Error('Actual visible climb UUIDs differ from the frozen workload; capture is invalid.');
}

export interface CacheFileIdentity {
  path: string;
  bytes: number;
  sha256: string;
  modifiedAtMs?: number;
}
export function cacheFileIdentities(container: string): CacheFileIdentity[] {
  const results: CacheFileIdentity[] = [];
  const root = join(container, 'Library', 'Caches');
  function inventory(relative: string, depth: number) {
    if (depth > 8 || results.length > 20000) throw new Error('Cache inventory exceeded diagnostic bounds.');
    const directory = join(root, relative);
    if (!existsSync(directory)) return;
    for (const filename of readdirSync(directory).sort()) {
      const relativePath = join(relative, filename);
      const path = join(root, relativePath);
      const metadata = statSync(path);
      if (metadata.isDirectory()) {
        inventory(relativePath, depth + 1);
        continue;
      }
      if (!metadata.isFile()) continue;
      const contents = readFileSync(path);
      results.push({
        path: relativePath,
        bytes: contents.length,
        modifiedAtMs: metadata.mtimeMs,
        sha256: createHash('sha256').update(contents).digest('hex'),
      });
    }
  }
  inventory('board-thumbnails', 0);
  inventory('com.hackemist.SDImageCache', 0);
  if (existsSync(root))
    for (const filename of readdirSync(root).sort()) {
      if (!/^ExponentAsset-.*\.(webp|png|jpe?g)$/i.test(filename)) continue;
      const path = join(root, filename);
      const metadata = statSync(path);
      if (!metadata.isFile()) continue;
      const contents = readFileSync(path);
      results.push({
        path: filename,
        bytes: contents.length,
        modifiedAtMs: metadata.mtimeMs,
        sha256: createHash('sha256').update(contents).digest('hex'),
      });
    }

  return results;
}
export function assertMatchingCacheFiles(expected: readonly CacheFileIdentity[], actual: readonly CacheFileIdentity[]) {
  // Native cache hits deliberately touch modification time for LRU. Preserve those
  // raw observations in inventories, but compare material disk contents here.
  const canonicalContents = (files: readonly CacheFileIdentity[]) =>
    files
      .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(canonicalContents(expected)) !== JSON.stringify(canonicalContents(actual)))
    throw new Error(
      'Starting board-thumbnail/image cache files differ; comparison is invalid. Preserve both cache inventories.',
    );
}

export interface ProcessIdentity {
  pid: number;
  startedAt: string;
  executable: string;
}
export function assertSameProcess(expected: ProcessIdentity, actual: ProcessIdentity): void {
  if (
    !positiveInteger(actual.pid) ||
    !actual.startedAt.trim() ||
    !actual.executable.trim() ||
    expected.pid !== actual.pid ||
    expected.startedAt !== actual.startedAt ||
    expected.executable !== actual.executable
  )
    throw new Error('App process was replaced; memory capture is invalid.');
}

export interface MemorySample {
  cycle: number;
  phase: MemoryPhase;
  pid: number;
  checkpointRequestedMs: number;
  hostElapsedMs: number;
  footprintMiB: number;
  process: ProcessIdentity;
  snapshot: unknown;
}
export function validateMemoryMeasurements(candidate: unknown): void {
  const measurements = record(candidate);
  if (
    measurements?.scenario !== 'memory' ||
    measurements.configuration !== 'Release' ||
    !['list', 'carousel'].includes(String(measurements.surface)) ||
    !['replay', 'expanding', 'idle'].includes(String(measurements.workload)) ||
    measurements.warmupCycles !== 2 ||
    measurements.measuredCycles !== 20 ||
    !Array.isArray(measurements.samples) ||
    measurements.samples.length !== 88
  )
    throw new Error('Incomplete memory capture: require two warm-ups and twenty measured four-checkpoint cycles.');
  const manifest = validateMemoryManifest(measurements.manifest);
  const workload = measurements.workload as MemoryWorkload;
  const first = record(measurements.samples[0]);
  const identity = record(first?.process);
  if (
    !identity ||
    !positiveInteger(identity.pid) ||
    typeof identity.startedAt !== 'string' ||
    typeof identity.executable !== 'string'
  )
    throw new Error('Missing process start/executable identity.');
  let previousElapsed = -1;
  let previousSequence = -1;
  let previousTimestamp = -1;
  let previousBackgroundGeneration = 0;
  const runtimeId = record(first?.snapshot)?.runId;
  if (typeof runtimeId !== 'string' || !runtimeId.trim()) throw new Error('Missing memory runtime identity.');
  const commands = new Set<string>();
  for (const [index, candidateSample] of measurements.samples.entries()) {
    const sample = record(candidateSample);
    const snapshot = record(sample?.snapshot);
    if (
      sample?.cycle !== Math.floor(index / 4) - 1 ||
      sample.phase !== MEMORY_PHASES[index % 4] ||
      sample.pid !== identity.pid ||
      typeof sample.checkpointRequestedMs !== 'number' ||
      !Number.isFinite(sample.checkpointRequestedMs) ||
      sample.checkpointRequestedMs < 0 ||
      typeof sample.hostElapsedMs !== 'number' ||
      !Number.isFinite(sample.hostElapsedMs) ||
      sample.hostElapsedMs <= previousElapsed ||
      sample.hostElapsedMs <= sample.checkpointRequestedMs ||
      typeof sample.footprintMiB !== 'number' ||
      !Number.isFinite(sample.footprintMiB) ||
      sample.footprintMiB <= 0
    )
      throw new Error('Invalid memory checkpoint or process identity.');
    assertSameProcess(identity as unknown as ProcessIdentity, sample.process as ProcessIdentity);
    validateMemorySnapshot(snapshot, {
      runId: runtimeId,
      cycle: sample.cycle as number,
      phase: sample.phase as MemoryPhase,
      surface: workload === 'idle' ? 'idle' : (measurements.surface as MemorySurface),
      previousSequence,
      previousTimestamp,
    });
    assertMemoryEnvironment(snapshot, manifest, workload === 'idle');
    const commandId = snapshot?.commandId as string;
    if (commands.has(commandId)) throw new Error('Reused memory checkpoint command.');
    commands.add(commandId);
    if (sample.phase === 'browsed')
      assertVisitedUuids(
        snapshot?.actualVisibleUuids,
        expectedCycleUuids(manifest, workload, sample.cycle as number),
        workload !== 'idle',
      );
    if (sample.phase === 'background') {
      if ((snapshot?.backgroundGeneration as number) <= previousBackgroundGeneration)
        throw new Error('Background transition was reused across cycles.');
      previousBackgroundGeneration = snapshot?.backgroundGeneration as number;
    }
    previousElapsed = sample.hostElapsedMs;
    previousSequence = snapshot?.sequence as number;
    previousTimestamp = snapshot?.timestampMs as number;
  }
}

export function validateMemorySnapshot(
  candidate: unknown,
  expected: {
    runId?: string;
    commandId?: string;
    cycle: number;
    surface: MemorySurface | 'idle';
    phase: MemoryPhase;
    previousSequence: number;
    previousTimestamp: number;
  },
): void {
  const snapshot = record(candidate);
  if (
    snapshot?.schemaVersion !== 1 ||
    snapshot.valid !== true ||
    !Array.isArray(snapshot.invalidReasons) ||
    snapshot.invalidReasons.length !== 0 ||
    typeof snapshot.runId !== 'string' ||
    !snapshot.runId.trim() ||
    (expected.runId && snapshot.runId !== expected.runId) ||
    typeof snapshot.commandId !== 'string' ||
    !snapshot.commandId.trim() ||
    (expected.commandId && snapshot.commandId !== expected.commandId) ||
    snapshot.cycle !== expected.cycle ||
    snapshot.surface !== expected.surface ||
    snapshot.phase !== expected.phase ||
    typeof snapshot.sequence !== 'number' ||
    !Number.isSafeInteger(snapshot.sequence) ||
    snapshot.sequence <= expected.previousSequence ||
    typeof snapshot.timestampMs !== 'number' ||
    !Number.isFinite(snapshot.timestampMs) ||
    snapshot.timestampMs <= expected.previousTimestamp ||
    !Array.isArray(snapshot.actualVisibleUuids) ||
    snapshot.actualVisibleUuids.length > 4096 ||
    !snapshot.actualVisibleUuids.every((uuid) => typeof uuid === 'string' && uuid.length > 0 && uuid.length <= 512) ||
    !Array.isArray(snapshot.incidentalUuids) ||
    snapshot.incidentalUuids.length > 4096 ||
    !snapshot.incidentalUuids.every((uuid) => typeof uuid === 'string' && uuid.length > 0 && uuid.length <= 512) ||
    !Array.isArray(snapshot.renderKeys) ||
    snapshot.renderKeys.length > 4096 ||
    !snapshot.renderKeys.every((key) => typeof key === 'string' && key.length <= 512)
  )
    throw new Error('Stale, incomplete, overflowing, or mismatched memory snapshot.');
  for (const counter of [
    'mountedImageSurfaces',
    'mountedImages',
    'overlayIndexSize',
    'pendingRenders',
    'queuedRenders',
    'dispatchedRenders',
    'clearPending',
    'backgroundGeneration',
  ]) {
    if (typeof snapshot[counter] !== 'number' || !Number.isSafeInteger(snapshot[counter]) || snapshot[counter] < 0)
      throw new Error(`Invalid memory counter: ${counter}.`);
  }
  if (
    snapshot.pendingRenders !== 0 ||
    snapshot.queuedRenders !== 0 ||
    snapshot.dispatchedRenders !== 0 ||
    snapshot.clearPending !== 0
  )
    throw new Error('Memory checkpoint has outstanding render or cache-clear work.');
  if (expected.phase === 'home' && !['(tabs)', '(tabs)/home'].includes(String(snapshot.route)))
    throw new Error('Settled Home route was not observed.');
  if (expected.phase === 'background') {
    if (
      snapshot.appState !== 'background' ||
      snapshot.backgroundGeneration === 0 ||
      snapshot.clearStartedGeneration !== snapshot.backgroundGeneration ||
      snapshot.clearCompletedGeneration !== snapshot.backgroundGeneration
    )
      throw new Error('Background or cache-clear completion was not observed.');
  } else if (snapshot.appState !== 'active') throw new Error('Expected a foreground memory checkpoint.');
}

/** Verify runtime observations against the frozen source, rather than trusting requested settings. */
export function assertMemoryEnvironment(candidate: unknown, manifest: MemoryManifest, idle = false): void {
  const snapshot = record(candidate);
  const board = record(snapshot?.board);
  const actualSetIds =
    typeof board?.setIds === 'string'
      ? board.setIds
          .split(',')
          .map(Number)
          .sort((left, right) => left - right)
      : null;
  if (
    !board ||
    board.name !== manifest.board.name ||
    board.layoutId !== manifest.board.layoutId ||
    board.sizeId !== manifest.board.sizeId ||
    board.angle !== manifest.board.angle ||
    JSON.stringify(actualSetIds) !== JSON.stringify([...manifest.board.setIds].sort((left, right) => left - right)) ||
    snapshot?.accountId !== manifest.accountId
  )
    throw new Error('Observed board configuration/account differs from the frozen memory manifest.');
  if (
    !Array.isArray(snapshot.renderModes) ||
    (!idle && snapshot.renderModes.length === 0) ||
    snapshot.renderModes.some((mode) => mode !== manifest.renderMode)
  )
    throw new Error('Observed rendering mode differs from the frozen memory manifest.');
}

export function memoryDistribution(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return {
    samples,
    count: samples.length,
    min: sorted[0] ?? null,
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? null,
  };
}

export function usableSurvivorGraph(candidate: unknown): boolean {
  const evidence = record(candidate);
  const reports = evidence?.reports ?? evidence?.fallbacks;
  return (
    evidence?.cleanupConfirmed === true &&
    Array.isArray(reports) &&
    reports.some((report) => record(report)?.name === 'leaks' && record(report)?.usable === true)
  );
}

/** Ownership observations never stand in for ordinary physical-footprint samples. */
export function validateOwnershipMeasurements(candidate: unknown): void {
  const artifact = record(candidate);
  if (
    artifact?.scenario !== 'ownership' ||
    artifact.configuration !== 'Release' ||
    !['list', 'carousel'].includes(String(artifact.surface)) ||
    !['replay', 'expanding'].includes(String(artifact.workload)) ||
    !['ownership', 'graphs'].includes(String(artifact.inspection)) ||
    artifact.warmupCycles !== 2 ||
    artifact.measuredCycles !== 20 ||
    artifact.workloadCompleted !== true ||
    artifact.graphComparisonAvailable !== true ||
    !Array.isArray(artifact.observations) ||
    artifact.observations.length !== 88 ||
    !Array.isArray(artifact.graphCheckpoints) ||
    artifact.graphCheckpoints.length !== 2 ||
    'samples' in artifact ||
    'launches' in artifact
  )
    throw new Error('Incomplete ownership investigation or unavailable survivor-graph comparison.');
  const manifest = validateMemoryManifest(artifact.manifest);
  const identity = record(artifact.process);
  if (
    !identity ||
    typeof identity.pid !== 'number' ||
    typeof identity.startedAt !== 'string' ||
    typeof identity.executable !== 'string'
  )
    throw new Error('Missing ownership process identity.');
  let previousSequence = -1;
  let previousTimestamp = -1;
  let backgroundGeneration = 0;
  const commandIds = new Set<string>();
  if (typeof artifact.runtimeId !== 'string' || !artifact.runtimeId.trim())
    throw new Error('Missing ownership runtime identity.');
  for (const [index, candidateObservation] of artifact.observations.entries()) {
    const observation = record(candidateObservation);
    const cycle = Math.floor(index / 4) - 1;
    const phase = MEMORY_PHASES[index % 4];
    if (observation?.cycle !== cycle || observation.phase !== phase) throw new Error('Missing ownership checkpoint.');
    assertSameProcess(identity as unknown as ProcessIdentity, observation.process as ProcessIdentity);
    const snapshot = record(observation.snapshot);
    validateMemorySnapshot(snapshot, {
      runId: artifact.runtimeId,
      cycle,
      phase,
      surface: artifact.surface as MemorySurface,
      previousSequence,
      previousTimestamp,
    });
    assertMemoryEnvironment(snapshot, manifest);
    const commandId = snapshot?.commandId as string;
    if (commandIds.has(commandId)) throw new Error('Reused ownership command export.');
    commandIds.add(commandId);
    if (phase === 'browsed')
      assertVisitedUuids(
        snapshot?.actualVisibleUuids,
        expectedCycleUuids(manifest, artifact.workload as MemoryWorkload, cycle),
        true,
      );
    if (phase === 'background') {
      if ((snapshot?.backgroundGeneration as number) <= backgroundGeneration)
        throw new Error('Reused ownership background transition.');
      backgroundGeneration = snapshot?.backgroundGeneration as number;
    }
    previousSequence = snapshot?.sequence as number;
    previousTimestamp = snapshot?.timestampMs as number;
  }
  for (const [index, checkpoint] of artifact.graphCheckpoints.entries()) {
    if (record(checkpoint)?.cycle !== (index === 0 ? 0 : 20) || !usableSurvivorGraph(record(checkpoint)?.evidence))
      throw new Error('Both Home0 and Home20 require usable saved survivor graphs.');
  }
  if (artifact.inspection === 'graphs') {
    const provenance = record(artifact.probe);
    const cleanup = record(provenance?.cleanup);
    if (
      typeof provenance?.path !== 'string' ||
      !sha256(provenance.sha256) ||
      cleanup?.recorderAbsent !== true ||
      cleanup.recorderGroupAbsent !== true ||
      cleanup.allocationValid !== false ||
      typeof cleanup.observedAt !== 'string' ||
      !positiveInteger(cleanup.recorderPid)
    )
      throw new Error('Explicit graph fallback lacks failed-probe provenance and verified recorder cleanup.');
  }
}
