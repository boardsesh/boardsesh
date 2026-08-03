import { describe, expect, it } from 'vitest';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { boardPresenceClimbToClimb, wallDriverForClimb } from '../presence-climb';

const UNNAMED = 'Someone';

function climb(overrides: Partial<BoardPresenceClimb> = {}): BoardPresenceClimb {
  return {
    climbUuid: 'climb-1',
    seq: 1,
    sentAt: '2026-08-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('wallDriverForClimb', () => {
  it('uses the climber display name', () => {
    expect(wallDriverForClimb(climb({ sentByUserId: 'user-1', sentByDisplayName: 'Marco' }), UNNAMED)).toEqual({
      label: 'Marco',
      avatarName: 'Marco',
      isUnnamed: false,
    });
  });

  it('trims the display name so padding does not shift the row', () => {
    expect(wallDriverForClimb(climb({ sentByUserId: 'user-1', sentByDisplayName: '  Marco  ' }), UNNAMED)).toEqual({
      label: 'Marco',
      avatarName: 'Marco',
      isUnnamed: false,
    });
  });

  it.each([
    ['null', null],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('falls back for a %s display name so the row keeps its attribution', (_case, displayName) => {
    // The avatar name stays null on purpose: deriving initials from the
    // fallback label would put a meaningless letter on a stranger's face.
    expect(wallDriverForClimb(climb({ sentByUserId: 'user-1', sentByDisplayName: displayName }), UNNAMED)).toEqual({
      label: UNNAMED,
      avatarName: null,
      isUnnamed: true,
    });
  });

  it('renders nothing when there is no climber at all', () => {
    // An anonymous client, or a deleted account — no one to attribute to.
    expect(wallDriverForClimb(climb({ sentByUserId: null, sentByDisplayName: null }), UNNAMED)).toBeNull();
    expect(wallDriverForClimb(climb({ sentByDisplayName: 'Ghost' }), UNNAMED)?.label).toBe('Ghost');
    expect(wallDriverForClimb(climb(), UNNAMED)).toBeNull();
  });
});

describe('boardPresenceClimbToClimb', () => {
  it('fills the queue Climb shape, defaulting the fields presence does not carry', () => {
    const converted = boardPresenceClimbToClimb(
      climb({ name: 'Tumble Weed', frames: 'p1145r12', setter: 'kilterjackie', grade: 'V5', angle: 40 }),
    );
    expect(converted).toMatchObject({
      uuid: 'climb-1',
      name: 'Tumble Weed',
      frames: 'p1145r12',
      setter_username: 'kilterjackie',
      difficulty: 'V5',
      angle: 40,
    });
  });

  it('substitutes empty values rather than undefined so the thumbnail still renders', () => {
    expect(boardPresenceClimbToClimb(climb())).toMatchObject({
      name: '',
      frames: '',
      setter_username: '',
      difficulty: '',
      angle: 0,
    });
  });
});
