// Shared props for the platform-split FeatureFlagsForm — the native body of the
// tester-only Feature Flags screen. The implementation is split across
// FeatureFlagsForm.ios.tsx (a real SwiftUI `Form`) and FeatureFlagsForm.android.tsx
// (a Jetpack Compose `LazyColumn` of Material cards), each rendered as ONE `Host`
// that fills the screen. The split keeps each platform's @expo/ui native tree —
// which resolves native views at module load — off the other platform's bundle.
//
// The screen (FeatureFlagsScreen.tsx) keeps the route guards + data hooks and
// builds a plain view-model array, so the native tree just renders strings: every
// piece of derived copy (the "Live default… Effective…" caption) is precomputed
// here as `effectiveLabel`. No native imports.

/** One option a row's picker can render — 'Default', plus each on/off or variant choice. */
export type FeatureFlagOption = {
  key: string;
  label: string;
};

/**
 * One flag's fully-resolved view model. `options` is the exact set of segments
 * to render, in order: `['default', 'on', 'off']` for a plain boolean flag, or
 * `['default', ...variants]` for a multivariate one (see
 * FeatureFlagsForm.logic.ts) — so iOS and Android render the same segments for
 * the same row without either platform needing to know which kind a flag is.
 * `choice` is the current selection (one of `options`' keys); `effectiveLabel`
 * is the precomputed "Live default: X · Effective: Y" caption (built in the
 * screen so the native tree stays dumb).
 */
export type FeatureFlagRow = {
  key: string;
  label: string;
  description: string;
  options: readonly FeatureFlagOption[];
  choice: string;
  effectiveLabel: string;
};

export type FeatureFlagsFormProps = {
  /** One entry per catalog flag, in display order. */
  rows: FeatureFlagRow[];
  /** Fired when a row's segment changes. The screen maps it to set/clear override. */
  onSelect: (key: string, choice: string) => void;
  /** Fired by the "Reset all overrides" button. */
  onReset: () => void;
  /** Enables the reset button — false greys it out when there are no overrides. */
  canReset: boolean;
  /** The footnote explaining what overrides do (rendered as the section footer on iOS). */
  noticeText: string;
  /** The section/list title ("Feature Flags"). */
  title: string;
};
