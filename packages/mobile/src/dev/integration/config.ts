import { isThemeOverride, isUiVariantPreference } from '@boardsesh/key-value-storage';
import { isSupportedLocale } from '@boardsesh/i18n';

const theme = process.env.EXPO_PUBLIC_SCREENSHOT_THEME;
const variant = process.env.EXPO_PUBLIC_SCREENSHOT_VARIANT;
const locale = process.env.EXPO_PUBLIC_SCREENSHOT_LOCALE;
export const appearance = {
  initialTheme: isThemeOverride(theme) ? theme : 'dark',
  initialVariant: isUiVariantPreference(variant) ? variant : 'auto',
  preferences: null,
} as const;
export const initialLocale = isSupportedLocale(locale) ? locale : undefined;
const requestedBoards =
  process.env.EXPO_PUBLIC_SCREENSHOT_BOARDS?.split('|')
    .map((selector) => selector.trim())
    .filter(Boolean) ?? [];
export const boardSelectors = requestedBoards.length
  ? requestedBoards
  : ['Boardsesh HQ', 'High Point Climbing Orlando'];
