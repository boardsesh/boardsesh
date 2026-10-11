import { describe, expect, it } from 'vitest';
import type { PlannedClimbSlot } from '@boardsesh/playlist-generator';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { buildPreviewListRows } from '../workout-preview-sections';
import type { PreviewItem } from '../workout-preview-pool';

function makePreview(uuid: string, section: PlannedClimbSlot['section'], index: number): PreviewItem {
  return {
    item: { uuid, climb: { uuid: `${uuid}-climb` } } as ClimbQueueItem,
    slot: { grade: 10, section, index },
  };
}

function describeRows(items: PreviewItem[]): string[] {
  return buildPreviewListRows(items).map((row) =>
    row.kind === 'section' ? `${row.section}:${row.count}` : row.preview.item.uuid,
  );
}

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
});
