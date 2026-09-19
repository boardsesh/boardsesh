// @vitest-environment jsdom
import React from 'react';
import { renderToString } from 'react-dom/server';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { classifyMarketingBrowser } from '@/app/lib/marketing-platform';
import { MarketingPreviewProvider } from '../marketing-preview-provider';
import { MarketingPreviewSwitch, MarketingScreenshot } from '../marketing-screenshot';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => tFromCatalog('marketing', key), i18n: { language: 'de' } }),
}));
vi.mock('@/app/lib/static-asset-url', () => ({ resolveStaticAssetUrl: (path: string) => path }));

afterEach(() => vi.restoreAllMocks());

function Gallery({ about = false }: { about?: boolean }) {
  return (
    <>
      <MarketingPreviewSwitch />
      <MarketingScreenshot shot={about ? 'profile' : 'kilter'} alt="App preview" preload={!about} />
    </>
  );
}

describe('platform screenshot rendering', () => {
  it.each(['ios', 'android'] as const)('server-renders only %s images and preload sources', (platform) => {
    const initialBrowser = classifyMarketingBrowser(platform === 'ios' ? 'iPhone' : 'Android');
    const markup = renderToString(
      <MarketingPreviewProvider initialBrowser={initialBrowser}>
        <Gallery />
        <MarketingScreenshot shot="queue" alt="Queue" />
      </MarketingPreviewProvider>,
    );
    const opposite = platform === 'ios' ? 'android' : 'ios';
    expect(markup).toContain(`data-preview-platform="${platform}"`);
    expect(markup).toContain(encodeURIComponent(`/images/app/${platform}/kilter.webp`));
    expect(markup).not.toContain(encodeURIComponent(`/images/app/${opposite}/`));
    expect(markup).not.toContain(`/images/app/${opposite}/`);
    expect(markup.match(/<img /g)).toHaveLength(2);
    expect(markup).toContain('rel="preload"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).not.toContain('aria-label="App preview platform"');
  });

  it('switches every screenshot and retains the choice when page content changes', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0');
    const initialBrowser = classifyMarketingBrowser('Windows NT 10.0');
    const { container, rerender } = render(
      <MarketingPreviewProvider initialBrowser={initialBrowser}>
        <Gallery />
      </MarketingPreviewProvider>,
    );
    expect(container.querySelector('[data-preview-platform="android"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'iOS' }));
    expect(container.querySelector('[data-preview-platform="ios"]')).toBeTruthy();
    rerender(
      <MarketingPreviewProvider initialBrowser={initialBrowser}>
        <Gallery about />
      </MarketingPreviewProvider>,
    );
    expect(container.querySelector('[data-marketing-shot="profile"]')?.getAttribute('data-preview-platform')).toBe(
      'ios',
    );
    expect(screen.getByRole('button', { name: 'iOS' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('hides the desktop switch after detecting an iPad with a Macintosh user agent', () => {
    const userAgent = 'Macintosh; Intel Mac OS X 10_15';
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    const { container } = render(
      <MarketingPreviewProvider initialBrowser={classifyMarketingBrowser(userAgent)}>
        <Gallery />
      </MarketingPreviewProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Android' })).toBeNull();
    expect(container.querySelector('[data-preview-platform="ios"]')).toBeTruthy();
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
  });
});
