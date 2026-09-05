import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createRecordValidator, type RecordValidator } from '../src/queries/content-model/runtime-validation.js';

export interface ContentArtifactIdentity {
  boardType: string;
  modelVersion: string;
  allowLegacy?: boolean;
}

export const LEGACY_CONTENT_MODEL_VERSION = 'climb2vec-v1';
export const CONTENT_EMBEDDING_DIMENSION = 64;
export type ContentArtifactMode = 'identified' | 'legacy';

interface ContentRecordBase {
  boardType: string;
  modelVersion: string;
  climbUuid: string;
  angle: number;
}

export interface SupportedContentRecord extends ContentRecordBase {
  supported: true;
  contentPrior: number;
  contentSd: number;
  embedding: number[];
}

export interface UnsupportedContentRecord extends ContentRecordBase {
  supported: false;
  contentPrior: null;
  contentSd: null;
  embedding: null;
}

export type ContentArtifactRecord = SupportedContentRecord | UnsupportedContentRecord;

export interface ContentArtifactEntry {
  mode: ContentArtifactMode;
  record: ContentArtifactRecord;
}

export interface ContentArtifactInspection {
  mode: ContentArtifactMode;
  keys: Set<string>;
  artifactRows: number;
  selectedRows: number;
  supported: number;
  unsupported: number;
}

export interface EligibleContentCell {
  climbUuid: string;
  angle: number;
}

export function contentArtifactKey(climbUuid: string, angle: number): string {
  return `${climbUuid}\0${angle}`;
}

function contentArtifactGlobalKey(boardType: string, climbUuid: string, angle: number): string {
  return `${boardType}\0${contentArtifactKey(climbUuid, angle)}`;
}

function recordError(lineNumber: number, message: string): Error {
  return new Error(`content artifact line ${lineNumber}: ${message}`);
}

function requireNull(record: Record<string, unknown>, field: string, lineNumber: number): null {
  if (record[field] !== null) {
    throw recordError(lineNumber, `${field} must be null when supported=false`);
  }
  return null;
}

function parseSupportedContentRecord(
  record: Record<string, unknown>,
  lineNumber: number,
  identity: ContentRecordBase,
  validation: RecordValidator,
): SupportedContentRecord {
  const contentPrior = validation.finiteNumber(record, 'contentPrior');
  const contentSd = validation.finiteNumber(record, 'contentSd');
  if (contentSd <= 0) {
    throw recordError(lineNumber, 'contentSd must be greater than zero');
  }
  if (!Array.isArray(record.embedding)) {
    throw recordError(lineNumber, 'embedding must be a number array');
  }
  if (record.embedding.length !== CONTENT_EMBEDDING_DIMENSION) {
    throw recordError(
      lineNumber,
      `embedding must contain exactly ${CONTENT_EMBEDDING_DIMENSION} numbers; received ${record.embedding.length}`,
    );
  }
  const embedding = record.embedding.map((component, index) => {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw recordError(lineNumber, `embedding[${index}] must be a finite number`);
    }
    return component;
  });
  return {
    ...identity,
    supported: true,
    contentPrior,
    contentSd,
    embedding,
  };
}

function parseContentArtifactEntry(
  line: string,
  lineNumber: number,
  expected: ContentArtifactIdentity,
  requiredMode?: ContentArtifactMode,
): ContentArtifactEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw recordError(lineNumber, `invalid JSON (${detail})`);
  }

  const validation = createRecordValidator((message) => recordError(lineNumber, message));
  const record = validation.record(parsed);
  const identityFields = ['boardType', 'modelVersion', 'supported'] as const;
  const identityFieldCount = identityFields.filter((field) =>
    Object.prototype.hasOwnProperty.call(record, field),
  ).length;
  let mode: ContentArtifactMode;
  if (identityFieldCount === 0) {
    mode = 'legacy';
  } else if (identityFieldCount === identityFields.length) {
    mode = 'identified';
  } else {
    throw recordError(
      lineNumber,
      'boardType, modelVersion, and supported must either all be present or all be omitted',
    );
  }
  if (requiredMode && mode !== requiredMode) {
    throw recordError(lineNumber, `cannot mix ${requiredMode} and ${mode} content records in one artifact`);
  }
  if (mode === 'legacy' && (!expected.allowLegacy || expected.modelVersion !== LEGACY_CONTENT_MODEL_VERSION)) {
    throw recordError(
      lineNumber,
      `legacy content records require explicit --board and --model=${LEGACY_CONTENT_MODEL_VERSION}`,
    );
  }

  const boardType = mode === 'identified' ? validation.nonEmptyString(record, 'boardType') : expected.boardType;
  const modelVersion =
    mode === 'identified' ? validation.nonEmptyString(record, 'modelVersion') : expected.modelVersion;
  if (modelVersion !== expected.modelVersion) {
    throw recordError(
      lineNumber,
      `modelVersion ${JSON.stringify(modelVersion)} does not match --model=${expected.modelVersion}`,
    );
  }
  const climbUuid = validation.nonEmptyString(record, 'climbUuid');
  const angle = validation.finiteNumber(record, 'angle');
  if (!Number.isInteger(angle)) {
    throw recordError(lineNumber, 'angle must be an integer');
  }
  const identity = { boardType, modelVersion, climbUuid, angle };

  if (mode === 'legacy') {
    return {
      mode,
      record: parseSupportedContentRecord(record, lineNumber, identity, validation),
    };
  }

  if (typeof record.supported !== 'boolean') {
    throw recordError(lineNumber, 'supported must be a boolean');
  }
  if (!record.supported) {
    return {
      mode,
      record: {
        ...identity,
        supported: false,
        contentPrior: requireNull(record, 'contentPrior', lineNumber),
        contentSd: requireNull(record, 'contentSd', lineNumber),
        embedding: requireNull(record, 'embedding', lineNumber),
      },
    };
  }

  return {
    mode,
    record: parseSupportedContentRecord(record, lineNumber, identity, validation),
  };
}

