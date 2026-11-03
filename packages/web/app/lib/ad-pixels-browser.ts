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

import { getWebConsentRecord, hasAnalyticsConsent, isGlobalPrivacyControlEnabled, refreshWebConsent } from './consent';
import { AD_PIXEL_COOKIE_NAMES, isAdMeasurementPermitted, resolveAdPixels, type AdPixelIds } from './ad-pixels';
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
let metaRevoked = false;
let lastPageViewPath: string | null = null;

function readBuildIds(): { metaPixelId: string | undefined; redditPixelId: string | undefined } {
  // Literal property reads, so Next inlines them at build time.
  return {
    metaPixelId: process.env.NEXT_PUBLIC_META_PIXEL_ID,
    redditPixelId: process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID,
  };
}

/** The pixels allowed right now, read from the live cookie. Both null on the server. */
export function currentAdPixels(pathname?: string): AdPixelIds {
  if (typeof window === 'undefined' || typeof document === 'undefined') return { meta: null, reddit: null };
  const { metaPixelId, redditPixelId } = readBuildIds();
  // Unset ids: a complete no-op, without even reading consent.
  if (!metaPixelId && !redditPixelId) return { meta: null, reddit: null };
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
  if (metaRevoked) {
    fbq('consent', 'grant');
    metaRevoked = false;
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

/** Expire a cookie on this host and on every parent domain it could have been set for. */
function expireCookie(name: string): void {
  const hostname = window.location.hostname;
  const labels = hostname.split('.');
  const domains: Array<string | null> = [null];
  for (let index = 0; index < labels.length - 1; index += 1) domains.push(labels.slice(index).join('.'));
  for (const domain of domains) {
    document.cookie = `${name}=; Max-Age=0; Path=/${domain ? `; Domain=${domain}` : ''}`;
  }
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
  if (pixelWindow.fbq && metaInitialized !== null && !metaRevoked) {
    pixelWindow.fbq('consent', 'revoke');
    metaRevoked = true;
  }
  lastPageViewPath = null;
  if (hasAnyPixelCookie()) AD_PIXEL_COOKIE_NAMES.forEach(expireCookie);
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
  metaRevoked = false;
  lastPageViewPath = null;
}
