/**
 * Line reader for the deterministic hold-morphology artifact consumed by
 * `extract-training-matrix.ts`. Kept beside the CLI (same split as
 * `load-content-model.ts` / `load-content-model-records.ts`) so a truncated or
 * hand-edited artifact fails with a line-numbered message instead of a bare
 * TypeError deep inside the extraction transaction.
 */
import { createRecordValidator } from '../src/queries/content-model/runtime-validation.js';

export const MORPHOLOGY_VECTOR_LENGTH = 12;

export interface MorphologyRecord {
  morphologyVersion: string;
  boardType: string;
  layoutId: number;
  placementId?: number;
  gridCellId?: number;
  normalizedCenterDistance: number;
  vector: number[];
}

export function morphologyRecordError(lineNumber: number, message: string): Error {
  return new Error(`morphology artifact line ${lineNumber}: ${message}`);
}

/** The hold identity column a board keeps its morphology under. */
export function morphologyHoldIdField(boardType: string): 'gridCellId' | 'placementId' {
  return boardType === 'moonboard' ? 'gridCellId' : 'placementId';
}

export function parseMorphologyRecord(line: string, lineNumber: number): MorphologyRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw morphologyRecordError(lineNumber, `invalid JSON (${detail})`);
  }

  const validation = createRecordValidator((message) => morphologyRecordError(lineNumber, message));
  const record = validation.record(parsed);
  const morphologyVersion = validation.nonEmptyString(record, 'morphologyVersion');
  const boardType = validation.nonEmptyString(record, 'boardType');
  const layoutId = validation.integer(record, 'layoutId');
  const normalizedCenterDistance = validation.finiteNumber(record, 'normalizedCenterDistance');

  if (!Array.isArray(record.vector)) {
    throw morphologyRecordError(lineNumber, 'vector must be a number array');
  }
  if (record.vector.length !== MORPHOLOGY_VECTOR_LENGTH) {
    throw morphologyRecordError(
      lineNumber,
      `vector must contain exactly ${MORPHOLOGY_VECTOR_LENGTH} numbers; received ${record.vector.length}`,
    );
  }
  const vector = record.vector.map((component, index) => {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw morphologyRecordError(lineNumber, `vector[${index}] must be a finite number`);
    }
    return component;
  });

  const holdIdField = morphologyHoldIdField(boardType);
  const holdId = validation.integer(record, holdIdField);
  return {
    morphologyVersion,
    boardType,
    layoutId,
    [holdIdField]: holdId,
    normalizedCenterDistance,
    vector,
  };
}
