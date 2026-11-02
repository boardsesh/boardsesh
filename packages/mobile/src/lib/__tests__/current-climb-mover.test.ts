import { describe, expect, it } from 'vitest';
import { resolveCurrentClimbMoverFace } from '../current-climb-mover';

describe('current climb mover', () => {
  const identity = {
    currentChangedBy: 'participant-sam',
    participantId: 'participant-self',
    sessionUsers: [{ id: 'participant-sam', username: ' Sam ', avatarUrl: 'sam.png' }],
  };

  it('resolves the participant through the projected roster', () => {
    expect(resolveCurrentClimbMoverFace(identity)).toEqual({ username: 'Sam', avatarUrl: 'sam.png' });
  });

  it('keeps a named mover without an avatar available', () => {
    expect(
      resolveCurrentClimbMoverFace({
        ...identity,
        sessionUsers: [{ id: 'participant-sam', username: 'Sam' }],
      }),
    ).toEqual({ username: 'Sam', avatarUrl: null });
  });

  it.each([
    { currentChangedBy: null },
    { participantId: null },
    { currentChangedBy: 'participant-self' },
    { currentChangedBy: 'account-sam' },
    { sessionUsers: [] },
    { sessionUsers: [{ id: 'participant-sam', username: '  ' }] },
  ])('keeps unavailable and self identities unnamed: %j', (overrides) => {
    expect(resolveCurrentClimbMoverFace({ ...identity, ...overrides })).toBeNull();
  });
});
