import { describe, expect, it } from 'vitest';
import { showsFriendsListSwitch } from '../friends-list-switch';

describe('showsFriendsListSwitch', () => {
  it('is offered for Unlisted and Invite-only home boards', () => {
    expect(showsFriendsListSwitch('unlisted', false)).toBe(true);
    expect(showsFriendsListSwitch('invite_only', false)).toBe(true);
  });

  it('is hidden where followers already see the board, or nobody should', () => {
    expect(showsFriendsListSwitch('public', false)).toBe(false);
    expect(showsFriendsListSwitch('followers', false)).toBe(false);
    expect(showsFriendsListSwitch('only_me', false)).toBe(false);
  });

  it('is never offered for a spray wall', () => {
    expect(showsFriendsListSwitch('unlisted', true)).toBe(false);
    expect(showsFriendsListSwitch('invite_only', true)).toBe(false);
  });
});
