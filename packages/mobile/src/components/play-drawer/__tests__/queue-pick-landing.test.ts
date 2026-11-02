import type { ClimbQueueItem } from '@boardsesh/queue';
import { describe, expect, it, vi } from 'vitest';

// The tap-time reader's lighting rule pulls in the queue provider; the pure
// resolver under test takes the rule's answer as an input instead.
vi.mock('../use-climb-change-lights', () => ({ isDrivingWall: () => false }));

import { resolveQueuePickLanding, type QueuePickLanding } from '../queue-pick-landing';

function entry(uuid: string, climbUuid: string, mirrored = false): ClimbQueueItem {
  return { uuid, climb: { uuid: climbUuid, mirrored }, suggested: false } as unknown as ClimbQueueItem;
}

const NOW = entry('now-slot', 'climb-up');

type Row = {
  label: string;
  picked: ClimbQueueItem;
  current?: ClimbQueueItem | null;
  lightsOnPick?: boolean;
  inSharedSession?: boolean;
  heldQueueItemUuid?: string | null;
  expected: QueuePickLanding;
};

const ROWS: Row[] = [
  { label: 'another climb, preview-first', picked: entry('up-next', 'climb-other'), expected: 'preview' },
  { label: 'any pick with nothing up', picked: entry('up-next', 'climb-up'), current: null, expected: 'preview' },
  { label: 'a copy of the climb up, solo, not held', picked: entry('history-copy', 'climb-up'), expected: 'commit' },
  { label: 'the Now slot itself', picked: NOW, expected: 'reopen' },
  {
    label: 'a copy of the climb up while it is held',
    picked: entry('history-copy', 'climb-up'),
    heldQueueItemUuid: 'now-slot',
    expected: 'reopen',
  },
  {
    label: 'a copy of the climb up while another entry is held',
    picked: entry('history-copy', 'climb-up'),
    heldQueueItemUuid: 'gone-slot',
    expected: 'commit',
  },
  {
    label: 'a copy of the climb up in a crew',
    picked: entry('history-copy', 'climb-up'),
    inSharedSession: true,
    expected: 'reopen',
  },
  // A preview of the other orientation would have no Put on board, and the
  // board control would light or let go of the climb up instead.
  {
    label: 'a copy of the climb up in the other orientation, solo',
    picked: entry('history-copy', 'climb-up', true),
    expected: 'commit',
  },
  {
    label: 'the climb up mirrored, picked unmirrored',
    picked: entry('history-copy', 'climb-up'),
    current: entry('now-slot', 'climb-up', true),
    expected: 'commit',
  },
  {
    label: 'a copy of the climb up in the other orientation, in a crew',
    picked: entry('history-copy', 'climb-up', true),
    inSharedSession: true,
    expected: 'reopen',
  },
  {
    label: 'a copy of the climb up in the other orientation while it is held',
    picked: entry('history-copy', 'climb-up', true),
    heldQueueItemUuid: 'now-slot',
    expected: 'reopen',
  },
  {
    label: 'any pick with automatic lighting on, held climb included',
    picked: NOW,
    lightsOnPick: true,
    heldQueueItemUuid: 'now-slot',
    expected: 'commit',
  },
  {
    label: 'another climb with automatic lighting on',
    picked: entry('up-next', 'climb-other'),
    lightsOnPick: true,
    expected: 'commit',
  },
];

describe('resolveQueuePickLanding', () => {
  it.each(ROWS)('$label: $expected', (row) => {
    expect(
      resolveQueuePickLanding({
        picked: row.picked,
        current: row.current === undefined ? NOW : row.current,
        lightsOnPick: row.lightsOnPick ?? false,
        inSharedSession: row.inSharedSession ?? false,
        heldQueueItemUuid: row.heldQueueItemUuid ?? null,
      }),
    ).toBe(row.expected);
  });
});
