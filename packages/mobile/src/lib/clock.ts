import { SCREENSHOT_NOW_MS } from './screenshot-mode';

/**
 * The app's single source of "now". Every relative-timestamp / day-bucketing /
 * activity-window read should call this (or `nowDate()`) instead of
 * `Date.now()` / `new Date()` directly.
 *
 * Outside screenshot mode this is exactly `Date.now()`. In screenshot mode
 * (see `screenshot-mode.ts`) it returns the frozen `EXPO_PUBLIC_SCREENSHOT_NOW`
 * instant instead, so two captures of the same seeded backend data render
 * byte-identical relative timestamps.
 *
 * The `EXPO_PUBLIC_SCREENSHOT_MODE === '1'` comparison is inlined here rather
 * than routed through a shared boolean, matching every other screenshot-mode
 * call site (see screenshot-mode.ts's header comment): babel-preset-expo
 * replaces it with a literal per module, so a minified release build folds
 * `undefined === '1'` to `false` and terser dead-strips the branch, leaving a
 * bare `return Date.now();`.
 */
export function nowMs(): number {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && SCREENSHOT_NOW_MS !== null) return SCREENSHOT_NOW_MS;
  return Date.now();
}

/** `new Date(nowMs())` — the frozen-clock analogue of `new Date()`. */
export function nowDate(): Date {
  return new Date(nowMs());
}
