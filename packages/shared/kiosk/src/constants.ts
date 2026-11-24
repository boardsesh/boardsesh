/**
 * Shared kiosk limits and identifiers, so the backend write validator, the web
 * renderer, and the manage-UI editor all agree on the same numbers. A client that
 * caps below the backend limit silently truncates a valid layout; one that caps
 * above it lets the owner build a kiosk the mutation then rejects with no inline
 * explanation.
 *
 * A kiosk is an OPINIONATED preset surface, not a free-form dashboard: 1–4 board
 * slots (the preset is derived from how many are configured) plus an optional
 * single leaderboard rail. The pre-merge draft of this package modelled a
 * free-form 12×8 widget grid; it was replaced with this preset config in the same
 * PR (#3627) that first lands the package, so no grid layout ever shipped.
 */

/**
 * On-disk layout schema version. Kept at 1: the widget-grid draft was replaced by
 * this preset schema before either reached `main`, so version 1 has only ever
 * meant "preset config". Bump only for a future breaking layout-shape change;
 * older clients treat any version they don't recognise as an empty layout (see
 * `parseKioskLayoutLenient`), so a bump is a hard cutover, not a soft migration.
 */
export const KIOSK_LAYOUT_VERSION = 1;

/** Explicit display appearance; unattended TVs never follow an OS preference. */
export const KIOSK_THEMES = ['dark', 'light'] as const;

export type KioskTheme = (typeof KIOSK_THEMES)[number];

/** Preserve the appearance of kiosks saved before theme selection existed. */
export const KIOSK_DEFAULT_THEME: KioskTheme = 'dark';

/** Most board slots one kiosk can hold. The strict writer schema enforces this. */
export const MAX_KIOSK_BOARDS = 4;

/** Most kiosks (TV configs) a single gym can create. Enforced backend-side. */
export const MAX_KIOSKS_PER_GYM = 10;

/**
 * How often a live kiosk TV checks in with the backend. The heartbeat rides the
 * existing config poll, so this is one cadence: config refresh AND heartbeat.
 * The manage-UI "Live" liveness window is DERIVED from this (2×, see
 * `KIOSK_LIVE_THRESHOLD_MS`) so a single dropped poll never flips a healthy TV
 * to "Last seen …". Keep the two linked through this constant rather than
 * hand-tuning twin magic numbers in two files.
 */
export const KIOSK_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Preset layout names, indexed by board count (1 board → 'single', 4 → 'quad').
 * The preset is DERIVED from `layout.boards.length` rather than stored, so there
 * is no picker and no way for the stored count and the named preset to disagree.
 */
export const KIOSK_PRESETS = ['single', 'dual', 'triple', 'quad'] as const;

export type KioskPreset = (typeof KIOSK_PRESETS)[number];

/**
 * The preset a kiosk renders for a given board count, or `null` when out of range
 * (0 boards → the TV shows a "not set up yet" placeholder; >4 is impossible under
 * the strict schema but degrades to the placeholder rather than throwing).
 */
export function kioskPresetForBoardCount(count: number): KioskPreset | null {
  if (!Number.isInteger(count) || count < 1 || count > MAX_KIOSK_BOARDS) {
    return null;
  }
  return KIOSK_PRESETS[count - 1];
}

/**
 * Leaderboard time windows a kiosk rail can rank over. 'session' is the live
 * rolling-window ranking (see `KIOSK_SESSION_WINDOW_MINUTES`); 'day' is a rolling
 * 24 hours (copy says "Last 24 hours", never "Today"); 'week'/'month' are the
 * period leaderboards. Order is the editor's toggle order.
 */
export const KIOSK_LEADERBOARD_PERIODS = ['session', 'day', 'week', 'month'] as const;

export type KioskLeaderboardPeriod = (typeof KIOSK_LEADERBOARD_PERIODS)[number];

/** Default rail period for a freshly enabled leaderboard: the live session ranking. */
export const KIOSK_DEFAULT_LEADERBOARD_PERIOD: KioskLeaderboardPeriod = 'session';

/**
 * Rolling window (minutes) the live 'session' leaderboard looks back over. Three
 * hours covers a typical gym session without letting a morning climber linger on
 * the board all evening.
 */
export const KIOSK_SESSION_WINDOW_MINUTES = 180;
