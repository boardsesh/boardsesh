import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import enMarketing from '@boardsesh/i18n/locales/en-US/marketing.json';
import esMarketing from '@boardsesh/i18n/locales/es/marketing.json';
import frMarketing from '@boardsesh/i18n/locales/fr/marketing.json';
import deMarketing from '@boardsesh/i18n/locales/de/marketing.json';
import itMarketing from '@boardsesh/i18n/locales/it/marketing.json';
import zhMarketing from '@boardsesh/i18n/locales/zh-CN/marketing.json';
import { SUPPORTED_LOCALES, type Locale } from '@/app/lib/i18n/config';
import ServerI18nProvider from '@/app/components/providers/i18n-provider';
import { MarketingPreviewProvider } from '@/app/components/marketing/marketing-preview-provider';
import { classifyMarketingBrowser } from '@/app/lib/marketing-platform';
import AboutPage from '@/app/(site)/about/page';
import AboutContent from '../about-content';

const { getLocale, loadServerResources } = vi.hoisted(() => ({
  getLocale: vi.fn(),
  loadServerResources: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale }));
vi.mock('@/app/lib/i18n/server', () => ({ loadServerResources, getServerTranslation: vi.fn() }));
vi.mock('@/app/lib/developer-apps/docs-access', () => ({ getDeveloperDocsState: () => 'unavailable' }));

const catalogs = {
  'en-US': enMarketing,
  es: esMarketing,
  fr: frMarketing,
  de: deMarketing,
  it: itMarketing,
  'zh-CN': zhMarketing,
} satisfies Record<Locale, typeof enMarketing>;
beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0');
  loadServerResources.mockImplementation(async (locale: Locale) => ({ marketing: structuredClone(catalogs[locale]) }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.each(SUPPORTED_LOCALES)('fresh About preview in %s', (locale) => {
  it('translates the caption and platform switch using only the route resources', async () => {
    getLocale.mockResolvedValue(locale);
    const route = await AboutPage();
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
    const { container } = render(
      <I18nextProvider i18n={instance}>
        <MarketingPreviewProvider initialBrowser={classifyMarketingBrowser('Windows NT 10.0')}>
          <AboutContent />
        </MarketingPreviewProvider>
      </I18nextProvider>,
    );
    expect(screen.getByText(catalogs[locale].about.profile.title)).toBeTruthy();
    expect(screen.getByRole('group', { name: catalogs[locale].preview.label })).toBeTruthy();
    expect(screen.getByAltText(catalogs[locale].about.profile.shotAlt)).toBeTruthy();
    const capture = container.querySelector('[data-marketing-shot="profile"]');
    expect(capture?.getAttribute('data-preview-platform')).toBe('android');
    fireEvent.click(screen.getByRole('button', { name: catalogs[locale].preview.ios }));
    expect(capture?.getAttribute('data-preview-platform')).toBe('ios');
    expect(container.textContent).not.toMatch(/preview\.(label|ios|android)|about\.profile\./);
  });
});
