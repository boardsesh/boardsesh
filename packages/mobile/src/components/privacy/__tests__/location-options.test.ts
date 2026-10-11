import { describe, expect, it } from 'vitest';
import { locationOptions } from '../location-options';

describe('locationOptions', () => {
  it('offers no Followers choice for an exact location', () => {
    for (const current of ['only_me', 'members', 'public'] as const) {
      expect(locationOptions(current)).toEqual(['only_me', 'members', 'public']);
    }
  });

  it('still shows Followers on a board that already uses it, so the owner can move off it', () => {
    expect(locationOptions('followers')).toEqual(['only_me', 'followers', 'members', 'public']);
  });
});
