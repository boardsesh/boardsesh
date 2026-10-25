import { describe, expect, it } from 'vitest';
import { CONFIDENCE } from '@boardsesh/db/queries/constants';
import { resolvers } from '../../index';
import { ClimbQueueItemSchema } from '../../../../validation/schemas/climbs';
import { resolveClimbNoMatchField } from '../climb-no-match-field';

const stub = { uuid: 'tick-climb-1', boardType: 'kilter', angle: 40, is_no_match: true };

function parseQueuedClimb(climb: Record<string, unknown>) {
  return ClimbQueueItemSchema.parse({ uuid: 'slot-1', climb }).climb;
}

describe('resolveClimbNoMatchField', () => {
  it('keeps the flag on a queued tick stub with no characteristics or description (#6681)', () => {
    expect(resolveClimbNoMatchField(parseQueuedClimb(stub))).toBe(true);
  });

  it('keeps the flag when a peer echo sends explicit nulls', () => {
    expect(resolveClimbNoMatchField(parseQueuedClimb({ ...stub, characteristics: null, description: null }))).toBe(
      true,
    );
  });

  it('keeps the flag on a feed stub that has a description but no characteristics', () => {
    expect(resolveClimbNoMatchField(parseQueuedClimb({ ...stub, description: 'Start low, finish at the top.' }))).toBe(
      true,
    );
  });

  it('falls back to false when a stub sends is_no_match null and no characteristics', () => {
    expect(resolveClimbNoMatchField(parseQueuedClimb({ ...stub, is_no_match: null }))).toBe(false);
  });

  it('is wired as Climb.is_no_match in the resolver map', () => {
    const resolveField = resolvers.Climb.is_no_match as (parent: unknown) => boolean;
    expect(resolveField(parseQueuedClimb(stub))).toBe(true);
  });

  it('lets characteristics win over the parent flag', () => {
    expect(resolveClimbNoMatchField({ ...stub, characteristics: [] })).toBe(false);
  });

  it('still recomputes from the description when there is no flag or characteristics', () => {
    expect(
      resolveClimbNoMatchField({
        boardType: 'kilter',
        description: 'Kick board is off. No matching.',
      }),
    ).toBe(true);
  });

  it('returns false for a DB row with neither input and no flag', () => {
    expect(resolveClimbNoMatchField({ boardType: 'kilter', characteristics: null, description: null })).toBe(false);
  });

  it('accepts a queue item for every confidence tier', () => {
    for (const tier of Object.values(CONFIDENCE)) {
      expect(parseQueuedClimb({ ...stub, boardseshConfidence: tier }).boardseshConfidence).toBe(tier);
    }
  });
});
