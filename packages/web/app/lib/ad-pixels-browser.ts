// The DOM half of ad measurement on www: inject the Meta and Reddit pixel
// scripts, send page views and the Lead conversion, and withdraw. Every call
// asks `resolveAdPixels` (ad-pixels.ts) first, against the live consent
// cookie, so nothing loads or fires without consent and a withdrawal stops the
// very next event. See docs/analytics-consent.md#ad-pixels.
//
// No advanced matching anywhere: no email, no phone, no account id, no hashed
// identifiers. Meta's automatic events (button-click scraping, page metadata)
// and its own history-change page views are switched off, so the only events
// that leave are the ones this file sends.
//
// Never inside the retired Capacitor app's WebView: tracking there would be
// app tracking without Apple's ATT prompt, and the policy says pixels never
// run in the app. Its bridge appears slightly after page JS, so a WebView-like
// user agent waits for it (up to 3 s) before the first event.
//
// A withdrawal is final for the page load: fbevents.js keeps the old browser
// id in memory after its cookie is deleted, so a later Allow takes effect on
// the next page load with a fresh id.

import { getWebConsentRecord, hasAnalyticsConsent, isGlobalPrivacyControlEnabled, refreshWebConsent } from './consent';
import { AD_PIXEL_COOKIE_NAMES, adPixelCookieExpiries } from '@boardsesh/consent';
import { isAdMeasurementPermitted, resolveAdPixels, type AdPixelIds } from './ad-pixels';
import { isCapacitor, isCapacitorWebView, waitForCapacitor } from './ble/capacitor-utils';
import type { AppInstallPlacement, AppInstallPlatform } from './app-install-event';

type PixelCommand = (...args: unknown[]) => void;
type MetaPixelStub = PixelCommand & {
  callMethod?: PixelCommand;
  queue: unknown[][];
  push: MetaPixelStub;
  loaded: boolean;
  version: string;
  disablePushState?: boolean;
};
type RedditPixelStub = PixelCommand & {
  sendEvent?: PixelCommand;
  callQueue: unknown[][];
};
type PixelWindow = Window & {
  fbq?: MetaPixelStub;
  _fbq?: MetaPixelStub;
  rdt?: RedditPixelStub;
};

const META_SCRIPT_SRC = 'https://connect.facebook.net/en_US/fbevents.js';
const REDDIT_SCRIPT_SRC = 'https://www.redditstatic.com/ads/pixel.js';

let metaInitialized: string | null = null;
let redditInitialized: string | null = null;
let withdrawnThisPage = false;
let lastPageViewPath: string | null = null;
let latestSyncPath: string | null = null;
/** `pending` while a WebView-like browser waits to see whether the Capacitor bridge appears. */
let nativeShell: 'unknown' | 'pending' | 'absent' | 'present' = 'unknown';

const NO_PIXELS: AdPixelIds = { meta: null, reddit: null };

/**
 * True once we know this page is not the Capacitor app. Starts the bridge wait
 * the first time a WebView-like user agent asks, then re-syncs when it ends.
 */
function nativeShellCleared(): boolean {
  if (isCapacitor()) nativeShell = 'present';
  if (nativeShell === 'present') return false;
  if (nativeShell === 'absent') return true;
  if (!isCapacitorWebView()) {
    nativeShell = 'absent';
    return true;
  }
  if (nativeShell === 'unknown') {
    nativeShell = 'pending';
    void waitForCapacitor().then((appeared) => {
      nativeShell = appeared ? 'present' : 'absent';
      if (!appeared && latestSyncPath !== null) syncAdPixels(latestSyncPath);
    });
  }
  return false;
}

function readBuildIds(): { metaPixelId: string | undefined; redditPixelId: string | undefined } {
  // Literal property reads, so Next inlines them at build time.
  return {
    metaPixelId: process.env.NEXT_PUBLIC_META_PIXEL_ID,
    redditPixelId: process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID,
  };
}

/** The pixels allowed right now, read from the live cookie. Both null on the server. */
export function currentAdPixels(pathname?: string): AdPixelIds {
  if (typeof window === 'undefined' || typeof document === 'undefined') return NO_PIXELS;
  const { metaPixelId, redditPixelId } = readBuildIds();
  // Unset ids: a complete no-op, without even reading consent.
  if (!metaPixelId && !redditPixelId) return NO_PIXELS;
  if (withdrawnThisPage || !nativeShellCleared()) return NO_PIXELS;
  return resolveAdPixels({
    metaPixelId,
    redditPixelId,
    // hasAnalyticsConsent() re-reads the shared cookie first, so a withdrawal
    // on app.boardsesh.com is seen here before the record below is read.
    analyticsAuthorized: hasAnalyticsConsent(),
    record: getWebConsentRecord(),
    globalPrivacyControl: isGlobalPrivacyControlEnabled(),
    pathname: pathname ?? window.location.pathname,
    hostname: window.location.hostname,
  });
}

function injectScript(src: string): void {
  const script = document.createElement('script');
  script.async = true;
  script.src = src;
  document.head.appendChild(script);
}

