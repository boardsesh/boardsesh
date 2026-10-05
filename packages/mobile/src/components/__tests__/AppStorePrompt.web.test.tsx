// @vitest-environment jsdom
// The store prompt in the browser app. What is pinned here:
//
// 1. A desktop browser gets nothing, on every surface.
// 2. The link that opens is the tagged one for the store the browser can use,
//    and the click is counted before the store opens.
// 3. "Not now" on Home is remembered, and a remembered answer never flashes
//    the card first.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';

const openURL = vi.hoisted(() => vi.fn(async (_url: string) => true));
const track = vi.hoisted(() => vi.fn());
const reportError = vi.hoisted(() => vi.fn());
const getPreference = vi.hoisted(() => vi.fn(async (_key: string): Promise<number | null> => null));
const setPreference = vi.hoisted(() => vi.fn(async (_key: string, _value: number) => {}));

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Linking: { openURL },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryBackground: '#111', secondaryLabel: '#888', separator: '#333' } }),
}));
vi.mock('../../theme/tokens', () => ({
  borderRadius: { lg: 12 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20 },
}));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../Button', () => ({
  Button: ({ title, onPress, testID }: { title: string; onPress: () => void; testID?: string }) =>
    createElement('button', { 'data-testid': testID, onClick: onPress }, title),
}));
vi.mock('../../lib/analytics', () => ({ track }));
vi.mock('../../lib/error-reporting', () => ({ reportError }));
vi.mock('../../lib/preference-store', () => ({ getPreference, setPreference }));

const { AppStorePrompt, STORE_PROMPT_DISMISSED_AT_KEY, STORE_PROMPT_SNOOZE_MS, isStorePromptSnoozed } =
  await import('../AppStorePrompt.web');
const { AppStorePrompt: NativeAppStorePrompt } = await import('../AppStorePrompt');

function setUserAgent(userAgent: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  getPreference.mockResolvedValue(null);
  setUserAgent(ANDROID_CHROME);
});

afterEach(() => cleanup());

describe('AppStorePrompt.web', () => {
  it.each(['climb-view', 'login', 'home'] as const)('renders nothing on a desktop browser (%s)', async (surface) => {
    setUserAgent(MAC_SAFARI);
    const { container } = render(createElement(AppStorePrompt, { surface }));
    // Let the Home surface's preference read settle before asserting absence.
    await Promise.resolve();
    expect(container.innerHTML).toBe('');
    expect(getPreference).not.toHaveBeenCalled();
  });

  it('opens the tagged Play link from the climb view and counts the click', () => {
    render(createElement(AppStorePrompt, { surface: 'climb-view' }));

    const install = screen.getByTestId('store-prompt-install');
    expect(install.textContent).toBe('mobile.storePrompt.googlePlay');
    fireEvent.click(install);

    expect(track).toHaveBeenCalledWith('App Install Click', {
      platform: 'android',
      source: 'google-play',
      placement: 'browser-app-climb-view',
      utm_source: 'boardsesh',
      utm_medium: 'browser-app',
      utm_campaign: 'climb-view',
    });
    const openedUrl = new URL(openURL.mock.calls[0]?.[0] ?? '');
    expect(openedUrl.hostname).toBe('play.google.com');
    expect(new URLSearchParams(openedUrl.searchParams.get('referrer') ?? '').get('utm_campaign')).toBe('climb-view');
    // Counted first: if opening the store throws, the click is still recorded.
    expect(track.mock.invocationCallOrder[0]).toBeLessThan(openURL.mock.invocationCallOrder[0] ?? 0);
  });

  it('opens the tagged App Store link from the login screen on an iPhone', () => {
    setUserAgent(IPHONE_SAFARI);
    render(createElement(AppStorePrompt, { surface: 'login' }));

    const install = screen.getByTestId('store-prompt-install');
    expect(install.textContent).toBe('mobile.storePrompt.appStore');
    fireEvent.click(install);

    expect(track).toHaveBeenCalledWith(
      'App Install Click',
      expect.objectContaining({ platform: 'ios', source: 'app-store', placement: 'browser-app-login' }),
    );
    const openedUrl = new URL(openURL.mock.calls[0]?.[0] ?? '');
    expect(openedUrl.hostname).toBe('apps.apple.com');
    expect(openedUrl.searchParams.get('ct')).toBe('browser-app-login');
  });

  it('reports a store link that fails to open instead of throwing', async () => {
    const failure = new Error('popup blocked');
    openURL.mockRejectedValueOnce(failure);
    render(createElement(AppStorePrompt, { surface: 'login' }));

    fireEvent.click(screen.getByTestId('store-prompt-install'));

    await waitFor(() =>
      expect(reportError).toHaveBeenCalledWith(failure, { tags: { source: 'store-prompt', surface: 'login' } }),
    );
  });

  it('does not offer a dismiss on the climb view or the login screen', () => {
    render(createElement(AppStorePrompt, { surface: 'climb-view' }));
    render(createElement(AppStorePrompt, { surface: 'login' }));
    expect(screen.queryByTestId('store-prompt-dismiss')).toBeNull();
    expect(getPreference).not.toHaveBeenCalled();
  });

  it('shows the Home card once the stored answer is known, and remembers "Not now"', async () => {
    const now = 1_760_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    render(createElement(AppStorePrompt, { surface: 'home' }));

    // Hidden until the read settles, so it cannot flash at someone who said no.
    expect(screen.queryByTestId('store-prompt-home')).toBeNull();
    await screen.findByTestId('store-prompt-home');
    expect(getPreference).toHaveBeenCalledWith(STORE_PROMPT_DISMISSED_AT_KEY);

    fireEvent.click(screen.getByTestId('store-prompt-dismiss'));

    expect(screen.queryByTestId('store-prompt-home')).toBeNull();
    expect(setPreference).toHaveBeenCalledWith(STORE_PROMPT_DISMISSED_AT_KEY, now);
    expect(track).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('keeps the Home card hidden while "Not now" is still fresh', async () => {
    getPreference.mockResolvedValue(Date.now() - 1000);
    render(createElement(AppStorePrompt, { surface: 'home' }));

    await waitFor(() => expect(getPreference).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId('store-prompt-home')).toBeNull();
  });

  it('shows the Home card when the preference store cannot be read', async () => {
    getPreference.mockRejectedValue(new Error('IndexedDB blocked'));
    render(createElement(AppStorePrompt, { surface: 'home' }));

    await screen.findByTestId('store-prompt-home');
  });
});

describe('isStorePromptSnoozed', () => {
  const now = 1_760_000_000_000;

  it('is not snoozed when nothing was stored', () => {
    expect(isStorePromptSnoozed(null, now)).toBe(false);
  });

  it('is snoozed inside the window and not after it', () => {
    expect(isStorePromptSnoozed(now - STORE_PROMPT_SNOOZE_MS + 1, now)).toBe(true);
    expect(isStorePromptSnoozed(now - STORE_PROMPT_SNOOZE_MS, now)).toBe(false);
  });

  it('ignores a stored value that is not a number', () => {
    expect(isStorePromptSnoozed(Number.NaN, now)).toBe(false);
  });
});

describe('AppStorePrompt (native)', () => {
  it('renders nothing, whatever the surface', () => {
    const { container } = render(createElement(NativeAppStorePrompt, { surface: 'home' }));
    expect(container.innerHTML).toBe('');
  });
});
