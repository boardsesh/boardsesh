// Reaching for the angle pill mid-browse used to cost the climber the climb they
// were looking at: the drawer dropped its pinned preview and fell back to the
// queue head. These pin the re-anchor that replaced that — same climb, same
// item uuid (the drawer's navigation anchor), grade re-resolved at the new angle.
import { describe, expect, it } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { Climb } from '@boardsesh/shared-schema';
import { previewNeedsAngleReanchor, reanchorPreviewAtAngle } from '../preview-angle-anchor';

function makeItem(climbUuid: string, angle: number | null): ClimbQueueItem {
  return {
    uuid: 'queue-item-1',
    suggested: true,
    climb: {
      uuid: climbUuid,
      name: 'Crimpy Thing',
      frames: 'p1145r15',
      angle,
      difficulty: 'V4',
      quality_average: '3.0',
      ascensionist_count: 12,
      benchmark_difficulty: 'V5',
      difficulty_error: '0.4',
      boardseshDifficulty: 17,
      boardseshConfidence: 'high',
    },
  } as unknown as ClimbQueueItem;
}

function makeClimbAtAngle(uuid: string, overrides: Partial<Climb> = {}): Climb {
  return {
    uuid,
    name: 'Crimpy Thing',
    frames: 'p1145r15',
    angle: 50,
    difficulty: 'V6',
    quality_average: '3.6',
    ascensionist_count: 40,
    benchmark_difficulty: null,
    difficulty_error: '0.2',
    boardseshDifficulty: 21,
    boardseshConfidence: 'medium',
    ...overrides,
  } as unknown as Climb;
}

describe('previewNeedsAngleReanchor', () => {
  it('is true only when the pinned grade belongs to a different angle', () => {
    expect(previewNeedsAngleReanchor(makeItem('climb-a', 40), 50)).toBe(true);
    expect(previewNeedsAngleReanchor(makeItem('climb-a', 50), 50)).toBe(false);
  });

  it('leaves an angle-less climb alone rather than fetching on a guess', () => {
    // A request per render is the failure mode this guard exists for.
    expect(previewNeedsAngleReanchor(makeItem('climb-a', null), 50)).toBe(false);
    expect(previewNeedsAngleReanchor(null, 50)).toBe(false);
  });
});

describe('reanchorPreviewAtAngle', () => {
  it('patches the angle-specific fields and keeps the item uuid', () => {
    const item = makeItem('climb-a', 40);
    const reanchored = reanchorPreviewAtAngle(item, 50, makeClimbAtAngle('climb-a'));

    // The uuid is the drawer's navigation anchor — prev/next and the remaining
    // count are computed against it, so minting a fresh one would break both.
    expect(reanchored?.uuid).toBe('queue-item-1');
    expect(reanchored?.suggested).toBe(true);
    expect(reanchored?.climb.angle).toBe(50);
    expect(reanchored?.climb.difficulty).toBe('V6');
    expect(reanchored?.climb.quality_average).toBe('3.6');
    expect(reanchored?.climb.ascensionist_count).toBe(40);
    expect(reanchored?.climb.difficulty_error).toBe('0.2');
    // Nothing angle-specific about the name or the holds; they ride through.
    expect(reanchored?.climb.name).toBe('Crimpy Thing');
    expect(reanchored?.climb.frames).toBe('p1145r15');
  });

  it('clears a benchmark and a Boardsesh grade the new angle does not have', () => {
    // Explicit nulls, not omissions: carrying the previous angle's benchmark over
    // would put a grade on screen that nobody ever climbed at this angle.
    const reanchored = reanchorPreviewAtAngle(
      makeItem('climb-a', 40),
      50,
      makeClimbAtAngle('climb-a', {
        benchmark_difficulty: null,
        boardseshDifficulty: null,
        boardseshConfidence: null,
      } as Partial<Climb>),
    );

    expect(reanchored?.climb.benchmark_difficulty).toBeNull();
    expect(reanchored?.climb.boardseshDifficulty).toBeNull();
    expect(reanchored?.climb.boardseshConfidence).toBeNull();
  });

  it('ignores a response for a climb the climber has already swiped off', () => {
    const item = makeItem('climb-a', 40);
    // Same reference back, so the state updater is a no-op and the preview
    // doesn't flicker to a stranger's grade.
    expect(reanchorPreviewAtAngle(item, 50, makeClimbAtAngle('climb-b'))).toBe(item);
  });

  it('is a no-op when the item is already at the live angle', () => {
    const item = makeItem('climb-a', 50);
    expect(reanchorPreviewAtAngle(item, 50, makeClimbAtAngle('climb-a'))).toBe(item);
  });

  it('is a no-op with nothing pinned or nothing fetched', () => {
    const item = makeItem('climb-a', 40);
    expect(reanchorPreviewAtAngle(null, 50, makeClimbAtAngle('climb-a'))).toBeNull();
    expect(reanchorPreviewAtAngle(item, 50, null)).toBe(item);
    expect(reanchorPreviewAtAngle(item, 50, undefined)).toBe(item);
  });
});
