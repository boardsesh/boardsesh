// Store links for the Expo browser app (app.boardsesh.com), tagged so an
// install that starts here can be told apart from one that starts on www (#6027).
//
// These tags go on the store URL only, where Play's install referrer and its
// acquisition report read them:
//
//   utm_source   = boardsesh        (who sent the click)
//   utm_medium   = browser-app      (which property: www links say otherwise)
//   utm_campaign = <surface>        (which screen the prompt sat on)
//
// Android: Play fills the Install Referrer API from the `referrer` query
// parameter and nothing else, and `install-referrer.ts` splits that string as a
// query string. So `referrer` carries a nested, percent-encoded copy of the
// three params. The bare `utm_*` copies stay because Play's own acquisition
// report reads those.
//
// iOS: Apple has no install referrer. The campaign token `ct` is the only field
// that survives, it is capped at 40 characters, and it is a single value, so
// medium and surface are joined into it. It shows up in App Analytics only once
// the provider token (`pt`) is on the link too, and the provider id is not in
// this repo yet. `storeUrlForBrowserApp` takes it as an optional argument so
// adding it later is a one-line change with no new link format.
//
// Pure TS, no platform imports: only the `.web.tsx` prompt imports this, so it
// never reaches a native bundle.

// Same two URLs as `app.config.ts`, which is build-time config and cannot be
// imported from here. `store-links.test.ts` pins the two together.
export const IOS_APP_STORE_URL = 'https://apps.apple.com/app/boardsesh/id6761350784';
export const ANDROID_PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.boardsesh.app';

export const BROWSER_APP_UTM_SOURCE = 'boardsesh';
export const BROWSER_APP_UTM_MEDIUM = 'browser-app';

/** Apple's documented limit for the `ct` campaign token. */
export const APP_STORE_CAMPAIGN_TOKEN_MAX_LENGTH = 40;

/** The screens that carry the prompt. Also the `utm_campaign` value: do not rename. */
export type StorePromptSurface = 'climb-view' | 'login' | 'home';

/** Which store a browser can install from. */
export type StorePlatform = 'ios' | 'android';

/**
 * The store a phone or tablet browser can install from, or null when there is
 * none to offer.
 *
 * Null covers three groups on purpose:
 * - desktop browsers: the browser app is the product there, a store link is not;
 * - HarmonyOS: its user agent says "Android" for compatibility, but the device
 *   has no Play Store, so the link would open a page that cannot install;
 * - iPadOS in desktop mode, which reports itself as a Mac. Touch-point sniffing
 *   would catch it, but it would also catch touch-screen Macs that do not exist
 *   yet, and an iPad in that mode has the room to run the browser app.
 */
export function detectStorePlatform(userAgent: string | null | undefined): StorePlatform | null {
  if (!userAgent) return null;
  if (/HarmonyOS|OpenHarmony/i.test(userAgent)) return null;
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  return null;
}

/** The `ct` value for a surface, e.g. `browser-app-login`. */
export function appStoreCampaignToken(surface: StorePromptSurface): string {
  return `${BROWSER_APP_UTM_MEDIUM}-${surface}`.slice(0, APP_STORE_CAMPAIGN_TOKEN_MAX_LENGTH);
}

/** The Play link for a surface, with the install referrer set. */
export function playStoreUrlForBrowserApp(surface: StorePromptSurface): string {
  // The value Play hands the app verbatim. It is built as a query string and
  // then encoded once as a parameter value, which is the shape the parser in
  // `install-referrer.ts` expects.
  const referrer = new URLSearchParams({
    utm_source: BROWSER_APP_UTM_SOURCE,
    utm_medium: BROWSER_APP_UTM_MEDIUM,
    utm_campaign: surface,
  });

  const url = new URL(ANDROID_PLAY_STORE_URL);
  url.searchParams.set('utm_source', BROWSER_APP_UTM_SOURCE);
  url.searchParams.set('utm_medium', BROWSER_APP_UTM_MEDIUM);
  url.searchParams.set('utm_campaign', surface);
  url.searchParams.set('referrer', referrer.toString());
  return url.toString();
}

/** The App Store link for a surface, with the campaign token set. */
export function appStoreUrlForBrowserApp(surface: StorePromptSurface, providerToken?: string): string {
  const url = new URL(IOS_APP_STORE_URL);
  if (providerToken) url.searchParams.set('pt', providerToken);
  url.searchParams.set('ct', appStoreCampaignToken(surface));
  // 8 = iOS app. Apple's campaign-link generator always emits it.
  url.searchParams.set('mt', '8');
  return url.toString();
}

export function storeUrlForBrowserApp(platform: StorePlatform, surface: StorePromptSurface): string {
  return platform === 'android' ? playStoreUrlForBrowserApp(surface) : appStoreUrlForBrowserApp(surface);
}

// `App Install Click` is www's event (packages/web/app/lib/app-install-event.ts).
// The browser app fires the same name with the same `platform` and `source`
// values so one tile counts store clicks across both properties. They stay
// separable: these arrive with `$lib = posthog-react-native` and
// `environment = production-web`, and `placement` is prefixed `browser-app-`.
//
// The event carries NO `utm_*` properties. Those names are reserved for the
// campaign that brought a visitor IN: PostHog copies them onto the person
// (`utm_source`, and `$initial_utm_source` set once), so the outbound link's
// tags there would label a store clicker as acquired by "boardsesh". The
// `placement` already says which property and which screen.
export const APP_INSTALL_CLICK_EVENT = 'App Install Click';

export type BrowserAppInstallClickProperties = {
  platform: StorePlatform;
  /** Historic www values. PH-13 breaks down on this, so they are not renamed here. */
  source: 'app-store' | 'google-play';
  placement: `browser-app-${StorePromptSurface}`;
};

export function buildBrowserAppInstallClickProperties(
  platform: StorePlatform,
  surface: StorePromptSurface,
): BrowserAppInstallClickProperties {
  return {
    platform,
    source: platform === 'android' ? 'google-play' : 'app-store',
    placement: `browser-app-${surface}`,
  };
}
