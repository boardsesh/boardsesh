import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { __resetSessionInboundCampaignForTests } from '@/app/lib/inbound-campaign';
import { __resetQrLandingForTests } from '@/app/lib/qr-landing';
import { buildStoreUrl } from '@/app/lib/store-links';

const track = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/analytics', () => ({ track }));

// Flipped by the update-mode cases: a visitor still inside the retired Capacitor app.
const capacitorShell = vi.hoisted(() => ({ isNative: false }));
vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  isNativeApp: () => capacitorShell.isNative,
  isCapacitorWebView: () => false,
  waitForCapacitor: () => Promise.resolve(false),
}));

const StoreInstallButtons = (await import('../store-install-buttons')).default;
const { MarketingPreviewProvider } = await import('../marketing-preview-provider');
const { classifyMarketingBrowser } = await import('@/app/lib/marketing-platform');

const LABELS = { ios: 'App Store', android: 'Google Play', update: 'Update', locale: 'en-US' } as const;

const ORIGINAL_UA = navigator.userAgent;
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
// iPadOS Safari asks for the desktop site: a Mac user agent, told apart only by touch points.
const IPAD_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
}

function badgeOf(link: HTMLElement): HTMLImageElement {
  const image = link.querySelector('img');
  if (!image) throw new Error('store link has no badge image');
  return image;
}