export function parseContentArtifactRecord(
  line: string,
  lineNumber: number,
  expected: ContentArtifactIdentity,
): ContentArtifactRecord {
  return parseContentArtifactEntry(line, lineNumber, expected).record;
}

export async function* readContentArtifact(
  path: string,
  expected: ContentArtifactIdentity,
): AsyncGenerator<ContentArtifactEntry> {
  const input = createReadStream(path, { encoding: 'utf8' });
  const reader = createInterface({
    input,
    crlfDelay: Infinity,
  });
  const keys = new Set<string>();
  let artifactMode: ContentArtifactMode | undefined;
  let lineNumber = 0;
  let recordCount = 0;

  try {
    for await (const line of reader) {
      lineNumber += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = parseContentArtifactEntry(trimmed, lineNumber, expected, artifactMode);
      artifactMode = entry.mode;
      const { record } = entry;
      const key = contentArtifactGlobalKey(record.boardType, record.climbUuid, record.angle);
      if (keys.has(key)) {
        throw recordError(
          lineNumber,
          `duplicate climbUuid+angle ${JSON.stringify(record.climbUuid)} at ${record.angle}`,
        );
      }
      keys.add(key);
      recordCount += 1;
      yield entry;
    }
  } finally {
    reader.close();
    input.destroy();
  }

  if (recordCount === 0) {
    throw new Error('content artifact contains no records; refusing to clear the selected board');
  }
}

export async function inspectContentArtifact(
  path: string,
  expected: ContentArtifactIdentity,
): Promise<ContentArtifactInspection> {
  const inspection: ContentArtifactInspection = {
    mode: 'identified',
    keys: new Set<string>(),
    artifactRows: 0,
    selectedRows: 0,
    supported: 0,
    unsupported: 0,
  };
  for await (const entry of readContentArtifact(path, expected)) {
    inspection.mode = entry.mode;
    const { record } = entry;
    inspection.artifactRows += 1;
    if (record.boardType !== expected.boardType) continue;
    inspection.keys.add(contentArtifactKey(record.climbUuid, record.angle));
    inspection.selectedRows += 1;
    if (record.supported) inspection.supported += 1;
    else inspection.unsupported += 1;
  }
  return inspection;
}

export function assertCompleteArtifactCoverage(
  artifactKeys: ReadonlySet<string>,
  eligibleCells: readonly EligibleContentCell[],
): void {
  const eligibleKeys = new Set(eligibleCells.map((cell) => contentArtifactKey(cell.climbUuid, cell.angle)));
  const missing = [...eligibleKeys].filter((key) => !artifactKeys.has(key));
  const extra = [...artifactKeys].filter((key) => !eligibleKeys.has(key));
  if (missing.length === 0 && extra.length === 0) return;

  const preview = (keys: readonly string[]): string =>
    keys
      .slice(0, 3)
      .map((key) => key.replace('\0', '@'))
      .join(', ');
  throw new Error(
    `content artifact coverage does not match the eligible catalog: ` +
      `artifact=${artifactKeys.size}, eligible=${eligibleKeys.size}, ` +
      `missing=${missing.length}${missing.length > 0 ? ` (${preview(missing)})` : ''}, ` +
      `extra=${extra.length}${extra.length > 0 ? ` (${preview(extra)})` : ''}`,
  );
}
