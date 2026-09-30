import { describe, expect, it } from 'vitest';
import { PRIVATE_CLIMB_FIELDS, stripPrivateClimbFields } from '../event-utils';

/**
 * A queue item's `climb` is broadcast verbatim to every peer in a party session
 * — that is the whole point of carrying the grade fields on it (a peer renders
 * the climb without a refetch). So anything left on that climb is published.
 *
 * `myDifficulty` (#4796 / #4828) is the grade the SIGNED-IN climber gave the
 * climb themselves. It is one person's opinion, not a property of the climb, and
 * a peer seeing "V10" because someone else in the session graded it V10 is worse
 * than seeing nothing: it is unattributed, wrong for them, and their next
 * full-queue write pushes it back to everyone.
 */
describe('private climb fields never reach the party queue', () => {
  const gradedClimb = {
    uuid: 'climb-1',
    name: 'Sandbagged',
    angle: 40,
    difficulty: 'V0',
    boardseshDifficulty: 12.4,
    myDifficulty: 27,
  };

  it('names myDifficulty as private', () => {
    expect(PRIVATE_CLIMB_FIELDS).toContain('myDifficulty');
  });

  it('strips myDifficulty off a climb, keeping everything else byte-identical', () => {
    const stripped = stripPrivateClimbFields(gradedClimb);

    expect('myDifficulty' in stripped).toBe(false);
    expect(stripped).toEqual({
      uuid: 'climb-1',
      name: 'Sandbagged',
      angle: 40,
      difficulty: 'V0',
      boardseshDifficulty: 12.4,
    });
    // The source object is not mutated — the local queue keeps showing the
    // climber their own grade; only the copy that goes on the wire loses it.
    expect(gradedClimb.myDifficulty).toBe(27);
  });

  it('strips a difficulty of 0, which is a real grade id and not an absence', () => {
    const stripped = stripPrivateClimbFields({ uuid: 'climb-2', myDifficulty: 0 });
    expect('myDifficulty' in stripped).toBe(false);
  });

  it('strips an explicit null too, so a peer cannot even learn that a grade slot exists', () => {
    const stripped = stripPrivateClimbFields({ uuid: 'climb-3', myDifficulty: null });
    expect('myDifficulty' in stripped).toBe(false);
  });

  it('strips every field the private list names, not just myDifficulty', () => {
    const climb = Object.fromEntries([['uuid', 'climb-4'], ...PRIVATE_CLIMB_FIELDS.map((field) => [field, 1])] as Array<
      [string, unknown]
    >);
    const stripped = stripPrivateClimbFields(climb);

    for (const field of PRIVATE_CLIMB_FIELDS) expect(field in stripped).toBe(false);
    expect(stripped).toEqual({ uuid: 'climb-4' });
  });

  it('returns the same reference when there is nothing to strip', () => {
    const climb = { uuid: 'climb-5', name: 'Clean' };
    expect(stripPrivateClimbFields(climb)).toBe(climb);
  });
});
