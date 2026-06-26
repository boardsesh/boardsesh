import { describe, it, expect } from 'vitest';
import { isTabsRoute, isClimbsTabRoute, isAuthRoute, isSocialSurface } from '../route-segments';

describe('isTabsRoute', () => {
  it('is true anywhere inside the tab navigator', () => {
    expect(isTabsRoute(['(tabs)'])).toBe(true);
    expect(isTabsRoute(['(tabs)', 'climbs'])).toBe(true);
    expect(isTabsRoute(['(tabs)', 'profile'])).toBe(true);
  });

  it('is false outside the tab navigator', () => {
    expect(isTabsRoute(['auth'])).toBe(false);
    expect(isTabsRoute(['(modal)', 'session'])).toBe(false);
    expect(isTabsRoute([])).toBe(false);
  });
});

describe('isClimbsTabRoute', () => {
  it('is true on the Climbs tab and its sub-routes', () => {
    expect(isClimbsTabRoute(['(tabs)', 'climbs'])).toBe(true);
    expect(isClimbsTabRoute(['(tabs)', 'climbs', 'create'])).toBe(true);
  });

  it('is false on other tabs or outside the tabs group', () => {
    expect(isClimbsTabRoute(['(tabs)', 'boards'])).toBe(false);
    expect(isClimbsTabRoute(['(tabs)'])).toBe(false);
    expect(isClimbsTabRoute(['auth'])).toBe(false);
    expect(isClimbsTabRoute([])).toBe(false);
  });
});

describe('isSocialSurface', () => {
  it('is true on the social/browsing tabs and their sub-routes', () => {
    expect(isSocialSurface(['(tabs)', 'home'])).toBe(true);
    expect(isSocialSurface(['(tabs)', 'profile'])).toBe(true);
    expect(isSocialSurface(['(tabs)', 'discover'])).toBe(true);
    expect(isSocialSurface(['(tabs)', 'discover', '[playlist_uuid]'])).toBe(true);
  });

  it('is false on the board-control tabs and outside the tabs group', () => {
    expect(isSocialSurface(['(tabs)', 'climbs'])).toBe(false);
    expect(isSocialSurface(['(tabs)', 'record'])).toBe(false);
    expect(isSocialSurface(['(tabs)'])).toBe(false);
    expect(isSocialSurface(['auth'])).toBe(false);
    expect(isSocialSurface([])).toBe(false);
  });
});

describe('isAuthRoute', () => {
  it('is true anywhere inside the auth flow', () => {
    expect(isAuthRoute(['auth'])).toBe(true);
    expect(isAuthRoute(['auth', 'login'])).toBe(true);
    expect(isAuthRoute(['auth', 'register'])).toBe(true);
  });

  it('is false outside the auth flow', () => {
    expect(isAuthRoute(['(tabs)', 'climbs'])).toBe(false);
    expect(isAuthRoute(['gyms'])).toBe(false);
    expect(isAuthRoute([])).toBe(false);
  });
});
