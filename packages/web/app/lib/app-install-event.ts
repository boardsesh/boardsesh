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
 *  - `help`: the store pair on /help. It sent no placement before #6027.
 *  - `join-page`: the session invite page, `app/join/[sessionId]` (#6004), the
 *    only placement that also sets `sessionId`.
 *  - `climb-view`, `climb-list`, `spray-climb`, `gyms-directory`,
 *    `site-banner`: reserved for the store buttons #6027 adds to the climb
 *    front doors, the gym directory and the site-wide banner. Declared here so
 *    those buttons and their store links share one vocabulary from the first
 *    commit.
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
  'gyms-directory',
  'join-page',
  'site-banner',
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
  /**
   * The session an invite page is for. Only ever set with `placement:
   * 'join-page'`, and only for an id that named a real session. Matches the
   * `.<session id>` suffix on the Google Play link id.
   */
  sessionId?: string;
};

export type AppInstallClickProperties = {
  platform: AppInstallPlatform;
  source: AppInstallSource;
  placement?: AppInstallPlacement;
  mode?: AppInstallMode;
  gymSlug?: string;
  qrMedium?: GymQrMedium;
  sessionId?: string;
};

export function buildAppInstallClickProperties(input: AppInstallClickInput): AppInstallClickProperties {
  return {
    platform: input.platform,
    source: input.source,
    ...(input.placement === undefined ? {} : { placement: input.placement }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.gymSlug === undefined ? {} : { gymSlug: input.gymSlug }),
    ...(input.qrMedium === undefined ? {} : { qrMedium: input.qrMedium }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  };
}
