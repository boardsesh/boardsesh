import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanup, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import enMarketing from '@boardsesh/i18n/locales/en-US/marketing.json';
import esMarketing from '@boardsesh/i18n/locales/es/marketing.json';
import frMarketing from '@boardsesh/i18n/locales/fr/marketing.json';
import deMarketing from '@boardsesh/i18n/locales/de/marketing.json';
import itMarketing from '@boardsesh/i18n/locales/it/marketing.json';
import { SUPPORTED_LOCALES, type Locale } from '@/app/lib/i18n/config';
import ServerI18nProvider from '@/app/components/providers/i18n-provider';
import BoardPage from '../board-and-bluetooth/page';
import FindingPage from '../finding-climbs/page';
import LogbookPage from '../logbook/page';
import SprayPage from '../spray-walls/page';
import { HelpClip, HelpWalkthrough } from '../help-clip';

const { getLocale, loadServerResources } = vi.hoisted(() => ({
  getLocale: vi.fn(),
  loadServerResources: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale }));
vi.mock('@/app/lib/i18n/server', () => ({ loadServerResources, getServerTranslation: vi.fn() }));

const catalogs = { 'en-US': enMarketing, es: esMarketing, fr: frMarketing, de: deMarketing, it: itMarketing };
const clipRoutes = [
  ['board-and-bluetooth', BoardPage],
  ['finding-climbs', FindingPage],
  ['logbook', LogbookPage],
] as const;

beforeEach(() => {
  getLocale.mockReset();
  loadServerResources.mockImplementation(async (locale: Locale) => ({ marketing: structuredClone(catalogs[locale]) }));
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function freshRouteInstance(Page: () => ReturnType<typeof BoardPage>, locale: Locale) {
  getLocale.mockResolvedValue(locale);
  const route = await Page();
  if (!React.isValidElement<Parameters<typeof ServerI18nProvider>[0]>(route)) throw new Error('Missing route provider');
  // Exercise the real server provider's selection, then start with no prior route or fallback catalog.
  const serialized = await ServerI18nProvider(route.props);
  const instance = createInstance();
  await instance.use(initReactI18next).init({
    lng: locale,
    fallbackLng: false,
    ns: ['marketing'],
    defaultNS: 'marketing',
    resources: { [locale]: serialized.props.resources },
    interpolation: { escapeValue: false },
  });
  return instance;
}

describe.each(SUPPORTED_LOCALES)('fresh help video resources in %s', (locale) => {
  describe.each(clipRoutes)('/help/%s', (_route, Page) => {
    it.each(['reduced motion', 'autoplay refused'])('translates clip controls and fallback with %s', async (reason) => {
      vi.stubGlobal(
        'matchMedia',
        vi.fn(() => ({
          matches: reason === 'reduced motion',
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      );
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play');
      if (reason === 'autoplay refused') play.mockRejectedValue(new Error('Autoplay refused'));
      else play.mockResolvedValue(undefined);
      const instance = await freshRouteInstance(Page, locale);
      const { container } = render(
        <I18nextProvider i18n={instance}>
          <HelpClip name="long-press-climb-actions" alt="Climb actions" caption="Gesture recording" />
        </I18nextProvider>,
      );
      expect(await screen.findByText(catalogs[locale].help.clip.playHint)).toBeTruthy();
      const video = container.querySelector('video');
      expect(video?.controls).toBe(true);
      expect(video?.textContent).toContain(catalogs[locale].help.clip.unsupported);
      expect(container.textContent).not.toContain('help.clip.');
      if (reason === 'reduced motion') expect(play).not.toHaveBeenCalled();
      else expect(play).toHaveBeenCalled();
    });
  });

  it.each(['spray-walls-walkthrough', 'spray-holds-editor'] as const)(
    'translates both video fallbacks for /help/spray-walls: %s',
    async (name) => {
      const instance = await freshRouteInstance(SprayPage, locale);
      const { container } = render(
        <I18nextProvider i18n={instance}>
          <HelpWalkthrough name={name} alt="Wall walkthrough" />
        </I18nextProvider>,
      );
      const videos = [...container.querySelectorAll('video')];
      expect(videos).toHaveLength(2);
      for (const video of videos) {
        expect(video.textContent).toContain(catalogs[locale].help.clip.unsupported);
        expect(video.textContent).not.toContain('help.clip.');
      }
    },
  );
});
