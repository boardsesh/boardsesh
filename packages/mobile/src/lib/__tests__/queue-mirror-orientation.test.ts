import { describe, expect, it } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { resolveTickMirror, unambiguousQueueMirror } from '../queue-mirror-orientation';

function occurrence(uuid: string, mirrored: boolean): ClimbQueueItem {
  return { uuid, climb: { uuid: 'climb-a', mirrored } } as ClimbQueueItem;
}

describe('occurrence mirror resolution', () => {
  it('resolves history by occurrence instead of borrowing another copy on the wall', () => {
    const history = occurrence('history', true);
    const current = occurrence('current', false);
    const snapshot = { queue: [history, current], currentClimbQueueItem: current };
    expect(resolveTickMirror(snapshot, history.climb, history.uuid)).toBe(true);
    expect(resolveTickMirror(snapshot, history.climb, current.uuid)).toBe(false);
    expect(resolveTickMirror(snapshot, history.climb, 'removed')).toBe(true);
    expect(resolveTickMirror(snapshot, history.climb, undefined, false)).toBe(true);
  });

  it('never guesses a legacy presence orientation between repeated occurrences', () => {
    const first = occurrence('first', true);
    const second = occurrence('second', false);
    expect(
      unambiguousQueueMirror({ queue: [first, second], currentClimbQueueItem: second }, 'climb-a'),
    ).toBeUndefined();
  });

  it('deduplicates current and queue copies by occurrence, preferring the current copy', () => {
    const old = occurrence('same-slot', true);
    const current = occurrence('same-slot', false);
    expect(unambiguousQueueMirror({ queue: [old], currentClimbQueueItem: current }, 'climb-a')).toBe(false);
  });

  it('supports a current-only occurrence and distinguishes missing from explicit false', () => {
    const current = occurrence('outside-queue', false);
    expect(unambiguousQueueMirror({ queue: [], currentClimbQueueItem: current }, 'climb-a')).toBe(false);
    expect(unambiguousQueueMirror({ queue: [], currentClimbQueueItem: current }, 'other-climb')).toBeUndefined();
    expect(unambiguousQueueMirror({ queue: [], currentClimbQueueItem: null }, undefined)).toBeUndefined();
  });
});
