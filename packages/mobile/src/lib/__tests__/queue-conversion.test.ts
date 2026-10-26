import { describe, it, expect, vi } from 'vitest';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'generated-uuid' }));
import { buildSchema, coerceInputValue, graphql, isInputType, parse, visit } from 'graphql';
import { typeDefs } from '@boardsesh/shared-schema';
import { toClimbInput } from '../climb-to-queue-item';
import { toClimbQueueItem, type SubscriptionQueueItem } from '../queue-conversion';
import { GET_CLIMB, SUBSCRIPTION_CLIMB_FIELDS, SUBSCRIPTION_QUEUE_ITEM_FIELDS } from '../graphql/operations';

// Parse the selection set with graphql's own parser rather than splitting on
// whitespace: an alias (`uuid: id`), an argument, or a directive would make a
// naive split produce field names that don't exist, leaving the guard below
// green while silently comparing the wrong set. Mirrors `climbSelectionFieldNames`
// in the backend contract test.
function selectedClimbFieldNames(): Set<string> {
  const fields = new Set<string>();
  visit(parse(`{ climb { ${SUBSCRIPTION_CLIMB_FIELDS} } }`), {
    Field(node) {
      if (node.name.value !== 'climb' || !node.selectionSet) return;
      for (const selection of node.selectionSet.selections) {
        if (selection.kind === 'Field') fields.add(selection.alias?.value ?? selection.name.value);
      }
    },
  });
  return fields;
}

// Same collector, one level up: the top-level fields selected on each queue item.
function selectedQueueItemFieldNames(): Set<string> {
  const fields = new Set<string>();
  visit(parse(`{ item { ${SUBSCRIPTION_QUEUE_ITEM_FIELDS} } }`), {
    Field(node) {
      if (node.name.value !== 'item' || !node.selectionSet) return;
      for (const selection of node.selectionSet.selections) {
        if (selection.kind === 'Field') fields.add(selection.alias?.value ?? selection.name.value);
      }
    },
  });
  return fields;
}

// A reconnect FullSync wholesale-replaces the queue (and currentClimbQueueItem)
// from the subscription payload. If toClimbQueueItem drops a field the
// subscription now selects, the field is lost on every server-driven update:
// a peer-set `mirrored` flag (read by the Bluetooth auto-sender) gets cleared
// and multi-frame playback falls back to DEFAULT_PACE_MS instead of the
// setter's framesPace. These round-trips pin the four SEED-2 fields.

function makeSubscriptionItem(overrides: Partial<SubscriptionQueueItem['climb']> = {}): SubscriptionQueueItem {
  return {
    uuid: 'qi-1',
    climb: {
      uuid: 'climb-1',
      name: 'Variable Speed Circuit',
      frames: 'p1r12p2r13',
      setter_username: 'setter',
      angle: 40,
      ascensionist_count: 5,
      difficulty: '21',
      quality_average: '3.0',
      stars: 3,
      difficulty_error: '0.5',
      benchmark_difficulty: null,
      boardType: 'kilter',
      layoutId: 1,
      mirrored: true,
      is_no_match: true,
      framesCount: 4,
      framesPace: 1200,
      ...overrides,
    },
  };
}

describe('toClimbQueueItem (SEED-2 fields)', () => {
  it('carries mirrored, is_no_match, framesCount and framesPace through the conversion', () => {
    const result = toClimbQueueItem(makeSubscriptionItem());

    expect(result.climb.mirrored).toBe(true);
    expect(result.climb.is_no_match).toBe(true);
    expect(result.climb.framesCount).toBe(4);
    expect(result.climb.framesPace).toBe(1200);
  });

  it('preserves a peer-set mirror flag of false (not just truthy)', () => {
    const result = toClimbQueueItem(makeSubscriptionItem({ mirrored: false }));

    expect(result.climb.mirrored).toBe(false);
  });

  it('passes null/undefined frame metadata through unchanged', () => {
    const result = toClimbQueueItem(
      makeSubscriptionItem({ mirrored: null, is_no_match: null, framesCount: null, framesPace: null }),
    );

    expect(result.climb.mirrored).toBeNull();
    expect(result.climb.is_no_match).toBeNull();
    expect(result.climb.framesCount).toBeNull();
    expect(result.climb.framesPace).toBeNull();
  });

  it('carries boardType/layoutId so a peer-synced spill climb can be skipped on another board', () => {
    const result = toClimbQueueItem(makeSubscriptionItem({ boardType: 'tension', layoutId: 8 }));

    expect(result.climb.boardType).toBe('tension');
    expect(result.climb.layoutId).toBe(8);
  });

  it('leaves board metadata undefined when a pre-metadata peer omits it (treated as sendable)', () => {
    const result = toClimbQueueItem(makeSubscriptionItem({ boardType: undefined, layoutId: undefined }));

    expect(result.climb.boardType).toBeUndefined();
    // layoutId falls through as undefined; the spill guard reads nullish as "unknown".
    expect(result.climb.layoutId).toBeUndefined();
  });

  it('carries owner identity and draft state so Edit can be gated on a queued climb', () => {
    const result = toClimbQueueItem(
      makeSubscriptionItem({
        userId: 'user-1',
        description: 'crimpy',
        is_draft: false,
        published_at: '2026-07-01T00:00:00Z',
      }),
    );

    expect(result.climb.userId).toBe('user-1');
    expect(result.climb.description).toBe('crimpy');
    expect(result.climb.is_draft).toBe(false);
    expect(result.climb.published_at).toBe('2026-07-01T00:00:00Z');
  });

  // Drift guard (#3927). Derived from the live selection set, never hand-listed:
  // a field the subscription selects but this rebuild drops is silently lost on
  // every FullSync, and a field rebuilt here that the subscription does not
  // select can only ever be undefined. Set EQUALITY closes both directions, so
  // adding a sixth field to one side alone turns this red.
  it('rebuilds exactly the field set SUBSCRIPTION_CLIMB_FIELDS selects', () => {
    const rebuilt = new Set(Object.keys(toClimbQueueItem(makeSubscriptionItem()).climb));

    expect(rebuilt).toEqual(selectedClimbFieldNames());
  });
});

