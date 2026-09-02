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
 * The ONE deliberate exception is the iPad "On the Wall" kiosk (see
 * `lib/board-presence/screenshot-wall-seed.ts`): the wall feed is a live
 * graphql-ws subscription keyed on a `boardId` only a BLE bind can set, and the
 * simulator has no Bluetooth, so there is no seeded-backend path to a lit wall.
 * That seed reuses the active board's REAL climbs (real frames), and — like every
 * flag here — is reached only from inlined `EXPO_PUBLIC_SCREENSHOT_MODE === '1'`
 * branches, so it dead-strips from normal builds.
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

/**
 * Board drawing the screenshots build pins, so a store set can never come back in
 * the old look because a default flipped or a preference leaked in.
 *
 * Deliberately a raw string: `board-render-settings.ts` runs it through the same
 * `pickOption` / `BOARD_RENDER_MODE_SETTINGS` sanitiser every stored preference
 * goes through, so `aura`, `classic` and `default` are all valid run values and
 * anything else falls back to the app default. Typing it here would mean
 * importing `BoardRenderModeSetting` from that module, which imports this one.
 *
 * Defaults to `aura` — the look the store listing is meant to show off, and what
 * a fresh install draws. Override per run with
 * `EXPO_PUBLIC_SCREENSHOT_RENDER_MODE=classic`.
 */
export const SCREENSHOT_RENDER_MODE: string = process.env.EXPO_PUBLIC_SCREENSHOT_RENDER_MODE?.trim() || 'aura';

/**
 * Which of the signed-in account's boards each board-backed shot renders, in
 * order: `[0]` is the board auto-activated on boot (so Climbs, the board view
 * and the iPad wall kiosk all sit on it), `[1]` is the second board-view shot's
 * wall (`?screenshotBoardIndex=1`).
 *
 * Pinned by name because position is not stable: `myBoards` comes back ordered
 * `isOwned DESC, createdAt DESC`, so "the first board" drifts every time the
 * account follows a new wall — which is how a MoonBoard ended up as the wall in
 * the App Store hero shots. Each entry is matched against the board's own name
 * and its layout name — see `screenshot-board-selection.ts`. In practice it is
 * the name that matches: `myBoards` returns a null `layoutName` for these rows.
 *
 * Override per run with a `|`-separated list:
 * `EXPO_PUBLIC_SCREENSHOT_BOARDS="My Home Wall|Kilter Board Homewall"`.
 */
const DEFAULT_SCREENSHOT_BOARDS = ["Marco's Board", 'High Point Climbing Orlando'];
const screenshotBoardsEnv = (process.env.EXPO_PUBLIC_SCREENSHOT_BOARDS ?? '')
  .split('|')
  .map((selector) => selector.trim())
  .filter(Boolean);
export const SCREENSHOT_BOARDS: string[] =
  screenshotBoardsEnv.length > 0 ? screenshotBoardsEnv : DEFAULT_SCREENSHOT_BOARDS;
