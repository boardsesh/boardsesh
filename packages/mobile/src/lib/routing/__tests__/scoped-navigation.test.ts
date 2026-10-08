import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
vi.mock('expo-router', () => ({ router: undefined, useRouter: vi.fn() }));
import { publishNavigationScope, resolveScopedDestination } from '../scoped-navigation';

describe('navigation keeps the originating tab', () => {
  it.each(['home', 'climbs', 'record', 'discover', 'profile', 'wall', 'account'])(
    'resolves privacy settings to registered routes from %s',
    (scope) => {
      publishNavigationScope(scope === 'account' ? ['account'] : ['(tabs)', scope]);
      for (const route of ['privacy', 'privacy-access', 'privacy-onboarding']) {
        const destination = resolveScopedDestination({
          pathname: `/settings/${route}`,
          params: { kind: 'board', resourceId: 'home-board' },
        });
        const expectedPath = `${scope === 'account' ? '/account' : `/(tabs)/${scope}`}/settings/${route}`;
        expect(destination).toEqual({
          pathname: expectedPath,
          params: { kind: 'board', resourceId: 'home-board' },
        });
        expect(existsSync(new URL(`../../../../app${expectedPath}.tsx`, import.meta.url))).toBe(true);
      }
    },
  );
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
