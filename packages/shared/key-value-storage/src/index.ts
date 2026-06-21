// Pure-TS storage contract shared across web and mobile. Each app injects its
// own adapter (web: IndexedDB; mobile: SecureStore / AsyncStorage). The package
// also holds the key constants + type guards for any preference whose schema is
// the same shape on both platforms (today: theme override). New preference
// schemas can land here as additional modules, kept lean — if any one schema
// grows past a couple files it can graduate to its own `@boardsesh/<name>`
// package.

export type { KeyValueStorage } from './storage';
export { THEME_OVERRIDE_KEY, isThemeOverride, type ThemeOverride } from './theme';
export { UI_VARIANT_KEY, isUiVariantPreference, type UiVariantPreference } from './ui-variant';
export {
  ONBOARDING_SEEN_KEY,
  ONBOARDING_BOARD_TIP_KEY,
  ONBOARDING_TIP_WORKOUT_KEY,
  ONBOARDING_TIP_CREW_KEY,
  ONBOARDING_TIP_RECORD_KEY,
  ONBOARDING_TIP_ACCESSORY_KEY,
} from './onboarding';
export { CHANGELOG_LAST_SEEN_KEY } from './changelog';
