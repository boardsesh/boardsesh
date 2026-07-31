import { describe, expect, it } from 'vite-plus/test';
import { parse, visit } from 'graphql';
import { typeDefs } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '../../queue-control/types';
import { toClimbQueueItemInput } from '../types';

/** Field names declared on the GraphQL `ClimbInput` type, read from the schema. */
function climbInputFieldNames(): Set<string> {
  const fields = new Set<string>();
  visit(parse(typeDefs.join('\n\n')), {
    InputObjectTypeDefinition(node) {
      if (node.name.value !== 'ClimbInput') return;
      for (const field of node.fields ?? []) fields.add(field.name.value);
    },
  });
  return fields;
}

function makeItem(overrides: Partial<ClimbQueueItem['climb']> = {}): ClimbQueueItem {
  return {
    uuid: 'item-1',
    climb: {
      uuid: 'climb-1',
      setter_username: 'setter',
      name: 'Proj Braj',
      description: '',
      frames: 'p1086r15p1113r15',
      angle: 40,
      ascensionist_count: 3,
      difficulty: 'V5',
      quality_average: '3.0',
      stars: 3,
      difficulty_error: '0.1',
      benchmark_difficulty: null,
      ...overrides,
    },
    addedBy: 'user-1',
    suggested: false,
  };
}

describe('toClimbQueueItemInput', () => {
  it('round-trips board identity so peers can classify spill climbs', () => {
    const input = toClimbQueueItemInput(makeItem({ boardType: 'kilter', layoutId: 1 }));
    expect(input.climb.boardType).toBe('kilter');
    expect(input.climb.layoutId).toBe(1);
  });

  it('sends null layoutId (not undefined) when the climb has no identity', () => {
    const input = toClimbQueueItemInput(makeItem({ boardType: undefined, layoutId: undefined }));
    expect(input.climb.boardType).toBeUndefined();
    expect(input.climb.layoutId).toBeNull();
  });

  it('round-trips the Boardsesh grade so party peers render it without a refetch', () => {
    const input = toClimbQueueItemInput(makeItem({ boardseshDifficulty: 19.2, boardseshConfidence: 'confirmed' }));
    expect(input.climb.boardseshDifficulty).toBe(19.2);
    expect(input.climb.boardseshConfidence).toBe('confirmed');
  });

  it('sends null Boardsesh grade fields (not undefined) when unavailable', () => {
    const input = toClimbQueueItemInput(makeItem({ boardseshDifficulty: undefined, boardseshConfidence: undefined }));
    expect(input.climb.boardseshDifficulty).toBeNull();
    expect(input.climb.boardseshConfidence).toBeNull();
  });

  // Both subscription selection sets SELECT these two, so omitting them from the
  // input made every web-originated write clear tags the peer was rendering.
  it('round-trips the no-match / characteristics tags peers already select', () => {
    const input = toClimbQueueItemInput(makeItem({ is_no_match: true, characteristics: ['method_footless'] }));
    expect(input.climb.is_no_match).toBe(true);
    expect(input.climb.characteristics).toEqual(['method_footless']);
  });

  // Drift guard (#3927). Derived from the schema, never hand-listed: a field
  // added to `ClimbInput` that web forgets to send here is a field web silently
  // clears on every write, and a field sent here that the schema doesn't declare
  // is rejected server-side. Both directions must stay closed, so this is set
  // EQUALITY rather than a subset check.
  it('sends exactly the field set the GraphQL ClimbInput declares', () => {
    const sent = new Set(Object.keys(toClimbQueueItemInput(makeItem()).climb));
    expect(sent).toEqual(climbInputFieldNames());
  });

  // The one non-passthrough coercion in web's climb mapper. Mobile sends
  // `description` raw, so the shared extraction had to keep web's own `|| ''`
  // rather than repoint web at mobile's mapper (#3995).
  it('sends an empty-string description rather than null when the climb has none', () => {
    const input = toClimbQueueItemInput(makeItem({ description: undefined }));
    expect(input.climb.description).toBe('');
  });
});

// The item level now delegates to `@boardsesh/queue-react/queue-item-input`,
// shared with mobile so the two platforms cannot drift apart again (#3995).
// These pin the delegation to zero behaviour change: a refactor that forgot a
// field, or coerced an absent `addedBy` to null, goes red here.
describe('toClimbQueueItemInput item-level attribution', () => {
  it('keeps the item-level attribution after the shared-mapper delegation', () => {
    const input = toClimbQueueItemInput({
      ...makeItem(),
      addedBy: 'client-1',
      addedByUser: { id: 'u1', username: 'Marco', avatarUrl: 'https://example.test/a.png' },
      tickedBy: ['u1', null],
      suggested: true,
    });

    expect(input.addedBy).toBe('client-1');
    expect(input.addedByUser).toEqual({ id: 'u1', username: 'Marco', avatarUrl: 'https://example.test/a.png' });
    // The wire input is `[String!]` — local nulls are dropped, not sent.
    expect(input.tickedBy).toEqual(['u1']);
    expect(input.suggested).toBe(true);
  });

  it('leaves an absent addedBy undefined rather than writing a null over a peer value', () => {
    const input = toClimbQueueItemInput({ ...makeItem(), addedBy: undefined, addedByUser: undefined });

    expect(input.addedBy).toBeUndefined();
    expect(input.addedByUser).toBeUndefined();
  });
});
