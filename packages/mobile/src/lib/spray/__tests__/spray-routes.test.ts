import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readSprayWallUuid, sprayHoldEditorHref, sprayResetHref } from '../spray-routes';

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
