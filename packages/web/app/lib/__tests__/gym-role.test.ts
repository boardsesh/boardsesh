import { describe, it, expect } from 'vite-plus/test';
import type { Gym } from '@boardsesh/shared-schema';
import { resolveGymRole } from '../gym-role';

function makeGym(overrides?: Partial<Gym>): Gym {
  return {
    uuid: 'gym-1',
    slug: 'boulder-project',
    ownerId: 'owner-1',
    name: 'Boulder Project',
    isPublic: true,
    createdAt: '2024-01-01',
    boardCount: 3,
    boardTypes: ['kilter'],
    boardSummaries: [{ boardType: 'kilter', angle: 40 }],
    memberCount: 12,
    followerCount: 8,
    commentCount: 0,
    isFollowedByMe: false,
    isMember: true,
    canEdit: true,
    canGrantAccess: true,
    canClaim: false,
    isClaimed: true,
    canClaimByDomain: false,
    ...overrides,
  };
}

describe('resolveGymRole', () => {
  it('returns owner when the viewer owns the gym, outranking any myRole', () => {
    // The backend reports owners as gym admins, so owner must be checked first.
    expect(resolveGymRole(makeGym({ ownerId: 'me', myRole: 'admin' }), 'me')).toBe('owner');
  });

  it('returns the membership role when the viewer is not the owner', () => {
    expect(resolveGymRole(makeGym({ ownerId: 'someone-else', myRole: 'admin' }), 'me')).toBe('admin');
    expect(resolveGymRole(makeGym({ ownerId: 'someone-else', myRole: 'editor' }), 'me')).toBe('editor');
    expect(resolveGymRole(makeGym({ ownerId: 'someone-else', myRole: 'member' }), 'me')).toBe('member');
  });

  it('returns null for a gym the viewer only follows', () => {
    expect(resolveGymRole(makeGym({ ownerId: 'someone-else', myRole: null }), 'me')).toBeNull();
  });

  it('does not treat a null viewer id as the owner even if ownerId is falsy-ish', () => {
    expect(resolveGymRole(makeGym({ ownerId: 'owner-1', myRole: null }), null)).toBeNull();
  });
});
