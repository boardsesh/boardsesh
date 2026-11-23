import { describe, expect, it } from 'vite-plus/test';
import enClimbs from '@boardsesh/i18n/locales/en-US/climbs.json';
import esClimbs from '@boardsesh/i18n/locales/es/climbs.json';
import frClimbs from '@boardsesh/i18n/locales/fr/climbs.json';
import deClimbs from '@boardsesh/i18n/locales/de/climbs.json';
import itClimbs from '@boardsesh/i18n/locales/it/climbs.json';
import zhClimbs from '@boardsesh/i18n/locales/zh-CN/climbs.json';

/**
 * WCAG 2.5.3 (label in name): an `aria-label` replaces the visible text, so a
 * voice-control user who says what they see must still hit the button. Every
 * store button's label on the climb page starts with its visible text, in
 * every locale.
 */
const CATALOGS = [
  ['en-US', enClimbs],
  ['es', esClimbs],
  ['fr', frClimbs],
  ['de', deClimbs],
  ['it', itClimbs],
  ['zh-CN', zhClimbs],
] as const;

describe.each(CATALOGS)('climb page store labels in %s', (_locale, catalog) => {
  const { cta, stickyBar } = catalog.frontDoor;

  it('start the phone button labels with "Get the free app"', () => {
    expect(cta.getAppAriaIos.startsWith(cta.getApp)).toBe(true);
    expect(cta.getAppAriaAndroid.startsWith(cta.getApp)).toBe(true);
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
