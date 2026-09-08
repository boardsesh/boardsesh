// The non-credential SecureStore keys migrated into the v2 keychain namespace
// (#4103). Kept in its own module so auth-store — loaded on the app's very first
// token read — pulls in the migration engine without dragging every preference
// store and the i18n config into that path.
//
// Every literal is imported from the module that owns it rather than restated
// here: a re-declared key is how a store silently drops out of migration
// coverage after a rename. Two of those literals live in a module of their own
// rather than with their store, because importing them from the store would be
// unsafe or expensive:
//
// * session-store-keys.ts — session-store.ts has a session-store.web.ts sibling,
//   and Metro resolves `./session-store` to that fork on the browser target,
//   where the keys are not exported. This list would silently get `undefined`.
// * i18n/locale-preference-key.ts — locale-preference.ts reaches i18next,
//   react-i18next and every catalog through ./config, which is a lot of module
//   graph to load for one string.
//
// preference-secure-keys.test.ts guards the two ways an entry here can go wrong:
// it pins the sixteen literals so a rename shows up as a diff, and it reads this
// file's imports and fails if any of them names a module with a `.web` sibling —
// the fork hazard above, which no value assertion can see because Vitest and tsc
// both resolve to the native file.
//
// What nothing guards is a NEW key: the list is maintained by hand, so adding a
// SecureStore key to a store means adding it here too, or it stays WHEN_UNLOCKED
// on iOS and its background read keeps failing. Phase 2 (#4128) retires the list
// entirely, so a completeness check against every `*_KEY` export in the repo
// would be scaffolding with a short shelf life.
//
// Two keys are deliberately absent:
//
// * boardsesh_party_profile — the analytics id, read synchronously at
//   module-eval time (party-profile-store.ts:38) before any migration could run,
//   with its failure already swallowed into a null that falls back to PostHog's
//   own anonymous id. It contributes nothing to the background-read failures
//   this fixes; the only gain would be analytics linkage on locked background
//   launches. Not worth widening the blast radius of a change to credential
//   storage. Revisit in phase 2 if that linkage turns out to matter.
//
// * boardsesh_dev_metro_hosts — dev-only, and already read-and-deleted on its way
//   to AsyncStorage (metro-target-store.ts:25). Nothing writes it any more.

import {
  CHANGELOG_LAST_SEEN_KEY,
  ONBOARDING_BOARD_TIP_KEY,
  ONBOARDING_SEEN_KEY,
  ONBOARDING_TIP_ACCESSORY_KEY,
  ONBOARDING_TIP_CREW_KEY,
  ONBOARDING_TIP_QUICKACTIONS_KEY,
  ONBOARDING_TIP_RECORD_KEY,
  ONBOARDING_TIP_WORKOUT_KEY,
  THEME_OVERRIDE_KEY,
  UI_VARIANT_KEY,
} from '@boardsesh/key-value-storage';
import { LOCALE_OVERRIDE_KEY } from './i18n/locale-preference-key';
import { LAST_GRADE_KEY } from './last-grade-store';
import { LAST_SEARCH_KEY } from './last-search-store';
import { RECENT_FILTERS_KEY } from './recent-filter-store';
import { CREATED_SESSION_ID_KEY, SESSION_ID_KEY } from './session-store-keys';

export const PREFERENCE_SECURE_KEYS: readonly string[] = [
  SESSION_ID_KEY,
  CREATED_SESSION_ID_KEY,
  LAST_GRADE_KEY,
  RECENT_FILTERS_KEY,
  LAST_SEARCH_KEY,
  LOCALE_OVERRIDE_KEY,
  THEME_OVERRIDE_KEY,
  UI_VARIANT_KEY,
  CHANGELOG_LAST_SEEN_KEY,
  ONBOARDING_SEEN_KEY,
  ONBOARDING_BOARD_TIP_KEY,
  ONBOARDING_TIP_WORKOUT_KEY,
  ONBOARDING_TIP_CREW_KEY,
  ONBOARDING_TIP_RECORD_KEY,
  ONBOARDING_TIP_ACCESSORY_KEY,
  ONBOARDING_TIP_QUICKACTIONS_KEY,
];
