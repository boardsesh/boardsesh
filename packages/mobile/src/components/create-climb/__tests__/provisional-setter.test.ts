import { describe, expect, it } from 'vitest';
import { resolveProvisionalSetter } from '../provisional-setter';

describe('resolveProvisionalSetter', () => {
  const saver = { id: 'wall-owner', displayName: 'Wall Owner' };

  it('gives a new climb to the climber saving it', () => {
    expect(resolveProvisionalSetter(null, saver)).toEqual({ userId: 'wall-owner', setter_username: 'Wall Owner' });
  });

  it('keeps the original setter when a wall editor edits their climb', () => {
    const edited = { userId: 'setter-1', setter_username: 'Original Setter' };
    expect(resolveProvisionalSetter(edited, saver)).toEqual({ userId: 'setter-1', setter_username: 'Original Setter' });
  });

  it('does not hand a climb with no setter on record to the editor', () => {
    expect(resolveProvisionalSetter({ userId: null, setter_username: 'aurora_user' }, saver)).toEqual({
      userId: null,
      setter_username: 'aurora_user',
    });
  });

  it("keeps the saver's id on their own climb when the row carries no user id", () => {
    // What the editor queued before #5955: without this the Edit action would
    // vanish from a climber's own climb as soon as they saved it.
    expect(resolveProvisionalSetter({ userId: null, setter_username: 'Wall Owner' }, saver)).toEqual({
      userId: 'wall-owner',
      setter_username: 'Wall Owner',
    });
    expect(resolveProvisionalSetter({ setter_username: 'Wall Owner' }, saver).userId).toBe('wall-owner');
  });

  it('does not match two empty names', () => {
    expect(resolveProvisionalSetter({ userId: null, setter_username: '' }, { id: 'x', displayName: '' }).userId).toBe(
      null,
    );
    expect(resolveProvisionalSetter({ userId: null }, { id: 'x' }).userId).toBe(null);
  });

  it('falls back to the saver while the edited climb has not loaded, and to nobody before the profile has', () => {
    expect(resolveProvisionalSetter(undefined, saver).userId).toBe('wall-owner');
    expect(resolveProvisionalSetter(null, undefined)).toEqual({ userId: null, setter_username: '' });
  });
});
