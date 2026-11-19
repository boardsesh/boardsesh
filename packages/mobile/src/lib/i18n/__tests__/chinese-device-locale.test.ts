import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getLocales } = vi.hoisted(() => ({
  getLocales: vi.fn(
    () =>
      [] as Array<{
        languageTag: string;
        languageCode: string;
        languageScriptCode?: string;
      }>,
  ),
}));

vi.mock('expo-localization', () => ({ getLocales }));
// Locale detection does not depend on loading the entire mobile catalog graph.
vi.mock('../catalogs', () => ({ resources: {} }));

import { detectDeviceLocale } from '../config';

beforeEach(() => getLocales.mockReturnValue([]));

describe('Simplified Chinese device detection', () => {
  it.each(['zh-CN', 'zh-Hans', 'zh-Hans-CN', 'zh-SG', 'zh'])('uses Chinese for %s', (languageTag) => {
    getLocales.mockReturnValue([{ languageTag, languageCode: 'zh' }]);
    expect(detectDeviceLocale()).toBe('zh-CN');
  });

  it.each(['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-CN'])(
    'does not substitute Simplified for %s',
    (languageTag) => {
      getLocales.mockReturnValue([
        { languageTag, languageCode: 'zh' },
        { languageTag: 'fr-FR', languageCode: 'fr' },
      ]);
      expect(detectDeviceLocale()).toBe('fr');
    },
  );

  it('lets an explicit Simplified script take precedence over the region', () => {
    getLocales.mockReturnValue([{ languageTag: 'zh-Hans-TW', languageCode: 'zh', languageScriptCode: 'Hans' }]);
    expect(detectDeviceLocale()).toBe('zh-CN');
  });

  it('respects the explicit device script over the region tag', () => {
    getLocales.mockReturnValue([{ languageTag: 'zh-CN', languageCode: 'zh', languageScriptCode: 'Hant' }]);
    expect(detectDeviceLocale()).toBe('en-US');
  });
});
