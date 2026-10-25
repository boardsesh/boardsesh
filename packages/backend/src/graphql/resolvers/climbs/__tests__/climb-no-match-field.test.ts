import { describe, expect, it } from 'vitest';
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

  it('lets characteristics win over the parent flag', () => {
    expect(resolveClimbNoMatchField({ ...stub, characteristics: [] })).toBe(false);
  });

  it('still recomputes from the description when one is present', () => {
    expect(
      resolveClimbNoMatchField({
        boardType: 'kilter',
        is_no_match: false,
        description: 'Kick board is off. No matching.',
      }),
    ).toBe(true);
  });

  it('returns false for a DB row with neither input and no flag', () => {
    expect(resolveClimbNoMatchField({ boardType: 'kilter', characteristics: null, description: null })).toBe(false);
  });
});
