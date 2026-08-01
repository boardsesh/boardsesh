// The non-credential SecureStore keys migrated into the v2 keychain namespace
// (#4103). Kept in its own module so auth-store — loaded on the app's very first
// token read — pulls in the migration engine without dragging every preference
// store and the i18n config into that path.
//
// Every literal is imported from the module that owns it rather than restated
// here: a re-declared key is how a store silently drops out of migration
// coverage after a rename.
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
import { LOCALE_OVERRIDE_KEY } from './i18n/locale-preference';
import { LAST_GRADE_KEY } from './last-grade-store';
import { LAST_SEARCH_KEY } from './last-search-store';
import { RECENT_FILTERS_KEY } from './recent-filter-store';
import { CREATED_SESSION_ID_KEY, SESSION_ID_KEY } from './session-store';

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
