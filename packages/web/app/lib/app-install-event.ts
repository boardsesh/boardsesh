// The single builder for `App Install Click`, the event every "get the app"
// CTA on www fires.
//
// It predates the gym funnel and is deliberately NOT one of the gym-funnel
// contract's events: PH-13 reads one install funnel broken down by `source`,
// and forking a second event for the gym page would split that number in half.
// The gym page's install CTA (#4379) extends this payload with `placement:
// 'gym-page'` and a `gymSlug` instead.
//
// PAYLOAD STABILITY: the five call sites that existed before this module —
// three in `app/home-page-content.tsx`, two in
// `app/components/capacitor-retirement/capacitor-retirement-screen.tsx` — emit
// byte-identical objects through it. That is why every field past `platform`
// and `source` is optional AND omitted rather than emitted as `undefined`: a
// key with an `undefined` value is a different object to a deep-equality
// assertion, and `sanitizeForPosthog` would strip it anyway, so writing it
// would only make "not applicable" indistinguishable from "not instrumented".

import type { GymQrMedium } from '@boardsesh/analytics';

/** Store the climber was sent to, as classified by the CTA that sent them. */
export type AppInstallPlatform = 'ios' | 'android' | 'web';

/** Which CTA fired. Historic values — do not rename, PH-13 breaks down on this. */
export type AppInstallSource = 'app-store' | 'google-play' | 'capacitor-retirement' | 'capacitor-retirement-fallback';

/**
 * Every placement a store button can have, in one list so a runtime check and
 * the type cannot drift.
 *
 *  - `hero`: the home page hero.
 *  - `gym-page`: `app/gym/[gym_slug]/gym-install-cta.tsx` (#4379), the only
 *    placement that also sets `gymSlug`.
 *  - `help`: the store pair on /help and on its seven sub-pages. It sent no
 *    placement before #6027.
 *  - `climb-view`: a climb page, in both route trees (`ClimbFrontDoor`): the
 *    phone's store badge (`MobileStorePrimary`).
 *  - `climb-qr-card`: the store pair in the QR card a climb page shows from md
 *    (`PhoneQrCard`), so a laptop's store click reads apart from a phone's.
 *  - `climb-list`: a board's climb list (`StaticListFrontDoor`): the phone's
 *    store badge.
 *  - `climb-list-qr-card`: the store pair in the QR card a board list shows
 *    from md, apart from the phone's badge like `climb-qr-card`.
 *  - `setter`: a setter's page: the store pair under the header, phones only
 *    since the QR card took its place from md.
 *  - `setter-qr-card`: the store pair in the QR card a setter's page shows
 *    from md.
 *  - `playlist`: a playlist's page: the phone's store badge.
 *  - `playlist-qr-card`: the store pair in the QR card a public playlist shows
 *    from md.
 *  - `home-qr-card`: the store badges in the QR card the home hero shows from
 *    1100px, apart from the phone's badge, which keeps `hero`.
 *  - `setup-report`: the store badge (both badges from md) in the report
 *    dialog after a climber's suggested setup changed a board for everyone
 *    ("Climb it now in the Boardsesh app", docs/product/directory-reports.md).
 *  - `spray-climb`: a climb on a spray wall (`SprayClimbFrontDoor`).
 *  - `spray-wall`: a Spraywall's own page (`SprayWallFrontDoor`), where its
 *    share link and its printed QR land (#4415). After a scan the link id is
 *    `spray-wall.board`; nothing in it names the wall.
 *  - `gyms-directory`: `/gyms` and its three board pages.
 *  - `sticky-bar`: the install strip at the bottom of a phone's climb page
 *    (`StickyInstallBar`), on Android and on iOS browsers that show no Smart
 *    App Banner.
 *  - `climb-app-module`: the store pair under "What you get in the app" near
 *    the end of a climb page (`ClimbAppShowcase`), so a click after reading
 *    the app's benefits reads apart from the hero's.
 *  - `site-banner`: the iOS Smart App Banner (`smart-app-banner.ts`). It is a
 *    campaign token only; Safari reports no tap, so no click carries it.
 *  - `bring-your-logbook`: the Kilter and Tension import guide.
 *  - `auth-login`: store buttons beneath the sign-in and registration form.
 *  - `join-page`: reserved for the session invite page (#6004), so that button
 *    and its store link share one vocabulary from the first commit.
 *
 * The placement is also the store link's id (`utm_content` on Google Play, `ct`
 * on the App Store, see `store-links.ts`), so a value here is a string that ends
 * up in install data. Add members; do not rename them.
 *
 * These are www's values only. The browser app fires the same event with
 * `browser-app-<surface>` placements from its own builder,
 * `packages/mobile/src/lib/store-links.ts`.
 */
export const APP_INSTALL_PLACEMENTS = [
  'hero',
  'gym-page',
  'help',
  'climb-view',
  'climb-list',
  'spray-climb',
  'spray-wall',
  'spraywalls',
  'gyms-directory',
  'bring-your-logbook',
  'join-page',
  'site-banner',
  'header',
  'setter',
  'playlist',
  'playlists',
  'board-compat',
  'home-chip',
  'help-spray',
  'logbook-import',
  'sticky-bar',
  'about',
  'support',
  'run-a-wall',
  'auth-login',
  'climb-qr-card',
  'climb-app-module',
  'climb-list-qr-card',
  'setter-qr-card',
  'playlist-qr-card',
  'home-qr-card',
  'setup-report',
  'compare-hub',
  'compare-kilter',
  'compare-aurora',
  'compare-moonboard',
  'compare-woods',
  'compare-spray',
] as const;

/**
 * Where on the page the CTA lives. Absent means the Capacitor dead-end screen,
 * which has never carried a placement, or an event from before a surface was
 * given one.
 */
export type AppInstallPlacement = (typeof APP_INSTALL_PLACEMENTS)[number];

/**
 * Whether the CTA offers a first install or an update. Only the home hero
 * distinguishes the two (a retired Capacitor straggler gets "update").
 */
export type AppInstallMode = 'install' | 'update';

export const APP_INSTALL_CLICK_EVENT = 'App Install Click';

export type AppInstallClickInput = {
  platform: AppInstallPlatform;
  source: AppInstallSource;
  placement?: AppInstallPlacement;
  mode?: AppInstallMode;
  /** Slug of the gym page the install CTA was rendered on. Only ever set with `placement: 'gym-page'`. */
  gymSlug?: string;
  /**
   * The printed medium the page was reached through (`?src=qr&medium=…`), when
   * the click follows a scan. Absent, never `null`, for a visit that did not
   * come off a code. Matches the `.poster` suffix on the store link's id.
   */
  qrMedium?: GymQrMedium;
};

export type AppInstallClickProperties = {
  platform: AppInstallPlatform;
  source: AppInstallSource;
  placement?: AppInstallPlacement;
  mode?: AppInstallMode;
  gymSlug?: string;
  qrMedium?: GymQrMedium;
};

export function buildAppInstallClickProperties(input: AppInstallClickInput): AppInstallClickProperties {
  return {
    platform: input.platform,
    source: input.source,
    ...(input.placement === undefined ? {} : { placement: input.placement }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.gymSlug === undefined ? {} : { gymSlug: input.gymSlug }),
    ...(input.qrMedium === undefined ? {} : { qrMedium: input.qrMedium }),
  };
}
