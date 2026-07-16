import type { HoldMorphologyRecord } from './types.js';

const BOARD_ORDER: Record<HoldMorphologyRecord['boardType'], number> = {
  kilter: 0,
  tension: 1,
  moonboard: 2,
};

function recordHoldId(record: HoldMorphologyRecord): number {
  return record.boardType === 'moonboard' ? record.gridCellId : record.placementId;
}

export function holdMorphologyRecordKey(record: HoldMorphologyRecord): string {
  const holdKind = record.boardType === 'moonboard' ? 'cell' : 'placement';
  return `${record.boardType}:${record.layoutId}:${holdKind}:${recordHoldId(record)}`;
}

export function compareHoldMorphologyRecords(left: HoldMorphologyRecord, right: HoldMorphologyRecord): number {
  return (
    BOARD_ORDER[left.boardType] - BOARD_ORDER[right.boardType] ||
    left.layoutId - right.layoutId ||
    recordHoldId(left) - recordHoldId(right) ||
    left.setId - right.setId ||
    left.sourceAsset.localeCompare(right.sourceAsset)
  );
}

/** Stable JSONL serialization for artifact regeneration and byte-for-byte drift checks. */
export function renderHoldMorphologyJsonl(records: readonly HoldMorphologyRecord[]): string {
  const sortedRecords = [...records].sort(compareHoldMorphologyRecords);
  if (sortedRecords.length === 0) return '';
  return `${sortedRecords.map((record) => JSON.stringify(record)).join('\n')}\n`;
}
