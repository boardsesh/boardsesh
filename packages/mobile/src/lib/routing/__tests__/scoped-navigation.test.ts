import { describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
vi.mock('expo-router', () => ({ router: undefined, useRouter: vi.fn() }));
import { publishNavigationScope, resolveScopedDestination } from '../scoped-navigation';

// Every Settings page, read off the real route folder so a new page is covered
// the day it lands: `board-look/index.tsx` is `board-look/index`, and so on.
const SETTINGS_PAGES = readdirSync(fileURLToPath(new URL('../../../../app/settings', import.meta.url)), {
  recursive: true,
  encoding: 'utf8',
})
  .filter(
    (path) => path.endsWith('.tsx') && !path.includes('__tests__') && path !== '_layout.tsx' && path !== 'index.tsx',
  )
  .map((path) =>
    path
      .replace(/\.tsx$/, '')
      .split('\\')
      .join('/'),
  )
  .sort();

describe('navigation keeps the originating tab', () => {
  it('finds the Settings pages', () => {
    expect(SETTINGS_PAGES).toEqual(expect.arrayContaining(['privacy', 'climbs', 'general', 'board-look/custom']));
    expect(SETTINGS_PAGES).not.toContain('offline');
    expect(SETTINGS_PAGES).not.toContain('board-lighting');
  });

  it.each(['home', 'climbs', 'record', 'discover', 'profile', 'wall', 'account'])(
    'resolves every Settings page to a registered route from %s',
    (scope) => {
      publishNavigationScope(scope === 'account' ? ['account'] : ['(tabs)', scope]);
      const scopedRoot = `${scope === 'account' ? '/account' : `/(tabs)/${scope}`}/settings`;
      expect(resolveScopedDestination('/settings')).toBe(scopedRoot);
      expect(existsSync(new URL(`../../../../app${scopedRoot}/index.tsx`, import.meta.url))).toBe(true);
      for (const route of SETTINGS_PAGES) {
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