function ensureMeta(pixelId: string): MetaPixelStub {
  const pixelWindow = window as PixelWindow;
  if (!pixelWindow.fbq) {
    // Meta's documented loader stub, unrolled: queue calls until fbevents.js
    // arrives and takes over.
    const stub = function (...args: unknown[]) {
      if (stub.callMethod) stub.callMethod(...args);
      else stub.queue.push(args);
    } as MetaPixelStub;
    stub.push = stub;
    stub.loaded = true;
    stub.version = '2.0';
    stub.queue = [];
    // Our client-side navigations send their own PageView; Meta's history
    // listener would double them and would keep running after a withdrawal.
    stub.disablePushState = true;
    pixelWindow.fbq = stub;
    if (!pixelWindow._fbq) pixelWindow._fbq = stub;
    injectScript(META_SCRIPT_SRC);
  }
  const fbq = pixelWindow.fbq;
  if (metaInitialized !== pixelId) {
    // Before init: no automatic button-click or page-metadata events.
    fbq('set', 'autoConfig', false, pixelId);
    fbq('init', pixelId);
    metaInitialized = pixelId;
  }
  return fbq;
}

function ensureReddit(pixelId: string): RedditPixelStub {
  const pixelWindow = window as PixelWindow;
  if (!pixelWindow.rdt) {
    const stub = function (...args: unknown[]) {
      if (stub.sendEvent) stub.sendEvent(...args);
      else stub.callQueue.push(args);
    } as RedditPixelStub;
    stub.callQueue = [];
    pixelWindow.rdt = stub;
    injectScript(REDDIT_SCRIPT_SRC);
  }
  const rdt = pixelWindow.rdt;
  if (redditInitialized !== pixelId) {
    rdt('init', pixelId);
    redditInitialized = pixelId;
  }
  return rdt;
}

function hasAnyPixelCookie(): boolean {
  const names = document.cookie.split(';').map((entry) => entry.trim().split('=', 1)[0]);
  return AD_PIXEL_COOKIE_NAMES.some((name) => names.includes(name));
}

/**
 * Withdraw: tell a loaded Meta pixel consent is revoked (it then sends nothing
 * and writes no cookie) and delete the pixels' first-party cookies. Reddit has
 * no revoke call; it sends only what we ask it to, and we stop asking.
 */
function withdrawAdPixels(): void {
  const pixelWindow = window as PixelWindow;
  if (metaInitialized !== null || redditInitialized !== null) {
    if (pixelWindow.fbq && metaInitialized !== null) pixelWindow.fbq('consent', 'revoke');
    withdrawnThisPage = true;
  }
  lastPageViewPath = null;
  if (hasAnyPixelCookie()) {
    for (const expiry of adPixelCookieExpiries(window.location.hostname)) document.cookie = expiry;
  }
}

/**
 * Bring the pixels in line with consent and send a page view for `pathname`
 * when it is a new page. Called on mount, on every client-side navigation and
 * on every consent change.
 */
export function syncAdPixels(pathname: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const { metaPixelId, redditPixelId } = readBuildIds();
  if (!metaPixelId && !redditPixelId) return;
  latestSyncPath = pathname;
  // Pick up a cookie another origin or tab wrote before judging it.
  refreshWebConsent();

  // A definitive no (No thanks, no answer, an Allow older than the copy, GPC)
  // withdraws. A transient hold (account still resolving, region lookup not
  // back yet) only pauses: deleting the browser id there would reset it on
  // every page load.
  if (!isAdMeasurementPermitted(getWebConsentRecord(), isGlobalPrivacyControlEnabled())) {
    withdrawAdPixels();
    return;
  }
  const pixels = currentAdPixels(pathname);
  if (pixels.meta === null && pixels.reddit === null) return;
  if (pathname === lastPageViewPath) return;
  lastPageViewPath = pathname;
  if (pixels.meta) ensureMeta(pixels.meta)('track', 'PageView');
  if (pixels.reddit) ensureReddit(pixels.reddit)('track', 'PageVisit');
}

export type AdLeadInput = {
  platform: AppInstallPlatform;
  placement?: AppInstallPlacement;
};

/**
 * The store-button conversion. Sent as each platform's standard `Lead`, with
 * where the button was and which store it opened. A no-op without consent.
 */
export function reportAdLead({ platform, placement }: AdLeadInput): void {
  const pixels = currentAdPixels();
  if (pixels.meta === null && pixels.reddit === null) return;
  const customData = { platform, placement: placement ?? 'none' };
  if (pixels.meta) ensureMeta(pixels.meta)('track', 'Lead', customData);
  if (pixels.reddit) ensureReddit(pixels.reddit)('track', 'Lead', customData);
}

/** Test seam: forget everything this module set up. */
export function resetAdPixelsForTests(): void {
  metaInitialized = null;
  redditInitialized = null;
  withdrawnThisPage = false;
  lastPageViewPath = null;
  latestSyncPath = null;
  nativeShell = 'unknown';
}
