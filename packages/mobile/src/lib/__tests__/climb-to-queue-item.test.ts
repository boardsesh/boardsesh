import { describe, it, expect, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'generated-uuid',
}));

import {
  QUEUE_LOCAL_ONLY_CLIMB_FIELDS,
  climbToQueueItem,
  toClimbInput,
  toQueueItemWireInput,
} from '../climb-to-queue-item';

// A climb queued from search / detail must keep its multi-frame playback
// metadata so playback uses the setter's pace rather than DEFAULT_PACE_MS.
// climbToQueueItem hand-picks the climb fields (a whole-response copy would
// fail server validation), so dropping framesCount/framesPace silently regresses
// pacing. This round-trip pins them.

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'climb-1',
    setter_username: 'setter',
    name: 'Variable Speed Circuit',
    frames: 'p1r12p2r13',
    angle: 40,
    ascensionist_count: 5,
    difficulty: '21',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
    is_no_match: false,
    userAscents: null,
    userAttempts: null,
    framesCount: 4,
    framesPace: 1200,
    ...overrides,
  };
}

describe('climbToQueueItem (SEED-2 frame metadata)', () => {
  it('carries framesCount and framesPace from the source climb', () => {
    const result = climbToQueueItem(makeClimb());

    expect(result.climb.framesCount).toBe(4);
    expect(result.climb.framesPace).toBe(1200);
  });

  it('passes null frame metadata through unchanged (static climb)', () => {
    const result = climbToQueueItem(makeClimb({ framesCount: null, framesPace: null }));

    expect(result.climb.framesCount).toBeNull();
    expect(result.climb.framesPace).toBeNull();
  });
});

describe('climbToQueueItem ownership / draft state (#3927)', () => {
  it('carries the fields the owner-only Edit gate reads', () => {
    const result = climbToQueueItem(
      makeClimb({
        userId: 'user-1',
        description: 'crimpy',
        mirrored: true,
        is_draft: false,
        published_at: '2026-07-01T00:00:00Z',
      }),
    );

    expect(result.climb).toMatchObject({
      userId: 'user-1',
      description: 'crimpy',
      mirrored: true,
      is_draft: false,
      published_at: '2026-07-01T00:00:00Z',
    });
  });

  /**
   * The sharpest guard in the #3927 fix, and the one that needs no allowlist.
   *
   * `toClimbInput` is what this client SENDS to peers; `climbToQueueItem` is what
   * it keeps LOCALLY. A field in one but not the other is a bug in whichever
   * direction it points:
   *
   *   - in `toClimbInput` only  -> the local item never has it, so we broadcast a
   *     null over whatever a peer had, clearing it for everyone.
   *   - in `climbToQueueItem` only -> we render it locally but never send it, so
   *     it silently vanishes for every peer and for us on the next FullSync.
   *
   * They must be the same set. Both are read live via `Object.keys`, so a sixth
   * field added to one side only turns this red with no edit to this test — which
   * is precisely what did NOT happen when these two drifted apart and produced
   * #3927.
   */
  it('keeps exactly the same field set as toClimbInput', () => {
    const climb = makeClimb();
    const kept = new Set(Object.keys(climbToQueueItem(climb).climb));
    const sent = new Set(Object.keys(toClimbInput(climb)));
    // The one named exception (#6023): the climb's version numbers stay on the
    // local item and are not sent, because no queue document can select them
    // while the screenshot fixtures pin those documents. Everything else must
    // still match, read live off both functions.
    for (const localOnlyField of QUEUE_LOCAL_ONLY_CLIMB_FIELDS) kept.delete(localOnlyField);

    expect(kept).toEqual(sent);
  });

  it('keeps the climb version numbers on the queued item and off the wire (#6023)', () => {
    const climb = { ...makeClimb(), revisionNumber: 4, holdsRevisionNumber: 3 };
    const item = climbToQueueItem(climb);

    expect(item.climb.revisionNumber).toBe(4);
    expect(item.climb.holdsRevisionNumber).toBe(3);

    // Re-deriving an item from a queued climb keeps them (the play-drawer open
    // and the climb-actions preview both rebuild an item this way).
    const requeued = climbToQueueItem(item.climb as unknown as Climb);
    expect(requeued.climb.revisionNumber).toBe(4);
    expect(requeued.climb.holdsRevisionNumber).toBe(3);

    // An older backend rejects an input field it does not know, and that would
    // fail the whole queue mutation.
    const wireClimb = toQueueItemWireInput(item).climb;
    for (const localOnlyField of QUEUE_LOCAL_ONLY_CLIMB_FIELDS) {
      expect(localOnlyField in toClimbInput(climb)).toBe(false);
      expect(localOnlyField in wireClimb).toBe(false);
    }
  });

  it('leaves the version numbers unknown on a climb that has none', () => {
    const item = climbToQueueItem(makeClimb());

    expect(item.climb.revisionNumber).toBeUndefined();
    expect(item.climb.holdsRevisionNumber).toBeUndefined();
  });
});

// The same contract, one level up (#3995). This client used to send a bare
// `{ uuid, climb }` for every queue mutation, so a climb queued from a phone
// reached the crew with no author, and the phone's next full-queue write wiped
// the "added by" avatars off the climbs they queued from web.
describe('toQueueItemWireInput (#3995)', () => {
  it('carries queue-item attribution, not just the climb', () => {
    const input = toQueueItemWireInput({
      uuid: 'queue-slot-1',
      climb: makeClimb(),
      addedBy: 'client-1',
      addedByUser: { id: 'party-uuid-1', username: 'Marco', avatarUrl: 'https://example.test/a.png' },
      tickedBy: ['db-user-1'],
      suggested: true,
    });

    expect(input.addedBy).toBe('client-1');
    expect(input.addedByUser).toEqual({
      id: 'party-uuid-1',
      username: 'Marco',
      avatarUrl: 'https://example.test/a.png',
    });
    expect(input.tickedBy).toEqual(['db-user-1']);
    expect(input.suggested).toBe(true);
  });

  // The climb half must still go out in full: the item-level fix must not have
  // narrowed what `toClimbInput` sends. Read live off both functions, same
  // technique as the climb-level guard above.
  it('still sends the full toClimbInput climb field set', () => {
    const climb = makeClimb();
    const sentOnTheWire = new Set(Object.keys(toQueueItemWireInput({ uuid: 'queue-slot-1', climb }).climb));

    expect(sentOnTheWire).toEqual(new Set(Object.keys(toClimbInput(climb))));
  });
});
