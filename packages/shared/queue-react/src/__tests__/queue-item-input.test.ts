import { describe, expect, it } from 'vitest';
import type { ClimbInput } from '@boardsesh/shared-schema';
import { toClimbQueueItemInput, WIRE_ITEM_FIELDS, type WireBoundQueueItem } from '../queue-item-input';

// The item level of the queue wire contract (#3995). Mobile used to send only
// `{ uuid, climb }` here, so every climb queued from a phone reached peers with
// no author — and a phone's next full-queue write stripped the attribution off
// the climbs the crew queued from web. These assertions run the REAL mapper; the
// climb half is stubbed to an identity so nothing here re-implements what it
// checks.

type StubClimb = { uuid: string };
const identityClimbInput = (climb: StubClimb): ClimbInput => climb as unknown as ClimbInput;

function makeItem(overrides: Partial<WireBoundQueueItem<StubClimb>> = {}): WireBoundQueueItem<StubClimb> {
  return {
    uuid: 'queue-slot-1',
    climb: { uuid: 'climb-1' },
    addedBy: 'client-1',
    addedByUser: { id: 'u1', username: 'Marco', avatarUrl: 'https://example.test/a.png' },
    tickedBy: ['u1'],
    suggested: true,
    ...overrides,
  };
}

describe('toClimbQueueItemInput', () => {
  it('carries the item-level fields onto the wire', () => {
    const input = toClimbQueueItemInput(makeItem(), identityClimbInput);

    expect(input.addedBy).toBe('client-1');
    expect(input.addedByUser).toEqual({ id: 'u1', username: 'Marco', avatarUrl: 'https://example.test/a.png' });
    expect(input.tickedBy).toEqual(['u1']);
    expect(input.suggested).toBe(true);
  });

  it('maps the climb through the platform mapper it was given', () => {
    const input = toClimbQueueItemInput(makeItem(), identityClimbInput);

    expect(input.uuid).toBe('queue-slot-1');
    expect(input.climb).toEqual({ uuid: 'climb-1' });
  });

  // #4828: `myDifficulty` is the signed-in climber's OWN grade. A queue item's
  // climb is broadcast verbatim to every peer, so a mapper that ever spreads a
  // climb instead of enumerating its fields would publish one climber's private
  // opinion onto everyone else's row. This seam strips it regardless.
  it('strips the private per-climber grade even when the platform mapper spreads', () => {
    const spreadingClimbInput = (climb: StubClimb): ClimbInput => ({ ...climb }) as unknown as ClimbInput;
    const input = toClimbQueueItemInput(
      makeItem({ climb: { uuid: 'climb-1', myDifficulty: 27 } as StubClimb }),
      spreadingClimbInput,
    );

    expect('myDifficulty' in input.climb).toBe(false);
    expect(input.climb).toEqual({ uuid: 'climb-1' });
  });

  // The wire type is `[String!]` — a null entry would be rejected outright.
  it('drops null entries from tickedBy', () => {
    const input = toClimbQueueItemInput(makeItem({ tickedBy: ['u1', null] }), identityClimbInput);

    expect(input.tickedBy).toEqual(['u1']);
  });

  // Pins the web-parity decision: web has always sent `undefined` here, and a
  // `?? null` coercion would write a null over whatever the server holds.
  it('leaves an absent addedBy absent rather than coercing it to null', () => {
    const input = toClimbQueueItemInput(makeItem({ addedBy: undefined }), identityClimbInput);

    expect(input.addedBy).toBeUndefined();
    expect(input.addedBy).not.toBeNull();
  });

  it('omits addedByUser entirely when the item has no author', () => {
    const input = toClimbQueueItemInput(makeItem({ addedByUser: undefined }), identityClimbInput);

    expect(input.addedByUser).toBeUndefined();
  });

  // Drift guard, read live off the mapper's own output and the `satisfies
  // Record<keyof ClimbQueueItemInput, true>` guard. A dropped field fails here;
  // a field ADDED to the GraphQL input without teaching the mapper fails
  // typecheck on WIRE_ITEM_FIELDS. Neither side can be hand-edited into
  // agreement with a stale list.
  it('emits exactly the ClimbQueueItemInput field set', () => {
    const emitted = new Set(Object.keys(toClimbQueueItemInput(makeItem(), identityClimbInput)));

    expect(emitted).toEqual(new Set(Object.keys(WIRE_ITEM_FIELDS)));
  });
});
