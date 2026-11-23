import { describe, expect, it } from 'vite-plus/test';
import enClimbs from '@boardsesh/i18n/locales/en-US/climbs.json';
import esClimbs from '@boardsesh/i18n/locales/es/climbs.json';
import frClimbs from '@boardsesh/i18n/locales/fr/climbs.json';
import deClimbs from '@boardsesh/i18n/locales/de/climbs.json';
import itClimbs from '@boardsesh/i18n/locales/it/climbs.json';
import zhClimbs from '@boardsesh/i18n/locales/zh-CN/climbs.json';
import enMarketing from '@boardsesh/i18n/locales/en-US/marketing.json';
import esMarketing from '@boardsesh/i18n/locales/es/marketing.json';
import frMarketing from '@boardsesh/i18n/locales/fr/marketing.json';
import deMarketing from '@boardsesh/i18n/locales/de/marketing.json';
import itMarketing from '@boardsesh/i18n/locales/it/marketing.json';
import zhMarketing from '@boardsesh/i18n/locales/zh-CN/marketing.json';

/**
 * WCAG 2.5.3 (label in name): an `aria-label` replaces the visible text, so a
 * voice-control user who says what they see must still hit the button. Every
 * store button's label on the climb page starts with its visible text, in
 * every locale.
 *
 * The phone's store link is the official badge, whose name is its image's alt
 * text (no `aria-label` over it): the badge's own words. Every badge shows its
 * store's name in Latin letters, in every language, so the alt text must carry
 * that name too, or "tap App Store" would miss.
 */
const CATALOGS = [
  ['en-US', enClimbs, enMarketing],
  ['es', esClimbs, esMarketing],
  ['fr', frClimbs, frMarketing],
  ['de', deClimbs, deMarketing],
  ['it', itClimbs, itMarketing],
  ['zh-CN', zhClimbs, zhMarketing],
] as const;

describe.each(CATALOGS)('climb page store labels in %s', (_locale, catalog, marketing) => {
  const { stickyBar } = catalog.frontDoor;

  it("name each phone badge with the store's name the badge shows", () => {
    const { ctaInstallIos, ctaInstallAndroid } = marketing.home.hero;
    expect(ctaInstallIos).toContain('App Store');
    expect(ctaInstallAndroid).toContain('Google Play');
  });

  it('start each board-list angle link label with its visible angle', () => {
    const { angles } = catalog.list.frontDoor;
    expect(angles.linkAria.startsWith(angles.stop)).toBe(true);
  });

  it('start the sticky bar labels with its button text', () => {
    expect(stickyBar.ctaAriaIos.startsWith(stickyBar.cta)).toBe(true);
    expect(stickyBar.ctaAriaAndroid.startsWith(stickyBar.cta)).toBe(true);
  });
});