describe('StoreInstallButtons', () => {
  beforeEach(() => {
    track.mockReset();
    __resetSessionInboundCampaignForTests();
    __resetQrLandingForTests();
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    __resetSessionInboundCampaignForTests();
    setUserAgent(ORIGINAL_UA);
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
    capacitorShell.isNative = false;
  });

  it('shows Google Play alone on an Android phone', async () => {
    setUserAgent(ANDROID_UA);
    render(<StoreInstallButtons placement="climb-view" labels={LABELS} />);

    const playLink = await screen.findByRole('link', { name: 'Google Play' });

    expect(playLink.getAttribute('href')).toBe(buildStoreUrl('android', { placement: 'climb-view' }));
    expect(screen.queryByRole('link', { name: 'App Store' })).toBeNull();
  });

  it('shows the App Store alone on an iPhone', async () => {
    setUserAgent(IPHONE_UA);
    render(<StoreInstallButtons placement="climb-view" labels={LABELS} />);

    const appStoreLink = await screen.findByRole('link', { name: 'App Store' });

    expect(appStoreLink.getAttribute('href')).toBe(buildStoreUrl('ios', { placement: 'climb-view' }));
    expect(new URL(appStoreLink.getAttribute('href') ?? '').searchParams.get('ct')).toBe('climb-view');
    expect(screen.queryByRole('link', { name: 'Google Play' })).toBeNull();
  });

  it('shows both stores on a desktop, which has no phone to infer', async () => {
    setUserAgent(DESKTOP_UA);
    render(<StoreInstallButtons placement="gyms-directory" labels={LABELS} />);

    const playLink = await screen.findByRole('link', { name: 'Google Play' });

    expect(playLink.getAttribute('href')).toBe(buildStoreUrl('android', { placement: 'gyms-directory' }));
    expect(screen.getByRole('link', { name: 'App Store' }).getAttribute('href')).toBe(
      buildStoreUrl('ios', { placement: 'gyms-directory' }),
    );
  });

  it('opens the store in a new tab, so the page and its click event survive', async () => {
    setUserAgent(ANDROID_UA);
    render(<StoreInstallButtons placement="climb-list" labels={LABELS} />);

    const playLink = await screen.findByRole('link', { name: 'Google Play' });

    expect(playLink.getAttribute('target')).toBe('_blank');
    expect(playLink.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('sends the click with the same placement the link carries', async () => {
    setUserAgent(ANDROID_UA);
    render(<StoreInstallButtons placement="spray-climb" labels={LABELS} />);

    const playLink = await screen.findByRole('link', { name: 'Google Play' });
    fireEvent.click(playLink);

    expect(track).toHaveBeenCalledWith('App Install Click', {
      platform: 'android',
      source: 'google-play',
      placement: 'spray-climb',
      mode: 'install',
    });
    expect(playLink.getAttribute('href')).toContain('utm_content=spray-climb');
  });

  it("carries a tagged visitor's source into the link, and keeps the link id ours", async () => {
    setUserAgent(ANDROID_UA);
    window.history.replaceState(null, '', '/kilter/x?utm_source=chatgpt.com&utm_content=theirs');
    render(<StoreInstallButtons placement="climb-view" labels={LABELS} />);

    const playLink = await screen.findByRole('link', { name: 'Google Play' });
    const referrer = new URLSearchParams(
      new URL(playLink.getAttribute('href') ?? '').searchParams.get('referrer') ?? '',
    );

    expect(referrer.get('utm_source')).toBe('chatgpt.com');
    expect(referrer.get('utm_content')).toBe('climb-view');
  });

  it.each(['brand', 'plain', 'brand-outlined'] as const)(
    'shows the official badges, never a text button, in the %s appearance',
    async (appearance) => {
      setUserAgent(DESKTOP_UA);
      render(<StoreInstallButtons placement="help" labels={LABELS} appearance={appearance} />);

      await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(2));

      expect(document.querySelector('.MuiButton-root')).toBeNull();
      expect(badgeOf(screen.getByRole('link', { name: 'App Store' })).getAttribute('src')).toBe(
        '/images/store-badges/app-store-black-en-US.svg',
      );
      expect(badgeOf(screen.getByRole('link', { name: 'Google Play' })).getAttribute('src')).toBe(
        '/images/store-badges/google-play-en-US.svg',
      );
    },
  );

  it('sizes a pair at 44px, with Google Play never narrower than the App Store badge', async () => {
    setUserAgent(DESKTOP_UA);
    render(<StoreInstallButtons placement="help" labels={LABELS} />);

    const appStoreBadge = badgeOf(await screen.findByRole('link', { name: 'App Store' }));
    const playBadge = badgeOf(screen.getByRole('link', { name: 'Google Play' }));

    expect(appStoreBadge.getAttribute('height')).toBe('44');
    expect(playBadge.getAttribute('height')).toBe('44');
    expect(Number(playBadge.getAttribute('width'))).toBeGreaterThanOrEqual(Number(appStoreBadge.getAttribute('width')));
  });

  it('gives an iPhone on a per-request page the white App Store badge, a size up, since it stands alone', async () => {
    setUserAgent(IPHONE_UA);
    render(<StoreInstallButtons placement="hero" labels={LABELS} />);

    const appStoreBadge = badgeOf(await screen.findByRole('link', { name: 'App Store' }));

    expect(appStoreBadge.getAttribute('src')).toBe('/images/store-badges/app-store-white-en-US.svg');
    expect(appStoreBadge.getAttribute('height')).toBe('48');
    expect(appStoreBadge.getAttribute('alt')).toBe('App Store');
  });

  it("keeps an iPad's badge black and paired-size when its desktop-looking server render narrows", async () => {
    // The server read a Mac and rendered the desktop pair; only the browser's
    // touch points say iPad. Google Play goes, but the App Store badge must not
    // also turn white and grow under the reader's eyes.
    setUserAgent(IPAD_UA);
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
    render(
      <MarketingPreviewProvider initialBrowser={classifyMarketingBrowser(IPAD_UA)}>
        <StoreInstallButtons placement="help" labels={LABELS} />
      </MarketingPreviewProvider>,
    );

    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(1));
    const appStoreBadge = badgeOf(screen.getByRole('link', { name: 'App Store' }));

    expect(appStoreBadge.getAttribute('src')).toBe('/images/store-badges/app-store-black-en-US.svg');
    expect(appStoreBadge.getAttribute('height')).toBe('44');
  });

  it('keeps the black 44px badge on shared HTML after it narrows, so nothing changes at hydration', async () => {
    setUserAgent(IPHONE_UA);
    render(<StoreInstallButtons placement="climb-view" labels={LABELS} sharedHtml />);

    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(1));
    const appStoreBadge = badgeOf(screen.getByRole('link', { name: 'App Store' }));

    expect(appStoreBadge.getAttribute('src')).toBe('/images/store-badges/app-store-black-en-US.svg');
    expect(appStoreBadge.getAttribute('height')).toBe('44');
  });

  it("shows the badge in the page's language", async () => {
    setUserAgent(DESKTOP_UA);
    render(<StoreInstallButtons placement="help" labels={{ ...LABELS, locale: 'fr' }} />);

    const appStoreBadge = badgeOf(await screen.findByRole('link', { name: 'App Store' }));

    expect(appStoreBadge.getAttribute('src')).toBe('/images/store-badges/app-store-black-fr.svg');
    expect(badgeOf(screen.getByRole('link', { name: 'Google Play' })).getAttribute('src')).toBe(
      '/images/store-badges/google-play-fr.svg',
    );
  });

  describe('for a visitor still in the retired Capacitor app', () => {
    it('keeps a text "Update" button, since a download badge would say the wrong thing', async () => {
      capacitorShell.isNative = true;
      setUserAgent(IPHONE_UA);
      render(<StoreInstallButtons placement="hero" labels={LABELS} />);

      const updateLink = await screen.findByRole('link', { name: 'Update' });

      expect(updateLink.querySelector('img')).toBeNull();
      expect(updateLink.className).toContain('MuiButton-contained');
      expect(updateLink.getAttribute('href')).toBe(buildStoreUrl('ios', { placement: 'hero' }));
      fireEvent.click(updateLink);
      expect(track).toHaveBeenCalledWith('App Install Click', {
        platform: 'ios',
        source: 'app-store',
        placement: 'hero',
        mode: 'update',
      });
    });

    it('outlines the update button beside a page that already has a filled one', async () => {
      capacitorShell.isNative = true;
      setUserAgent(ANDROID_UA);
      render(<StoreInstallButtons placement="climb-view" labels={LABELS} appearance="plain" />);

      const updateLink = await screen.findByRole('link', { name: 'Update' });

      expect(updateLink.className).toContain('MuiButton-outlined');
      expect(updateLink.getAttribute('href')).toBe(buildStoreUrl('android', { placement: 'climb-view' }));
    });
  });

  describe('on a page a code lands on', () => {
    it('names the scanned code in the link id and on the click (#4415)', async () => {
      setUserAgent(ANDROID_UA);
      window.history.replaceState(null, '', '/b/garage-wall/40/list?src=qr&medium=board&wall=abc');
      render(
        <StoreInstallButtons placement="spray-wall" labels={LABELS} appearance="plain" sharedHtml qrLanding="board" />,
      );

      await waitFor(() =>
        expect(screen.getByRole('link', { name: 'Google Play' }).getAttribute('href')).toBe(
          buildStoreUrl('android', { placement: 'spray-wall', qrMedium: 'board' }),
        ),
      );
      const playLink = screen.getByRole('link', { name: 'Google Play' });
      const referrer = new URLSearchParams(
        new URL(playLink.getAttribute('href') ?? '').searchParams.get('referrer') ?? '',
      );
      // The link id and the medium say "a code", and nothing in them names the wall.
      expect(referrer.get('utm_content')).toBe('spray-wall.board');
      expect(referrer.get('utm_medium')).toBe('qr');
      expect(playLink.getAttribute('href')).not.toContain('garage-wall');
      expect(playLink.getAttribute('href')).not.toContain('abc');

      fireEvent.click(playLink);
      expect(track).toHaveBeenCalledWith('App Install Click', {
        platform: 'android',
        source: 'google-play',
        placement: 'spray-wall',
        mode: 'install',
        qrMedium: 'board',
      });
    });

    it('keeps the plain link id for a visit that did not come off a code', async () => {
      setUserAgent(ANDROID_UA);
      window.history.replaceState(null, '', '/b/garage-wall/40/list');
      render(
        <StoreInstallButtons placement="spray-wall" labels={LABELS} appearance="plain" sharedHtml qrLanding="board" />,
      );

      await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(1));
      const playLink = screen.getByRole('link', { name: 'Google Play' });

      expect(playLink.getAttribute('href')).toBe(buildStoreUrl('android', { placement: 'spray-wall' }));
      fireEvent.click(playLink);
      expect(track.mock.calls[0]?.[1]).not.toHaveProperty('qrMedium');
    });

    it('ignores the scan on a button that did not ask for it', async () => {
      setUserAgent(ANDROID_UA);
      window.history.replaceState(null, '', '/b/garage-wall/40/list?src=qr&medium=board');
      render(<StoreInstallButtons placement="climb-view" labels={LABELS} appearance="plain" sharedHtml />);

      await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(1));

      expect(screen.getByRole('link', { name: 'Google Play' }).getAttribute('href')).toBe(
        buildStoreUrl('android', { placement: 'climb-view' }),
      );
    });

    it('keeps the plain link id when the page expects another kind of code', async () => {
      setUserAgent(ANDROID_UA);
      window.history.replaceState(null, '', '/b/garage-wall/40/list?src=qr&medium=board');
      render(
        <StoreInstallButtons placement="spray-wall" labels={LABELS} appearance="plain" sharedHtml qrLanding="climb" />,
      );

      await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(1));
      const playLink = screen.getByRole('link', { name: 'Google Play' });

      expect(playLink.getAttribute('href')).toBe(buildStoreUrl('android', { placement: 'spray-wall' }));
      expect(playLink.getAttribute('href')).not.toContain('spray-wall.board');
      fireEvent.click(playLink);
      expect(track.mock.calls[0]?.[1]).not.toHaveProperty('qrMedium');
    });

    it('names the desktop code on a climb page a phone reached by scanning it', async () => {
      setUserAgent(IPHONE_UA);
      window.history.replaceState(null, '', '/b/the-kilter/40/view/abc-the-climb?src=qr&medium=desktop');
      render(
        <StoreInstallButtons placement="climb-view" labels={LABELS} appearance="plain" sharedHtml qrLanding="climb" />,
      );

      await waitFor(() =>
        expect(screen.getByRole('link', { name: 'App Store' }).getAttribute('href')).toBe(
          buildStoreUrl('ios', { placement: 'climb-view', qrMedium: 'desktop' }),
        ),
      );
      const appStoreLink = screen.getByRole('link', { name: 'App Store' });
      expect(new URL(appStoreLink.getAttribute('href') ?? '').searchParams.get('ct')).toBe('climb-view.desktop');

      fireEvent.click(appStoreLink);
      expect(track).toHaveBeenCalledWith('App Install Click', {
        platform: 'ios',
        source: 'app-store',
        placement: 'climb-view',
        mode: 'install',
        qrMedium: 'desktop',
      });
    });

    it('renders the untagged link on the server, so the shared HTML is the same for a scan', () => {
      window.history.replaceState(null, '', '/b/garage-wall/40/list?src=qr&medium=board');

      const html = renderToString(
        <StoreInstallButtons placement="spray-wall" labels={LABELS} appearance="plain" sharedHtml qrLanding="board" />,
      );

      expect(html).toContain('ct=spray-wall&amp;');
      expect(html).not.toContain('spray-wall.board');
    });
  });

  describe('on a page whose HTML is shared', () => {
    it('narrows to the store for this phone once mounted', async () => {
      setUserAgent(ANDROID_UA);
      render(<StoreInstallButtons placement="climb-view" labels={LABELS} appearance="plain" sharedHtml />);

      await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(1));

      expect(screen.getByRole('link', { name: 'Google Play' }).getAttribute('href')).toBe(
        buildStoreUrl('android', { placement: 'climb-view' }),
      );
    });

    it('hydrates over two-store HTML without a mismatch, then narrows', async () => {
      // What an iPhone gets from the edge: HTML rendered for somebody else.
      setUserAgent(IPHONE_UA);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const island = <StoreInstallButtons placement="climb-view" labels={LABELS} appearance="plain" sharedHtml />;
      const container = document.createElement('div');
      document.body.appendChild(container);
      container.innerHTML = renderToString(island);
      expect(container.querySelectorAll('a')).toHaveLength(2);

      render(island, { container, hydrate: true });

      await waitFor(() => expect(container.querySelectorAll('a')).toHaveLength(1));
      expect(container.querySelector('a img')?.getAttribute('alt')).toBe('App Store');
      expect(consoleError).not.toHaveBeenCalled();
      consoleError.mockRestore();
      container.remove();
    });
  });
});
