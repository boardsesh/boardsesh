import {
  isThemeOverride,
  isUiVariantPreference,
  type ThemeOverride,
  type UiVariantPreference,
} from '@boardsesh/key-value-storage';
import { isSupportedLocale, type Locale } from '@boardsesh/i18n';

/**
 * Build-time screenshot mode. The dedicated screenshots build (see
 * `scripts/mobile-screenshots.ts`) is compiled with `EXPO_PUBLIC_SCREENSHOT_MODE=1`;
 * every normal build leaves the var unset. It's the native analogue of the web
 * app-store flow's `sessionStorage` flags (`boardsesh:e2e-bluetooth-picker`,
 * `boardsesh:e2e-suppress-install-card`): a presentation-stability switch, not a
 * data-mocking layer — the seeded backend stays the source of truth.
 *
 * The boolean is intentionally NOT exported from here. Each consumer inlines the
 * raw comparison directly in its guard / ternary condition:
 *
 *   if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') { … }
 *   if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1') return;
 *
 * babel-preset-expo replaces `process.env.EXPO_PUBLIC_*` with a literal per
 * module, so in a minified release build the condition folds in place
 * (`undefined === '1'` → `false`) and terser dead-strips the branch — needing
 * only literal folding, no cross-module or cross-statement constant propagation.
 * Routing the flag through a shared export — or even a module-local
 * `const SCREENSHOT_MODE = …` — makes the strip lean on the minifier's
 * variable-propagation passes instead of plain literal folding. Keep the raw
 * `process.env.EXPO_PUBLIC_SCREENSHOT_MODE` comparison at each call site.
 *
 * The typed override helpers below stay shared: they're only read inside the
 * now-DCE-able branches, so they strip along with them.
 */

/**
 * Language the screenshots build locks to. The capture orchestrator starts Metro
 * once per app locale, so the override is baked into the bundle alongside theme
 * and workout. Normal builds leave this unset and keep device/user language
 * detection.
 */
const screenshotLocaleEnv = process.env.EXPO_PUBLIC_SCREENSHOT_LOCALE;
export const SCREENSHOT_LOCALE_OVERRIDE: Locale | null =
  process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && isSupportedLocale(screenshotLocaleEnv)
    ? screenshotLocaleEnv
    : null;

/**
 * Theme the screenshots build locks to so a capture can't flip mid-run when
 * SecureStore hydrates. Defaults to dark (the canonical store appearance, and
 * the app's default); override per run with `EXPO_PUBLIC_SCREENSHOT_THEME=light`.
 */
const screenshotThemeEnv = process.env.EXPO_PUBLIC_SCREENSHOT_THEME;
export const SCREENSHOT_THEME_OVERRIDE: ThemeOverride = isThemeOverride(screenshotThemeEnv)
  ? screenshotThemeEnv
  : 'dark';

/**
 * UI variant the screenshots build locks to. Defaults to `'auto'`, which already
 * resolves to Liquid Glass on iOS and Material on Android — the platform-native
 * look we want for store listings. Force one explicitly (e.g. to shoot the
 * Material skin on iOS) with `EXPO_PUBLIC_SCREENSHOT_VARIANT=material`.
 */
const screenshotVariantEnv = process.env.EXPO_PUBLIC_SCREENSHOT_VARIANT;
export const SCREENSHOT_VARIANT_PREFERENCE: UiVariantPreference = isUiVariantPreference(screenshotVariantEnv)
  ? screenshotVariantEnv
  : 'auto';

/**
 * Workout type the session/Record screen pre-selects in screenshot mode, so the
 * generator renders with a chosen workout (chart + generated preview) on load.
 * The workout shelf is a react-native-gesture-handler ScrollView, which doesn't
 * respond to Maestro's synthetic taps/swipes, so we can't pick it from the flow —
 * baking the initial selection is the reliable way. Empty/unset (the default)
 * leaves the generator "Off". Set e.g. `EXPO_PUBLIC_SCREENSHOT_WORKOUT=volume`.
 */
const SCREENSHOT_WORKOUT_TYPES = ['volume', 'pyramid', 'ladder', 'gradeFocus'] as const;
export type ScreenshotWorkout = (typeof SCREENSHOT_WORKOUT_TYPES)[number];
const screenshotWorkoutEnv = process.env.EXPO_PUBLIC_SCREENSHOT_WORKOUT;
export const SCREENSHOT_WORKOUT: ScreenshotWorkout | null = SCREENSHOT_WORKOUT_TYPES.includes(
  screenshotWorkoutEnv as ScreenshotWorkout,
)
  ? (screenshotWorkoutEnv as ScreenshotWorkout)
  : null;

/**
 * Credentials the app auto-signs-in with on boot in screenshot mode (see
 * `app/auth/login.tsx`), so the Maestro flows never type into the login form.
 * Typing the password makes iOS offer to save it, and that "Save Password?"
 * system dialog then covers every captured screen and sits over the board picker
 * so the board-pick tap misses. Baked by the orchestrator
 * (`scripts/mobile-screenshots.ts` for iOS; the CI `.env` for Android) from
 * SCREENSHOT_USER_EMAIL / SCREENSHOT_USER_PASSWORD. Empty in normal builds.
 */
export const SCREENSHOT_USER_EMAIL = process.env.EXPO_PUBLIC_SCREENSHOT_USER_EMAIL ?? '';
export const SCREENSHOT_USER_PASSWORD = process.env.EXPO_PUBLIC_SCREENSHOT_USER_PASSWORD ?? '';
