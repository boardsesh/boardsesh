// The preview heading of a 4x4 (#5380): each row is one set, a climb done for
// every rep, so its heading says how many reps each row takes.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOUR_BY_FOUR_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  type PlannedClimbSlot,
  type WorkoutStage,
} from '@boardsesh/playlist-generator';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { buildPreviewListRows } from '../workout-preview-sections';
import type { PreviewItem } from '../workout-preview-pool';

function makePreview(uuid: string, section: PlannedClimbSlot['section'], index: number, stageId: string): PreviewItem {
  return {
    item: { uuid, climb: { uuid: `${uuid}-climb` } } as ClimbQueueItem,
    slot: { grade: 10, section, index, stageId },
  };
}

function describeRows(items: PreviewItem[], stages: WorkoutStage[]): string[] {
  return buildPreviewListRows(items, stages).map((row) => {
    if (row.kind === 'stage') {
      return row.repsPerSet === undefined
        ? `STAGE ${row.stageKind}:${row.count}`
        : `STAGE ${row.stageKind}:${row.count} x${row.repsPerSet} reps`;
    }
    if (row.kind === 'section') return `${row.section}:${row.count}`;
    return row.preview.item.uuid;
  });
}

const WARM_UP_STAGE: WorkoutStage = { id: 'warm', kind: 'warmUp', warmUpType: 'standard' };
const VOLUME_STAGE: WorkoutStage = {
  id: 'volume',
  kind: 'volume',
  options: { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 8, warmUp: 'none' },
};
const fourByFourStage = (repsPerSet: number): WorkoutStage => ({
  id: 'four',
  kind: 'fourByFour',
  options: { ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade: 12, repsPerSet, warmUp: 'none' },
});
const fourByFourRows = (firstIndex = 0) =>
  ['f1', 'f2', 'f3', 'f4'].map((uuid, offset) => makePreview(uuid, 'main', firstIndex + offset, 'four'));

describe('buildPreviewListRows for a 4x4', () => {
  it('heads it with its reps per set even as the only block', () => {
    expect(describeRows(fourByFourRows(), [fourByFourStage(4)])).toEqual([
      'STAGE fourByFour:4 x4 reps',
      'f1',
      'f2',
      'f3',
      'f4',
    ]);
  });

  it('heads the warm-up before it too, so the list reads stage by stage', () => {
    const items = [
      makePreview('w1', 'warmUp', 0, 'warm'),
      makePreview('w2', 'warmUp', 1, 'warm'),
      ...fourByFourRows(2),
    ];

    expect(describeRows(items, [WARM_UP_STAGE, fourByFourStage(4)])).toEqual([
      'STAGE warmUp:2',
      'w1',
      'w2',
      'STAGE fourByFour:4 x4 reps',
      'f1',
      'f2',
      'f3',
      'f4',
    ]);
  });

  it('names the reps on its own heading only among several blocks', () => {
    const items = [...fourByFourRows(), makePreview('v1', 'main', 4, 'volume')];

    expect(describeRows(items, [fourByFourStage(3), VOLUME_STAGE])).toEqual([
      'STAGE fourByFour:4 x3 reps',
      'f1',
      'f2',
      'f3',
      'f4',
      'STAGE volume:1',
      'v1',
    ]);
  });

  it('heads it with the reps its pacing runs, never fewer than two', () => {
    expect(describeRows(fourByFourRows(), [fourByFourStage(1)])[0]).toBe('STAGE fourByFour:4 x2 reps');
  });

  it('counts only the rows a short pool filled', () => {
    const items = fourByFourRows().filter((preview) => preview.item.uuid !== 'f3');

    expect(describeRows(items, [fourByFourStage(4)])[0]).toBe('STAGE fourByFour:3 x4 reps');
  });
});
