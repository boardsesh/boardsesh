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

  it('falls back to the saver while the edited climb has not loaded, and to nobody before the profile has', () => {
    expect(resolveProvisionalSetter(undefined, saver).userId).toBe('wall-owner');
    expect(resolveProvisionalSetter(null, undefined)).toEqual({ userId: null, setter_username: '' });
  });
});
