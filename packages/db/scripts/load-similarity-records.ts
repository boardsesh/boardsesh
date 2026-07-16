import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface SimilarityArtifactIdentity {
  boardType: string;
  modelVersion: string;
  allowLegacy?: boolean;
}

export const LEGACY_SIMILARITY_MODEL_VERSION = 'climb2vec-v1';
export type SimilarityArtifactMode = 'identified' | 'legacy';

export interface SimilarityArtifactRecord {
  boardType: string;
  modelVersion: string;
  climbUuid: string;
  layoutId: number | null;
  angle: number;
  neighbours: Array<[string, number]>;
}

export interface SimilarityArtifactEntry {
  mode: SimilarityArtifactMode;
  record: SimilarityArtifactRecord;
}

export interface SimilarityArtifactInspection {
  mode: SimilarityArtifactMode;
  keys: Set<string>;
  artifactRows: number;
  selectedRows: number;
}

export function similarityArtifactKey(climbUuid: string, angle: number): string {
  return `${climbUuid}\0${angle}`;
}

function recordError(lineNumber: number, message: string): Error {
  return new Error(`similarity artifact line ${lineNumber}: ${message}`);
}

function requireObject(value: unknown, lineNumber: number): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw recordError(lineNumber, 'expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string, lineNumber: number): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw recordError(lineNumber, `${field} must be a non-empty string`);
  }
  return value;
}

function requireInteger(record: Record<string, unknown>, field: string, lineNumber: number): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw recordError(lineNumber, `${field} must be an integer`);
  }
  return value;
}

function parseSimilarityArtifactEntry(
  line: string,
  lineNumber: number,
  expected: SimilarityArtifactIdentity,
  requiredMode?: SimilarityArtifactMode,
): SimilarityArtifactEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw recordError(lineNumber, `invalid JSON (${detail})`);
  }
  const record = requireObject(parsed, lineNumber);
  const identityFields = ['boardType', 'modelVersion', 'layoutId'] as const;
  const identityFieldCount = identityFields.filter((field) =>
    Object.prototype.hasOwnProperty.call(record, field),
  ).length;
  let mode: SimilarityArtifactMode;
  if (identityFieldCount === 0) {
    mode = 'legacy';
  } else if (identityFieldCount === identityFields.length) {
    mode = 'identified';
  } else {
    throw recordError(lineNumber, 'boardType, modelVersion, and layoutId must either all be present or all be omitted');
  }
  if (requiredMode && mode !== requiredMode) {
    throw recordError(lineNumber, `cannot mix ${requiredMode} and ${mode} similarity records in one artifact`);
  }
  if (mode === 'legacy' && (!expected.allowLegacy || expected.modelVersion !== LEGACY_SIMILARITY_MODEL_VERSION)) {
    throw recordError(
      lineNumber,
      `legacy similarity records require explicit --board and --model=${LEGACY_SIMILARITY_MODEL_VERSION}`,
    );
  }
  const boardType = mode === 'identified' ? requireString(record, 'boardType', lineNumber) : expected.boardType;
  const modelVersion =
    mode === 'identified' ? requireString(record, 'modelVersion', lineNumber) : expected.modelVersion;
  if (modelVersion !== expected.modelVersion) {
    throw recordError(
      lineNumber,
      `modelVersion ${JSON.stringify(modelVersion)} does not match --model=${expected.modelVersion}`,
    );
  }
  const climbUuid = requireString(record, 'climbUuid', lineNumber);
  const layoutId = mode === 'identified' ? requireInteger(record, 'layoutId', lineNumber) : null;
  const angle = requireInteger(record, 'angle', lineNumber);
  if (!Array.isArray(record.neighbours)) {
    throw recordError(lineNumber, 'neighbours must be an array');
  }

  const neighborUuids = new Set<string>();
  const neighbours = record.neighbours.map((entry, index): [string, number] => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw recordError(lineNumber, `neighbours[${index}] must be a [climbUuid, score] pair`);
    }
    const [neighborUuid, score] = entry;
    if (typeof neighborUuid !== 'string' || neighborUuid.length === 0) {
      throw recordError(lineNumber, `neighbours[${index}][0] must be a non-empty string`);
    }
    if (neighborUuid === climbUuid) {
      throw recordError(lineNumber, `neighbours[${index}] cannot reference the source climb`);
    }
    if (neighborUuids.has(neighborUuid)) {
      throw recordError(lineNumber, `duplicate neighbour ${JSON.stringify(neighborUuid)}`);
    }
    neighborUuids.add(neighborUuid);
    if (typeof score !== 'number' || !Number.isFinite(score) || score < -1 || score > 1) {
      throw recordError(lineNumber, `neighbours[${index}][1] must be a finite cosine score in [-1, 1]`);
    }
    return [neighborUuid, score];
  });

  return {
    mode,
    record: {
      boardType,
      modelVersion,
      climbUuid,
      layoutId,
      angle,
      neighbours,
    },
  };
}

export function parseSimilarityArtifactRecord(
  line: string,
  lineNumber: number,
  expected: SimilarityArtifactIdentity,
): SimilarityArtifactRecord {
  return parseSimilarityArtifactEntry(line, lineNumber, expected).record;
}

export async function* readSimilarityArtifact(
  path: string,
  expected: SimilarityArtifactIdentity,
): AsyncGenerator<SimilarityArtifactEntry> {
  const reader = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const keys = new Set<string>();
  let artifactMode: SimilarityArtifactMode | undefined;
  let lineNumber = 0;
  let recordCount = 0;

  for await (const line of reader) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = parseSimilarityArtifactEntry(trimmed, lineNumber, expected, artifactMode);
    artifactMode = entry.mode;
    const { record } = entry;
    const key = `${record.boardType}\0${record.climbUuid}\0${record.angle}`;
    if (keys.has(key)) {
      throw recordError(
        lineNumber,
        `duplicate boardType+climbUuid+angle for ${record.boardType}:${record.climbUuid}@${record.angle}`,
      );
    }
    keys.add(key);
    recordCount += 1;
    yield entry;
  }

  if (recordCount === 0) {
    throw new Error('similarity artifact contains no records; refusing to clear the selected board');
  }
}

export async function inspectSimilarityArtifact(
  path: string,
  expected: SimilarityArtifactIdentity,
): Promise<SimilarityArtifactInspection> {
  const inspection: SimilarityArtifactInspection = {
    mode: 'identified',
    keys: new Set<string>(),
    artifactRows: 0,
    selectedRows: 0,
  };
  for await (const entry of readSimilarityArtifact(path, expected)) {
    inspection.mode = entry.mode;
    const { record } = entry;
    inspection.artifactRows += 1;
    if (record.boardType === expected.boardType) {
      inspection.keys.add(similarityArtifactKey(record.climbUuid, record.angle));
      inspection.selectedRows += 1;
    }
  }
  if (inspection.selectedRows === 0) {
    throw new Error(`similarity artifact has no rows for --board=${expected.boardType}; refusing to clear that board`);
  }
  return inspection;
}

export function assertUnchangedSimilaritySelection(
  expectedKeys: ReadonlySet<string>,
  loadedKeys: ReadonlySet<string>,
): void {
  const missing = [...expectedKeys].filter((key) => !loadedKeys.has(key));
  const extra = [...loadedKeys].filter((key) => !expectedKeys.has(key));
  if (missing.length === 0 && extra.length === 0) return;
  throw new Error(
    `similarity artifact changed after validation: expected=${expectedKeys.size}, ` +
      `loaded=${loadedKeys.size}, missing=${missing.length}, extra=${extra.length}`,
  );
}
