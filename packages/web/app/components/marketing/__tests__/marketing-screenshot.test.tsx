// @vitest-environment jsdom
import React from 'react';
import { renderToString } from 'react-dom/server';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { classifyMarketingBrowser } from '@/app/lib/marketing-platform';
import { MarketingPreviewProvider } from '../marketing-preview-provider';
import { MarketingScreenshot } from '../marketing-screenshot';
import { MarketingPreviewSwitch } from '../marketing-preview-switch';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';

vi.mock('@/app/lib/user-preferences-db', () => ({ getPreference: vi.fn(), setPreference: vi.fn() }));
beforeEach(() => {
  vi.mocked(getPreference).mockResolvedValue(undefined);
  vi.mocked(setPreference).mockResolvedValue(undefined);
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => tFromCatalog('marketing', key), i18n: { language: 'de' } }),
}));
vi.mock('@/app/lib/marketing-static-asset-url', () => ({ resolveMarketingStaticAssetUrl: (path: string) => path }));

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
  it('keeps shared-HTML image URLs inside noscript until the platform is resolved', () => {
    const markup = renderToString(
      <MarketingPreviewProvider initialBrowser={classifyMarketingBrowser('')} sharedHtml>
        <Gallery />
      </MarketingPreviewProvider>,
    );
    expect(markup).toContain('<noscript>');
    expect(markup).toContain('/images/app/android/kilter.webp');
    const scriptedMarkup = markup.replace(/<noscript>[\s\S]*?<\/noscript>/g, '');
    expect(scriptedMarkup).not.toContain('<img');
    expect(scriptedMarkup).not.toContain('rel="preload"');
    expect(markup).toMatch(/<img[^>]*width="\d+"[^>]*height="\d+"/);
    expect(scriptedMarkup).toContain('data-marketing-shot="kilter"');
  });

  it('loads only the detected platform after resolving shared HTML', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
    const { container } = render(
      <MarketingPreviewProvider initialBrowser={classifyMarketingBrowser('')} sharedHtml>
        <MarketingScreenshot shot="queue" alt="Queue" />
      </MarketingPreviewProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector('img')?.getAttribute('src')).toContain(
        encodeURIComponent('/images/app/ios/queue.webp'),
      ),
    );
    expect(container.querySelector('noscript')).toBeNull();
  });

  it('restores a deliberate preview choice after a document navigation', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0');
    vi.mocked(getPreference).mockResolvedValue('ios');
    const { container } = render(
      <MarketingPreviewProvider initialBrowser={classifyMarketingBrowser('')} sharedHtml>
        <Gallery />
      </MarketingPreviewProvider>,
    );
    await waitFor(() => expect(container.querySelector('[data-preview-platform="ios"]')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Android' }));
    expect(setPreference).toHaveBeenCalledWith('marketingPreviewPlatform', 'android');
  });

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
    // The check follows the selection: the non-colour cue next to the tonal ground.
    expect(screen.getByRole('button', { name: 'iOS' }).querySelector('[data-selected-check]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Android' }).querySelector('[data-selected-check]')).toBeNull();
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
