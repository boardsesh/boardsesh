// The one rule standing between a browse and a broken party queue.
//
// `findNextQueueItemWithSuggestions` hands the drawer a synthetic
// `playlist-peek:<climbUuid>` item for the next-up suggestion. It is a rendering
// device — it is NOT in the queue — and `toQueueItemWireInput` puts `item.uuid`
// on the wire verbatim. Committing one straight broadcasts a uuid no peer can
// reconcile against their own queue.
//
// Until the shared-session browse latch, only `nextClimb()` could reach a peek,
// and it laundered it inline. Browsing now walks a suggestion track item by item
// with a "Put on the wall" button pointed at whatever is on screen, so the drawer
// reaches one routinely. Hence one helper, one test.
import { describe, it, expect, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { getPlaylistPeekQueueItemUuid } from '@boardsesh/queue';
import type { Climb } from '@boardsesh/shared-schema';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'minted-uuid' }));

const { resolveCommittableQueueItem } = await import('../climb-to-queue-item');

function makeClimb(uuid: string): Climb {
  return {
    uuid,
    setter_username: 'setter',
    name: 'Peeked Climb',
    frames: 'p1145r15',
    angle: 40,
    ascensionist_count: 5,
    difficulty: '21',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
    framesCount: 3,
    framesPace: 900,
  } as unknown as Climb;
}

function makeItem(uuid: string, climbUuid: string): ClimbQueueItem {
  return { uuid, climb: makeClimb(climbUuid) } as unknown as ClimbQueueItem;
}

describe('resolveCommittableQueueItem', () => {
  it('mints a real item for a playlist peek, so no synthetic uuid reaches the wire', () => {
    const peekUuid = getPlaylistPeekQueueItemUuid('climb-a');
    const { item, converted } = resolveCommittableQueueItem(makeItem(peekUuid, 'climb-a'));

    expect(converted).toBe(true);
    expect(item.uuid).toBe('minted-uuid');
    expect(item.uuid.startsWith('playlist-peek:')).toBe(false);
    // Same climb, so the climber commits what they were looking at.
    expect(item.climb.uuid).toBe('climb-a');
    // Suggestion-origin is preserved: pruning after the next navigation has to
    // keep treating it as a suggestion, not as a climb the crew hand-queued.
    expect(item.suggested).toBe(true);
  });

  it('carries the climb through intact, not a stub', () => {
    const { item } = resolveCommittableQueueItem(makeItem(getPlaylistPeekQueueItemUuid('climb-a'), 'climb-a'));
    // The pace metadata is the field a hand-rolled `{uuid, climb: {uuid, name}}`
    // rebuild would quietly drop, sending route playback back to DEFAULT_PACE_MS.
    expect(item.climb.framesCount).toBe(3);
    expect(item.climb.framesPace).toBe(900);
  });

  it('leaves a real queue item exactly as it is — same reference, no new uuid', () => {
    const real = makeItem('queue-item-1', 'climb-b');
    const { item, converted } = resolveCommittableQueueItem(real);

    expect(converted).toBe(false);
    // Identity, not equality: the item is already IN the queue, and re-minting it
    // would orphan the drawer's navigation anchor and duplicate the entry.
    expect(item).toBe(real);
  });

  it('does not treat a uuid that merely contains the marker as a peek', () => {
    const { converted } = resolveCommittableQueueItem(makeItem('real-playlist-peek:climb-c', 'climb-c'));
    expect(converted).toBe(false);
  });
});
