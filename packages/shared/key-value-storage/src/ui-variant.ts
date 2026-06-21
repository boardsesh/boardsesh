// UI variant preference: the user's explicit choice of visual style on top of
// the platform default. `'auto'` (or absent) follows device capability —
// Liquid Glass where the OS can render it (iOS 26), Material everywhere else.
// `'liquidGlass'` and `'material'` force a skin regardless of the platform.
//
// Mobile persists this via SecureStore alongside the theme override, so the key
// uses only [\w.-] to satisfy expo-secure-store's validator (see theme.ts).
// Lives here next to THEME_OVERRIDE_KEY so a future server-side preference sync
// reads/writes the same slot.

export const UI_VARIANT_KEY = 'ui_variant';

export type UiVariantPreference = 'auto' | 'liquidGlass' | 'material';

export function isUiVariantPreference(value: unknown): value is UiVariantPreference {
  return value === 'auto' || value === 'liquidGlass' || value === 'material';
}
