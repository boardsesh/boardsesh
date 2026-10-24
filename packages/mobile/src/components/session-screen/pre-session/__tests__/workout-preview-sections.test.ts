import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  type PlannedClimbSlot,
  type WorkoutStage,
} from '@boardsesh/playlist-generator';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { buildPreviewListRows } from '../workout-preview-sections';
import type { PreviewItem } from '../workout-preview-pool';

function makePreview(uuid: string, section: PlannedClimbSlot['section'], index: number, stageId?: string): PreviewItem {
  return {
    item: { uuid, climb: { uuid: `${uuid}-climb` } } as ClimbQueueItem,
    slot: { grade: 10, section, index, ...(stageId === undefined ? {} : { stageId }) },
  };
}

function describeRows(items: PreviewItem[], stages?: WorkoutStage[]): string[] {
  return buildPreviewListRows(items, stages).map((row) => {
    if (row.kind === 'stage') return `STAGE ${row.stageKind}${row.isCoolDown ? ' (cool-down)' : ''}:${row.count}`;
    if (row.kind === 'section') return `${row.section}:${row.count}`;
    return row.preview.item.uuid;
  });
}

const WARM_UP_STAGE: WorkoutStage = { id: 'warm', kind: 'warmUp', warmUpType: 'standard' };
const PYRAMID_STAGE: WorkoutStage = {
  id: 'pyramid',
  kind: 'pyramid',
  options: { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 10, warmUp: 'none' },
};
const VOLUME_STAGE: WorkoutStage = {
  id: 'volume',
  kind: 'volume',
  options: { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 8, warmUp: 'none' },
};

describe('buildPreviewListRows', () => {
  it('heads each section of a pyramid with its warm-up', () => {
    const items = [
      makePreview('w1', 'warmUp', 0),
      makePreview('w2', 'warmUp', 1),
      makePreview('u1', 'increasing', 2),
      makePreview('p1', 'peak', 3),
      makePreview('d1', 'decreasing', 4),
    ];

    expect(describeRows(items)).toEqual([
      'warmUp:2',
      'w1',
      'w2',
      'increasing:1',
      'u1',
      'peak:1',
      'p1',
      'decreasing:1',
      'd1',
    ]);
  });

  it('leaves a single-section plan without headings', () => {
    const items = [makePreview('m1', 'main', 0), makePreview('m2', 'main', 1)];

    expect(describeRows(items)).toEqual(['m1', 'm2']);
  });

  it('counts only the climbs a short pool filled', () => {
    // The plan had three warm-up slots; one found no climb and never reached the preview.
    const items = [makePreview('w1', 'warmUp', 0), makePreview('w3', 'warmUp', 2), makePreview('m1', 'main', 3)];

    expect(describeRows(items)).toEqual(['warmUp:2', 'w1', 'w3', 'main:1', 'm1']);
  });

  it('keeps heading keys unique when a section comes round twice', () => {
    const items = [makePreview('a', 'main', 0), makePreview('b', 'peak', 1), makePreview('c', 'main', 2)];

    const keys = buildPreviewListRows(items).map((row) => row.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('returns nothing for an empty preview', () => {
    expect(buildPreviewListRows([])).toEqual([]);
  });

  it('looks exactly as before for one block with a warm-up', () => {
    const items = [
      makePreview('w1', 'warmUp', 0, 'warm'),
      makePreview('u1', 'increasing', 1, 'pyramid'),
      makePreview('p1', 'peak', 2, 'pyramid'),
      makePreview('d1', 'decreasing', 3, 'pyramid'),
    ];
    const stages = [WARM_UP_STAGE, PYRAMID_STAGE];

    expect(buildPreviewListRows(items, stages)).toEqual(buildPreviewListRows(items));
    expect(describeRows(items, stages)).toEqual([
      'warmUp:1',
      'w1',
      'increasing:1',
      'u1',
      'peak:1',
      'p1',
      'decreasing:1',
      'd1',
    ]);
  });

  it('heads each stage of a multi-block workout, over its own sections', () => {
    const items = [
      makePreview('w1', 'warmUp', 0, 'warm'),
      makePreview('w2', 'warmUp', 1, 'warm'),
      makePreview('u1', 'increasing', 2, 'pyramid'),
      makePreview('p1', 'peak', 3, 'pyramid'),
      makePreview('d1', 'decreasing', 4, 'pyramid'),
      makePreview('v1', 'main', 5, 'volume'),
      makePreview('v2', 'main', 6, 'volume'),
    ];

    expect(describeRows(items, [WARM_UP_STAGE, PYRAMID_STAGE, VOLUME_STAGE])).toEqual([
      // A one-section stage (the warm-up, the volume set) gets no section heading under its stage heading.
      'STAGE warmUp:2',
      'w1',
      'w2',
      'STAGE pyramid:3',
      'increasing:1',
      'u1',
      'peak:1',
      'p1',
      'decreasing:1',
      'd1',
      'STAGE volume:2',
      'v1',
      'v2',
    ]);
  });

  it('counts only the filled climbs in a stage heading and skips a stage that found none', () => {
    const items = [makePreview('p1', 'peak', 1, 'pyramid'), makePreview('v2', 'main', 6, 'volume')];

    expect(describeRows(items, [WARM_UP_STAGE, PYRAMID_STAGE, VOLUME_STAGE])).toEqual([
      'STAGE pyramid:1',
      'p1',
      'STAGE volume:1',
      'v2',
    ]);
  });

  it('keeps every key unique when two blocks share a type', () => {
    const secondVolume: WorkoutStage = { ...VOLUME_STAGE, id: 'volume-2' };
    const items = [
      makePreview('a', 'main', 0, 'volume'),
      makePreview('b', 'main', 1, 'volume-2'),
      makePreview('c', 'main', 2, 'volume-2'),
    ];

    const rows = buildPreviewListRows(items, [VOLUME_STAGE, secondVolume]);
    const keys = rows.map((row) => row.key);

    expect(rows.filter((row) => row.kind === 'stage')).toHaveLength(2);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('heads a cool-down after one block as its own section', () => {
    const items = [
      makePreview('v1', 'main', 0, 'volume'),
      makePreview('v2', 'main', 1, 'volume'),
      makePreview('c1', 'coolDown', 2, 'cool'),
      makePreview('c2', 'coolDown', 3, 'cool'),
    ];

    expect(describeRows(items, [VOLUME_STAGE, { ...WARM_UP_STAGE, id: 'cool' }])).toEqual([
      'main:2',
      'v1',
      'v2',
      'coolDown:2',
      'c1',
      'c2',
    ]);
  });

  it('heads a warm-up after the last of several blocks as a cool-down, and a warm-up before them as a warm-up', () => {
    const items = [
      makePreview('w1', 'warmUp', 0, 'warm'),
      makePreview('p1', 'peak', 1, 'pyramid'),
      makePreview('v1', 'main', 2, 'volume'),
      makePreview('c1', 'coolDown', 3, 'cool'),
    ];
    const stages = [WARM_UP_STAGE, PYRAMID_STAGE, VOLUME_STAGE, { ...WARM_UP_STAGE, id: 'cool' }];

    expect(describeRows(items, stages)).toEqual([
      'STAGE warmUp:1',
      'w1',
      'STAGE pyramid:1',
      'p1',
      'STAGE volume:1',
      'v1',
      'STAGE warmUp (cool-down):1',
      'c1',
    ]);
    expect(buildPreviewListRows(items, stages)[0]).not.toHaveProperty('isCoolDown');
  });
});
