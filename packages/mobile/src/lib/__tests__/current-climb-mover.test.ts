import { describe, expect, it } from 'vitest';
import { resolveCurrentClimbMoverName } from '../current-climb-mover';

describe('current climb mover', () => {
  const identity = {
    currentChangedBy: 'participant-sam',
    participantId: 'participant-self',
    sessionUsers: [{ id: 'participant-sam', username: ' Sam ' }],
  };

  it('resolves the participant through the projected roster', () => {
    expect(resolveCurrentClimbMoverName(identity)).toBe('Sam');
  });

  it.each([
    { currentChangedBy: null },
    { participantId: null },
    { currentChangedBy: 'participant-self' },
    { currentChangedBy: 'account-sam' },
    { sessionUsers: [] },
    { sessionUsers: [{ id: 'participant-sam', username: '  ' }] },
  ])('keeps unavailable and self identities unnamed: %j', (overrides) => {
    expect(resolveCurrentClimbMoverName({ ...identity, ...overrides })).toBeNull();
  });
});
