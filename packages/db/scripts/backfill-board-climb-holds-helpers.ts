import { SUPPORTED_BOARDS, type BoardName } from '@boardsesh/shared-schema';
import {
  convertLitUpHoldsStringToMap,
  isAuroraBoardName,
  isSentinelHoldState,
  minimumStoredHoldId,
  projectAuroraFramesToStoredRows,
} from '@boardsesh/board-constants/hold-states';

export type BackfillHoldRow = {
  holdId: number;
  frameNumber: number;
  holdState: string;
};

/** Share Aurora projection while preserving the backfill's other board parsers. */
export function projectBackfillFrames(boardType: string, frames: string): BackfillHoldRow[] {
  if (isAuroraBoardName(boardType)) return projectAuroraFramesToStoredRows(frames, boardType).rows;
  if (!SUPPORTED_BOARDS.includes(boardType as BoardName)) return [];
  const frameMap = convertLitUpHoldsStringToMap(frames, boardType as BoardName);
  const rows: BackfillHoldRow[] = [];
  for (const [frameNumberText, holds] of Object.entries(frameMap)) {
    for (const [holdIdText, hold] of Object.entries(holds)) {
      const holdId = Number(holdIdText);
      if (isSentinelHoldState(hold.state) || !Number.isSafeInteger(holdId) || holdId < minimumStoredHoldId(boardType))
        continue;
      rows.push({ holdId, frameNumber: Number(frameNumberText), holdState: hold.state });
    }
  }
  return rows;
}
