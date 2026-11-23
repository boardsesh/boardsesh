import { describe, expect, it } from 'vite-plus/test';
import esClimbs from '@boardsesh/i18n/locales/es/climbs.json';
import frClimbs from '@boardsesh/i18n/locales/fr/climbs.json';
import itClimbs from '@boardsesh/i18n/locales/it/climbs.json';

/**
 * Copy the board list and the climb page share a component for, but not words.
 */
describe('front-door CTA copy', () => {
  it.each([
    ['es', esClimbs],
    ['fr', frClimbs],
    ['it', itClimbs],
  ] as const)(
    'gives the %s list its own hand-off, not the climb page "open it", which names a climb',
    (_locale, catalog) => {
      expect(catalog.list.frontDoor.cta.openInBrowserMobile).not.toBe(catalog.frontDoor.cta.openInBrowserMobile);
    },
  );

  it('puts the Italian brand after "pannello", so a feminine board (la MoonBoard) never takes "tuo"', () => {
    for (const helper of [itClimbs.frontDoor.cta.getAppHelper, itClimbs.list.frontDoor.cta.getAppHelper]) {
      expect(helper).toContain('pannello {{board}}');
      expect(helper).not.toMatch(/tuo \{\{board\}\}/);
    }
  });
});
