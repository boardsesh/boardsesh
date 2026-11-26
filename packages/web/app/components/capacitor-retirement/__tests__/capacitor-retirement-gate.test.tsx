import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import frenchCommon from '@boardsesh/i18n/locales/fr/common.json';
import { CapacitorRetirementGate } from '../capacitor-retirement-gate';
import { CAPACITOR_BRIDGE_TIMEOUT_MS } from '@/app/lib/ble/capacitor-utils';
import { track } from '@/app/lib/analytics-capture';

/**
 * Detection is deliberately NOT mocked here. The one property this whole change
 * has to guarantee is that a browser user never sees the takeover, and mocking
 * `isNativeApp` would only prove the gate honours a boolean it was handed. So
 * `capacitor-utils` stays real and these tests drive `window.Capacitor` and the
 * user agent directly.
 */
vi.mock('@/app/lib/analytics-capture', () => ({
  track: vi.fn(),
}));
vi.mock('../capacitor-retirement-screen', () => ({
  __esModule: true,
  default: () => <div>RETIREMENT SCREEN</div>,
  CapacitorRetirementScreen: () => <div>RETIREMENT SCREEN</div>,
}));

const mockedTrack = vi.mocked(track);

const APP_CONTENT = 'THE APP';
const SCREEN_CONTENT = 'RETIREMENT SCREEN';

const IOS_WEBVIEW_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IOS_SAFARI_UA = `${IOS_WEBVIEW_UA} Safari/604.1`;

function setUserAgent(userAgent: string) {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
}

function setCapacitor(value: unknown) {
  Object.defineProperty(window, 'Capacitor', { value, configurable: true, writable: true });
}

function renderGate() {
  return render(
    <CapacitorRetirementGate>
      <div>{APP_CONTENT}</div>
    </CapacitorRetirementGate>,
  );
}

const originalUserAgent = navigator.userAgent;

beforeEach(() => {
  mockedTrack.mockReset();
  setCapacitor(undefined);
  setUserAgent(originalUserAgent);
});

afterEach(() => {
  setUserAgent(originalUserAgent);
  setCapacitor(undefined);
});

describe('CapacitorRetirementGate — must never fire outside the retired app', () => {
  it('renders the app untouched in a normal browser', () => {
    renderGate();
    expect(screen.getByText(APP_CONTENT)).toBeTruthy();
    expect(screen.queryByText(SCREEN_CONTENT)).toBeNull();
    expect(mockedTrack).not.toHaveBeenCalled();
  }, 20000);

  it('renders the app when a Capacitor global exists but reports a web platform', () => {
    // Belt and braces: Capacitor's own web target sets the global too.
    setCapacitor({ isNativePlatform: () => false, getPlatform: () => 'web', Plugins: {} });
    renderGate();
    expect(screen.getByText(APP_CONTENT)).toBeTruthy();
    expect(screen.queryByText(SCREEN_CONTENT)).toBeNull();
  });

  it('renders the app in an in-app browser whose UA looks like a WebView but has no bridge', async () => {
    // Instagram/Facebook WKWebViews look like this. The gate waits for a bridge
    // that never comes, and must still never take over.
    setUserAgent(IOS_WEBVIEW_UA);
    renderGate();
    expect(screen.getByText(APP_CONTENT)).toBeTruthy();
    // Wait out the whole CAPACITOR_BRIDGE_TIMEOUT_MS window plus a margin, so
    // this asserts "gave up and left the app alone" rather than racing a
    // still-pending poll — a short sleep here would be a coin flip on CI.
    await new Promise((resolve) => setTimeout(resolve, CAPACITOR_BRIDGE_TIMEOUT_MS + 500));
    expect(screen.queryByText(SCREEN_CONTENT)).toBeNull();
    expect(screen.getByText(APP_CONTENT)).toBeTruthy();
    expect(mockedTrack).not.toHaveBeenCalled();
  }, 20000);

  it('renders the app on mobile Safari', () => {
    setUserAgent(IOS_SAFARI_UA);
    renderGate();
    expect(screen.getByText(APP_CONTENT)).toBeTruthy();
    expect(screen.queryByText(SCREEN_CONTENT)).toBeNull();
  });
});

describe('CapacitorRetirementGate — inside the retired app', () => {
  it('replaces the whole app with the update screen', async () => {
    setCapacitor({ isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} });
    renderGate();
    expect(await screen.findByText(SCREEN_CONTENT)).toBeTruthy();
    // The app is unmounted, not merely covered — BLE, sockets and presence go
    // with it rather than running invisibly behind a blocking screen.
    expect(screen.queryByText(APP_CONTENT)).toBeNull();
    expect(mockedTrack).toHaveBeenCalledWith('Capacitor Retirement Screen Shown', { platform: 'ios' });
  });

  it('focuses the store action with the marketing document’s translated copy', async () => {
    setCapacitor({ isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} });
    const copy = frenchCommon.capacitorRetirement;
    render(<CapacitorRetirementGate copy={copy}>{APP_CONTENT}</CapacitorRetirementGate>);

    expect(await screen.findByText(copy.title, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText(APP_CONTENT)).toBeNull();
    expect(screen.getByText(copy.description)).toBeTruthy();
    expect(screen.getByText(copy.fallbackCta)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByText(copy.cta).closest('button'));
  }, 10000);

  it('still takes over when the bridge is injected after the app mounts', async () => {
    // The real race: app JS runs before window.Capacitor appears. A one-shot
    // isNativeApp() check would wave the straggler through here. The user agent
    // is deliberately left alone — the poll must not depend on a UA heuristic,
    // or a shell with an unexpected UA is missed silently.
    renderGate();
    expect(screen.getByText(APP_CONTENT)).toBeTruthy();

    setCapacitor({ isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} });

    await waitFor(() => expect(screen.queryByText(SCREEN_CONTENT)).toBeTruthy(), { timeout: 4000 });
    expect(screen.queryByText(APP_CONTENT)).toBeNull();
    expect(mockedTrack).toHaveBeenCalledWith('Capacitor Retirement Screen Shown', { platform: 'android' });
  }, 10000);
});
