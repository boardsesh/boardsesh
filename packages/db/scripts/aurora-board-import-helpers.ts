import { projectAuroraFramesToStoredRows } from '@boardsesh/board-constants/hold-states';

export const DIRECT_AURORA_BOARDS = ['decoy', 'touchstone', 'grasshopper', 'soill'] as const;

export type DirectAuroraBoard = (typeof DIRECT_AURORA_BOARDS)[number];
export type ImportedHoldState = 'STARTING' | 'HAND' | 'FINISH' | 'FOOT';

export type SourceClimbRow = {
  uuid: string;
  frames: string | null;
};

export type SourceClimbHoldRow = {
  climb_uuid: string | null;
  hold_id: number | null;
  frame_number: number | null;
  hold_state: string | null;
  created_at?: string | null;
};

export type DerivedClimbHold = {
  climbUuid: string;
  holdId: number;
  frameNumber: number;
  holdState: ImportedHoldState;
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asImportedHoldState(value: string | null | undefined): ImportedHoldState | null {
  if (!value) {
    return null;
  }

  if (value === 'STARTING' || value === 'HAND' || value === 'FINISH' || value === 'FOOT') {
    return value;
  }

  return null;
}

export function deriveClimbHoldsFromFrames(climb: SourceClimbRow, boardName: DirectAuroraBoard): DerivedClimbHold[] {
  if (!climb.frames) {
    return [];
  }

  return projectAuroraFramesToStoredRows(climb.frames, boardName).rows.flatMap((row) => {
    const holdState = asImportedHoldState(row.holdState);
    return holdState ? [{ climbUuid: climb.uuid, ...row, holdState }] : [];
  });
}

export function dedupeSourceClimbHolds(rows: SourceClimbHoldRow[]): DerivedClimbHold[] {
  const normalized = rows
    .map((row, index) => {
      const climbUuid = row.climb_uuid ?? null;
      const holdId = toNumber(row.hold_id);
      const frameNumber = toNumber(row.frame_number);
      const holdState = asImportedHoldState(row.hold_state);

      if (
        !climbUuid ||
        holdId === null ||
        !Number.isSafeInteger(holdId) ||
        holdId <= 0 ||
        frameNumber === null ||
        !Number.isSafeInteger(frameNumber) ||
        frameNumber < 0 ||
        !holdState
      ) {
        return null;
      }

      return {
        climbUuid,
        holdId,
        frameNumber,
        holdState,
        createdAt: row.created_at ?? null,
        index,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((left, right) => {
      if (left.climbUuid !== right.climbUuid) {
        return left.climbUuid.localeCompare(right.climbUuid);
      }

      if (left.holdId !== right.holdId) {
        return left.holdId - right.holdId;
      }

      const leftCreatedAt = left.createdAt ?? '';
      const rightCreatedAt = right.createdAt ?? '';

      if (leftCreatedAt !== rightCreatedAt) {
        return rightCreatedAt.localeCompare(leftCreatedAt);
      }

      return right.index - left.index;
    });

  const deduped: DerivedClimbHold[] = [];
  const seen = new Set<string>();

  for (const row of normalized) {
    const key = `${row.climbUuid}:${row.holdId}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({
      climbUuid: row.climbUuid,
      holdId: row.holdId,
      frameNumber: row.frameNumber,
      holdState: row.holdState,
    });
  }

  return deduped;
}

/**
 * Resolve the rows a full-board import may materialize.
 *
 * `board_climbs.frames` is canonical whenever present, so a stale-but-valid
 * source `climb_holds` table must not override it. Normalized source rows are
 * retained only for legacy climbs whose frame blob is absent.
 */
export function resolveImportedClimbHolds(
  climbs: SourceClimbRow[],
  sourceRows: SourceClimbHoldRow[],
  boardName: DirectAuroraBoard,
): DerivedClimbHold[] {
  const sourceRowsByClimb = new Map<string, DerivedClimbHold[]>();
  for (const row of dedupeSourceClimbHolds(sourceRows)) {
    const rows = sourceRowsByClimb.get(row.climbUuid) ?? [];
    rows.push(row);
    sourceRowsByClimb.set(row.climbUuid, rows);
  }

  return climbs.flatMap((climb) =>
    climb.frames ? deriveClimbHoldsFromFrames(climb, boardName) : (sourceRowsByClimb.get(climb.uuid) ?? []),
  );
}
