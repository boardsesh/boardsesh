import { describe, expect, it } from 'vitest';
import { showsFriendsListSwitch } from '../friends-list-switch';

describe('showsFriendsListSwitch', () => {
  it('is offered for Unlisted and Invite-only home boards', () => {
    expect(showsFriendsListSwitch('unlisted', false, null, 'owner')).toBe(true);
    expect(showsFriendsListSwitch('invite_only', false, null, 'owner')).toBe(true);
  });

  it('is hidden where followers already see the board, or nobody should', () => {
    expect(showsFriendsListSwitch('public', false, null, 'owner')).toBe(false);
    expect(showsFriendsListSwitch('followers', false, null, 'owner')).toBe(false);
    expect(showsFriendsListSwitch('only_me', false, null, 'owner')).toBe(false);
  });

  it('is never offered for a spray wall', () => {
    expect(showsFriendsListSwitch('unlisted', true, null, 'owner')).toBe(false);
    expect(showsFriendsListSwitch('invite_only', true, null, 'owner')).toBe(false);
  });

  it("is offered at a gym only when it is the owner's own gym and not public and listed", () => {
    const gym = { ownerId: 'owner', isPublic: false, isListed: false };
    expect(showsFriendsListSwitch('unlisted', false, gym, 'owner')).toBe(true);
    expect(showsFriendsListSwitch('unlisted', false, { ...gym, isPublic: true }, 'owner')).toBe(true);
    expect(showsFriendsListSwitch('unlisted', false, { ...gym, isPublic: true, isListed: true }, 'owner')).toBe(false);
    expect(showsFriendsListSwitch('invite_only', false, { ...gym, ownerId: 'someone-else' }, 'owner')).toBe(false);
  });

  it('waits for the gym before offering it', () => {
    expect(showsFriendsListSwitch('unlisted', false, undefined, 'owner')).toBe(false);
    expect(showsFriendsListSwitch('unlisted', false, null, 'owner')).toBe(true);
  });
});
