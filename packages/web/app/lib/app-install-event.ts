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

/** Store the climber was sent to, as classified by the CTA that sent them. */
export type AppInstallPlatform = 'ios' | 'android' | 'web';

/** Which CTA fired. Historic values — do not rename, PH-13 breaks down on this. */
export type AppInstallSource = 'app-store' | 'google-play' | 'capacitor-retirement' | 'capacitor-retirement-fallback';

/**
 * Where on the page the CTA lives. Absent means the home page's onboarding
 * install card or the Capacitor dead-end screen, neither of which has ever
 * carried a placement — adding one would change their existing payloads.
 *
 * `gym-page` has no producer yet; the gym-page install CTA is #4379.
 */
export type AppInstallPlacement = 'hero' | 'gym-page';

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
};

export type AppInstallClickProperties = {
  platform: AppInstallPlatform;
  source: AppInstallSource;
  placement?: AppInstallPlacement;
  mode?: AppInstallMode;
  gymSlug?: string;
};

export function buildAppInstallClickProperties(input: AppInstallClickInput): AppInstallClickProperties {
  return {
    platform: input.platform,
    source: input.source,
    ...(input.placement === undefined ? {} : { placement: input.placement }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.gymSlug === undefined ? {} : { gymSlug: input.gymSlug }),
  };
}
