import { describe, it, expect } from 'vitest';
import { isTabsRoute, isClimbsTabRoute, isAuthRoute } from '../route-segments';

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
