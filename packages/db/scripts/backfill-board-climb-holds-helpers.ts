import { isAuroraBoardName, projectAuroraFramesToStoredRows } from '@boardsesh/board-constants/hold-states';

export type BackfillHoldRow = {
  holdId: number;
  frameNumber: number;
  holdState: string;
};

/** Project an Aurora frame blob to the canonical one-row-per-positive-hold shape. */
export function projectBackfillFrames(boardType: string, frames: string): BackfillHoldRow[] {
  if (!isAuroraBoardName(boardType)) return [];
  return projectAuroraFramesToStoredRows(frames, boardType).rows;
}
