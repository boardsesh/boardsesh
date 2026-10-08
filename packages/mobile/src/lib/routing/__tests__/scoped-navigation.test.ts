import { describe, expect, it, vi } from 'vitest';
vi.mock('expo-router', () => ({ router: undefined, useRouter: vi.fn() }));
import { publishNavigationScope, resolveScopedDestination } from '../scoped-navigation';

describe('navigation keeps the originating tab', () => {
  it('scopes user drilling and Settings into each existing tab stack', () => {
    for (const tab of ['home', 'climbs', 'record', 'discover', 'profile', 'wall']) {
      publishNavigationScope(['(tabs)', tab]);
      expect(resolveScopedDestination('/users/search')).toBe(`/(tabs)/${tab}/users/search`);
      expect(resolveScopedDestination({ pathname: '/users/[userId]', params: { userId: 'climber-1' } })).toEqual({
        pathname: `/(tabs)/${tab}/users/[userId]`,
        params: { userId: 'climber-1' },
      });
      expect(resolveScopedDestination('/settings/storage')).toBe(`/(tabs)/${tab}/settings/storage`);
    }
  });
  it('keeps Account Settings inside the modal and leaves unrelated destinations intact', () => {
    publishNavigationScope(['(tabs)', 'home']);
    publishNavigationScope(['account']);
    expect(resolveScopedDestination('/settings/edit')).toBe('/account/settings/edit');
    expect(resolveScopedDestination('/users/search')).toBe('/users/search');
    expect(resolveScopedDestination('/boards')).toBe('/boards');
    expect(resolveScopedDestination('/(tabs)/discover/all')).toBe('/(tabs)/discover/all');
  });
  it('preserves public root deep links even after another tab was visited', () => {
    publishNavigationScope(['(tabs)', 'discover']);
    publishNavigationScope(['users', '[userId]']);
    expect(resolveScopedDestination('/users/search')).toBe('/users/search');
    expect(resolveScopedDestination('/settings/storage')).toBe('/settings/storage');
  });
  it('retains the Android drawer opener and does not scope already scoped routes', () => {
    publishNavigationScope(['(tabs)', 'record']);
    publishNavigationScope(['user-drawer']);
    expect(resolveScopedDestination('/settings')).toBe('/(tabs)/record/settings');
    expect(resolveScopedDestination('/(tabs)/home/users/search')).toBe('/(tabs)/home/users/search');
  });
});
