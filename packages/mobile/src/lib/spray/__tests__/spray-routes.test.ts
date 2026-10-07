import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { opensIntoSprayFlow, readSprayWallUuid, sprayHoldEditorHref, sprayResetHref } from '../spray-routes';

describe('spray maintenance routes', () => {
  it.each([sprayHoldEditorHref, sprayResetHref])(
    'opens an existing route with the wall parameter its screen reads',
    (href) => {
      const wallUuid = 'wall&with=special characters';
      const destination = new URL(href(wallUuid), 'https://app.boardsesh.com');
      const routeFile = new URL(`../../../../app${destination.pathname}.tsx`, import.meta.url);
      expect(existsSync(routeFile)).toBe(true);
      expect(readSprayWallUuid(Object.fromEntries(destination.searchParams))).toBe(wallUuid);
    },
  );

  it('accepts restored links using the old boardUuid spelling', () => {
    expect(readSprayWallUuid({ boardUuid: 'legacy-wall' })).toBe('legacy-wall');
    expect(readSprayWallUuid({ wallUuid: 'current-wall', boardUuid: 'legacy-wall' })).toBe('current-wall');
  });

  it.each([
    {},
    { wallUuid: '' },
    { wallUuid: ' ' },
    { wallUuid: ['wall-1', 'wall-2'] },
    { wallUuid: '', boardUuid: 'legacy-wall' },
    { boardUuid: ['wall-1'] },
  ])('rejects missing or ambiguous wall parameters: %j', (params) => {
    expect(readSprayWallUuid(params)).toBeNull();
  });
});

describe('opensIntoSprayFlow', () => {
  // `router.push('/boards/spray/holds?…')` from a tab arrives at the root
  // `boards` screen as a nested navigate: the entry screen rides in params.
  it.each(['spray/new', 'spray/holds', 'spray/reset'])('reads a nested navigate into %s', (screen) => {
    expect(opensIntoSprayFlow({ params: { screen, params: { wallUuid: 'wall-1' } } })).toBe(true);
  });

  it('is false for the picker and the other boards screens', () => {
    expect(opensIntoSprayFlow({ params: { returnTo: '/(tabs)/climbs' } })).toBe(false);
    expect(opensIntoSprayFlow({ params: { screen: 'index' } })).toBe(false);
    expect(opensIntoSprayFlow({ params: { screen: 'create' } })).toBe(false);
  });

  // A cold deep link or a restored session carries the nested state instead.
  it('falls back to the stack entry when there is no screen param', () => {
    expect(opensIntoSprayFlow({ state: { routes: [{ name: 'spray/holds' }] } })).toBe(true);
    expect(opensIntoSprayFlow({ state: { routes: [{ name: 'index' }, { name: 'spray/new' }] } })).toBe(false);
  });

  // Pushing the wizard over the picker must not turn the picker's own card
  // full screen while it is up.
  it('keys off the entry, never the screen pushed on top of it', () => {
    expect(
      opensIntoSprayFlow({
        params: { screen: 'index' },
        state: { routes: [{ name: 'index' }, { name: 'spray/reset' }] },
      }),
    ).toBe(false);
    expect(
      opensIntoSprayFlow({
        params: { screen: 'spray/holds' },
        state: { routes: [{ name: 'index' }] },
      }),
    ).toBe(true);
  });

  it('opens as the ordinary card when the route says nothing', () => {
    expect(opensIntoSprayFlow({})).toBe(false);
    expect(opensIntoSprayFlow({ params: { screen: 42 } })).toBe(false);
    expect(opensIntoSprayFlow({ state: { routes: [] } })).toBe(false);
  });
});
