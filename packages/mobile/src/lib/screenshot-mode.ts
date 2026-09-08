import { mulberry32, type RandomSource } from './seeded-random';
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
 *
 * ## Frozen clock
 *
 * Relative timestamps ("3h ago", day dividers, the activity-heatmap window)
 * read the wall clock, so two captures of the same seeded backend data would
 * otherwise render different text. `SCREENSHOT_NOW_MS` below pins "now" to
 * `EXPO_PUBLIC_SCREENSHOT_NOW` (an ISO timestamp); every "now" read in the app
 * goes through `nowMs()`/`nowDate()` in `lib/clock.ts` instead of
 * `Date.now()`/`new Date()` directly. `SCREENSHOT_NOW_MS` is read by
 * `lib/clock.ts` and the boot log in `screenshot-board-auto-activator.tsx`.
 *
 * The orchestrator (`scripts/mobile-screenshots.ts`) sets
 * `EXPO_PUBLIC_SCREENSHOT_NOW` whenever `--fixtures` is on, from the fixture
 * set's `frozenNow`. A capture without fixtures leaves it unset and runs on the
 * live clock.
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
 * Instant the screenshots build freezes "now" to, so relative timestamps ("3h
 * ago", day dividers, the activity heatmap window) render identically across
 * repeated captures of the same seeded backend data. Read as an ISO timestamp
 * from `EXPO_PUBLIC_SCREENSHOT_NOW`. `null` in normal builds (and for an
 * unset/unparseable value in screenshot mode), which keeps the real wall
 * clock — see `lib/clock.ts` and the boot log in
 * `screenshot-board-auto-activator.tsx`, its two readers.
 *
 * Set by the orchestrator (`scripts/mobile-screenshots.ts`, into Metro's env on
 * both platforms) from the recorded fixture set's `frozenNow` whenever
 * `--fixtures` is on; unset for a capture that talks to a live backend, which
 * then runs on the real clock.
 *
 * What makes local-date derivations (day dividers, the heatmap's today cell)
 * agree between a developer's machine and CI is the timezone pin, not the value
 * itself: every capture runs the app in UTC (`SIMCTL_CHILD_TZ` on iOS,
 * `-timezone UTC` on the emulator). The recorded instant is the true recording
 * time to the second, so nothing in the recorded data can read as being in the
 * future.
 */
const screenshotNowEnv = process.env.EXPO_PUBLIC_SCREENSHOT_NOW;
const screenshotNowParsedMs = Date.parse(screenshotNowEnv ?? '');
export const SCREENSHOT_NOW_MS: number | null =
  process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && Number.isFinite(screenshotNowParsedMs)
    ? screenshotNowParsedMs
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
 *
 * These name real boards on the store capture account, which is account-specific
 * data in app source — deliberately. The alternative is CI env, and there is no
 * single place to put it: iOS bakes the bundle through
 * `scripts/mobile-screenshots.ts`, Android through a `.env` its workflow writes
 * before Gradle. Splitting the default across those two would let the platforms
 * shoot different walls, which is the exact drift this pin exists to stop. It
 * dead-strips from shipped builds with the rest of screenshot mode.
 */
const DEFAULT_SCREENSHOT_BOARDS = ["Marco's Board", 'High Point Climbing Orlando'];
const screenshotBoardsEnv = (process.env.EXPO_PUBLIC_SCREENSHOT_BOARDS ?? '')
  .split('|')
  .map((selector) => selector.trim())
  .filter(Boolean);
export const SCREENSHOT_BOARDS: string[] =
  screenshotBoardsEnv.length > 0 ? screenshotBoardsEnv : DEFAULT_SCREENSHOT_BOARDS;

/**
 * A `useInfiniteQuery`'s next page param, capped to ONE page in screenshot mode.
 *
 * Infinite lists page a timing-dependent distance: against a live backend the
 * app moves on before the list has prefetched much, but a replay backend
 * answers instantly, so the same flow scrolls further and asks for pages the
 * recording never reached. Screenshot run 34240391447 failed exactly there —
 * the session feed asked for page 5 (`cursor {"o":80}`) against a set that
 * stopped at page 4.
 *
 * A store screenshot never shows page two, so the cap costs nothing and makes
 * the paging depth a property of the flow instead of the machine's timing. For
 * a query this feeds, `hasNextPage` goes false with the param, so its own
 * `onEndReached` handlers stop firing too — but ONLY for those queries. A list
 * whose pager this helper does not reach (the two `@boardsesh/playlists-react`
 * hooks behind `PlaylistDetailView`, the hand-rolled `loadMore` pagers) still
 * reports more pages; those are capped at the consumer, with
 * `screenshotModeLoadMore` or an early return in the handler.
 *
 * Pass the param the query would otherwise use and the number of pages already
 * loaded (React Query hands `getNextPageParam` `allPages`, so that is
 * `allPages.length`). The inline `process.env.EXPO_PUBLIC_SCREENSHOT_MODE`
 * comparison is deliberate — see the note at the top of this module.
 */
export function screenshotModeNextPageParam<TPageParam>(
  nextParam: TPageParam,
  pagesLoaded: number,
): TPageParam | undefined {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && pagesLoaded >= 1) return undefined;
  return nextParam;
}

/**
 * A hand-rolled pager's `loadMore`, turned into a no-op in screenshot mode.
 *
 * `screenshotModeNextPageParam` only reaches a `useInfiniteQuery`. Several
 * lists page themselves instead — `useDiscoverPlaylists`, `useUserPlaylists`
 * and `useUserBetaLinks` each expose a `loadMore` a list's `onEndReached`
 * calls — and they drift for exactly the same reason: a replay backend answers
 * instantly, the list reaches its end sooner, and the capture asks for a page
 * the recording never took. All six recorded `DiscoverPlaylists` fixtures are
 * `page: 0` with `hasMore: true`, and Discover is a store shot.
 *
 * Wrap the pager at the call site, not inside the shared hook: those hooks live
 * in `@boardsesh/playlists-react`, which web consumes and which must not read a
 * mobile build flag.
 */
export function screenshotModeLoadMore(loadMore: () => void): () => void {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return NO_MORE_PAGES;
  return loadMore;
}

/**
 * One shared no-op, so a wrapped pager keeps a stable identity across renders —
 * a fresh closure per render would defeat the `React.memo` on every list that
 * takes `loadMore` as a prop.
 */
const NO_MORE_PAGES = (): void => {};

/**
 * The seed screenshot mode draws its "random" numbers from.
 *
 * Arbitrary — the only property that matters is that it NEVER CHANGES. A
 * recording and every later replay both run on this value, so they walk the
 * same sequence and pick the same climbs; move it and the committed fixture set
 * stops matching what the app asks for.
 */
export const SCREENSHOT_RANDOM_SEED = 0x600d5eed;

/**
 * The randomness source for anything whose output reaches the pixels.
 *
 * The workout generator shuffles its candidate pool per grade and re-rolls a
 * row from it, so on `Math.random` the preview shows different climbs every
 * run — the shot is not byte-stable, and (worse) the app asks the replay
 * backend for stats on climbs the recording never fetched, which is how
 * Android run 34259455408 came to miss a different id set on each attempt.
 *
 * In screenshot mode this hands back a FRESH generator seeded from
 * `SCREENSHOT_RANDOM_SEED`; everywhere else it is `Math.random` itself, so a
 * shipped build keeps real randomness and the branch dead-strips with the rest
 * of screenshot mode (see the note at the top of this module).
 *
 * Fresh per call, deliberately: a shared generator would make each draw depend
 * on how many draws happened before it, and replay reorders work relative to a
 * live recording. Independent sequences are what stay equal across runs.
 */
export function screenshotModeRandom(): RandomSource {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return mulberry32(SCREENSHOT_RANDOM_SEED);
  return Math.random;
}