// The item level of the same contract (#3995). This client now WRITES
// addedBy / addedByUser / tickedBy / suggested, so dropping them on the way IN
// would make them flap: we would rebuild every peer item without an author, and
// our next full-queue write would push that gap back to the whole crew.
describe('toClimbQueueItem item-level attribution (#3995)', () => {
  it("keeps a web peer's attribution through the rebuild", () => {
    const result = toClimbQueueItem({
      ...makeSubscriptionItem(),
      addedBy: 'client-web-1',
      addedByUser: { id: 'web-peer', username: 'Ana', avatarUrl: 'https://example.test/a.png' },
      tickedBy: ['db-user-1'],
      suggested: true,
    });

    expect(result.addedBy).toBe('client-web-1');
    expect(result.addedByUser).toEqual({ id: 'web-peer', username: 'Ana', avatarUrl: 'https://example.test/a.png' });
    expect(result.tickedBy).toEqual(['db-user-1']);
    expect(result.suggested).toBe(true);
  });

  // The reducer's ClimbQueueItem types the last three as optional-not-nullable,
  // so a server null must narrow to undefined rather than be carried through.
  it('narrows server nulls to undefined for the optional-only fields', () => {
    const result = toClimbQueueItem({
      ...makeSubscriptionItem(),
      addedByUser: null,
      tickedBy: null,
      suggested: null,
    });

    expect(result.addedByUser).toBeUndefined();
    expect(result.tickedBy).toBeUndefined();
    expect(result.suggested).toBeUndefined();
  });

  // Set EQUALITY, derived from the live selection set: an item-level field the
  // subscription selects but this rebuild drops is lost on every FullSync, and a
  // field rebuilt here that the subscription does not select can only ever be
  // undefined. Adding a seventh field to one side alone turns this red.
  it('rebuilds exactly the field set SUBSCRIPTION_QUEUE_ITEM_FIELDS selects', () => {
    const rebuilt = new Set(Object.keys(toClimbQueueItem(makeSubscriptionItem())));

    expect(rebuilt).toEqual(selectedQueueItemFieldNames());
  });
});

describe('required hold-set subscription roundtrip', () => {
  it.each([[1, 20], null, undefined, []].map((requiredSetIds) => ({ requiredSetIds })))(
    'keeps %j through subscription, outbound input, and a peer JSON payload',
    ({ requiredSetIds }) => {
      const source = makeSubscriptionItem({ requiredSetIds });
      const current = toClimbQueueItem(source);
      const input = toClimbInput(current.climb);
      const peerPayload: SubscriptionQueueItem = JSON.parse(JSON.stringify({ ...source, climb: input }));
      expect(toClimbQueueItem(peerPayload).climb.requiredSetIds).toEqual(requiredSetIds);
      expect(selectedClimbFieldNames().has('requiredSetIds')).toBe(true);
    },
  );
});

it.each([[1, 20], null].map((requiredSetIds) => ({ requiredSetIds })))(
  'roundtrips %j through real GraphQL read selections and input coercion',
  async ({ requiredSetIds }) => {
    const schema = buildSchema(typeDefs.join('\n\n'));
    const source = makeSubscriptionItem({ requiredSetIds }).climb;
    const variableValues = {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 5,
      setIds: '1,20',
      angle: 40,
      climbUuid: source.uuid,
    };
    const read = await graphql({ schema, source: GET_CLIMB, rootValue: { climb: () => source }, variableValues });
    expect(read.errors).toBeUndefined();
    const readClimb = read.data?.climb as SubscriptionQueueItem['climb'];
    const queued = toClimbQueueItem({ uuid: 'qi-read', climb: readClimb });
    const input = toClimbInput(queued.climb);
    const inputType = schema.getType('ClimbInput');
    if (!inputType || !isInputType(inputType)) throw new Error('Missing ClimbInput schema');
    const acceptedInput: unknown = coerceInputValue(JSON.parse(JSON.stringify(input)), inputType);
    const peerRead = await graphql({
      schema,
      source: GET_CLIMB,
      rootValue: { climb: () => acceptedInput },
      variableValues,
    });
    expect(peerRead.errors).toBeUndefined();
    expect(
      toClimbQueueItem({ uuid: 'qi-peer', climb: peerRead.data?.climb as SubscriptionQueueItem['climb'] }).climb
        .requiredSetIds,
    ).toEqual(requiredSetIds);
  },
);
