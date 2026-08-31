// Shared view-model for the platform-split MoreForm — the native body of the main
// "More" settings screen. The implementation is split across MoreForm.ios.tsx (a
// real SwiftUI `Form`) and MoreForm.android.tsx (a Jetpack Compose `LazyColumn` of
// Material cards), each rendered as ONE `Host` that fills the screen. The split
// keeps each platform's @expo/ui native tree — which resolves native views at
// module load — off the other platform's bundle.
//
// The route screen (app/(tabs)/profile/more.tsx) keeps every hook, route guard,
// conditional (auth / tester / dev / preview-build) and i18n `t()` call, then
// builds this plain view-model and hands it to <MoreForm />. The native tree
// renders strings + invokes the row handlers only — all derived copy and haptics
// live in the screen.
//
// Leading icons are SEMANTIC (`MoreIconName`), not a platform glyph string. Each
// platform maps the name to its own native icon: iOS → an SF Symbol
// (MoreForm.ios.tsx), Android → a Material XML vector drawable under
// assets/material-icons/ (MoreForm.android.tsx). Keeping the model platform-neutral
// lets both sides render real native icons from one source of truth.

import type { ReactNode } from 'react';

/**
 * Semantic leading-icon name for a nav row, one per place the More screen links
 * to. The platform files own the name → glyph mapping (SF Symbol on iOS, Material
 * vector drawable on Android), so this union is the single contract between the
 * screen and both renderers.
 */
export type MoreIconName =
  | 'notifications'
  | 'playlists'
  | 'gyms'
  | 'integrations'
  | 'watch'
  | 'boardLook'
  | 'storage'
  | 'translate'
  | 'replay'
  | 'changelog'
  | 'devServers'
  | 'otaChannel'
  | 'featureFlags'
  | 'branchSwitcher'
  | 'editProfile';

/** A choice in a segmented control or select menu. */
export type MoreOption = {
  key: string;
  label: string;
};

/**
 * A tappable row that navigates somewhere. Renders a trailing chevron; an
 * optional leading semantic icon (an SF Symbol on iOS, a Material vector drawable
 * on Android) and an optional trailing badge ("New" pill).
 */
export type MoreNavRow = {
  kind: 'nav';
  key: string;
  label: string;
  subtitle?: string;
  /** Semantic leading icon; each platform maps it to its own native glyph. */
  icon?: MoreIconName;
  /** Trailing badge text, e.g. the "New" pill on the changelog row. */
  badge?: string;
  onPress: () => void;
};

/** A switch row (Session Recording). */
export type MoreToggleRow = {
  kind: 'toggle';
  key: string;
  label: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
};

/** An inline segmented control (Appearance, Grade Format). */
export type MoreSegmentedRow = {
  kind: 'segmented';
  key: string;
  /** Accessibility label for the segmented group (not rendered as visible text). */
  label?: string;
  options: MoreOption[];
  selectedKey: string;
  onSelect: (key: string) => void;
};

/** A menu-style picker that shows the current value and opens a menu (Language). */
export type MoreSelectRow = {
  kind: 'select';
  key: string;
  label: string;
  options: MoreOption[];
  selectedKey: string;
  onSelect: (key: string) => void;
};

/** Read-only copy that belongs inside the form's single scrolling surface. */
export type MoreInfoRow = {
  kind: 'info';
  key: string;
  label: string;
  body: string;
  detail?: string;
  /** Allow developers to select/copy diagnostic text and its optional detail. */
  selectable?: boolean;
};

/** A standalone action button (Sign Out, Delete Account). */
export type MoreButtonRow = {
  kind: 'button';
  key: string;
  label: string;
  role?: 'destructive';
  /**
   * Visual weight. `'primary'` (default) is the full-strength affordance — a
   * filled red block on Android, a body-size destructive row on iOS. `'subtle'`
   * is a quieter, secondary destructive affordance (a text-only button on
   * Android, a footnote-size row on iOS) so two destructive actions stacked
   * together (Sign Out + Delete Account) don't read as equal heavy red blocks.
   */
  emphasis?: 'primary' | 'subtle';
  onPress: () => void;
};

/**
 * A numeric knob (the Board look glow/veil/marks sliders).
 *
 * The two callbacks are NOT interchangeable, and the split is load-bearing:
 * `onValueChange` fires on every drag frame, so it may only touch local draft
 * state; `onCommit` fires once, on release, and is the ONLY place a caller may
 * write a persisted store. A slider wired straight to an AsyncStorage-backed
 * setting would write once per touch-move. See `useCommittedSliderValue`.
 *
 * The platforms disagree on both halves and `MoreForm.slider.ts` absorbs it:
 * iOS takes a `step` increment and signals release via `onEditingChanged(false)`,
 * Android takes a `steps` COUNT and signals via `onValueChangeFinished()`, which
 * carries no value.
 */
export type MoreSliderRow = {
  kind: 'slider';
  key: string;
  label: string;
  /**
   * Renders a value as its display string, e.g. `(v) => `${v}x`` or a percent.
   * A formatter rather than a precomputed string because the same function has
   * to label the live value AND both track ends, and because the web/fallback
   * renderer's slider draws all three itself. Keep it referentially stable.
   */
  format: (value: number) => string;
  value: number;
  min: number;
  max: number;
  /** The increment, in value units. Converted to Material's step COUNT on Android. */
  step: number;
  /** Fires per drag frame. Local draft state only — never a store write. */
  onValueChange: (value: number) => void;
  /** Fires once on release. The only place a store write belongs. */
  onCommit: (value: number) => void;
};

/**
 * An arbitrary React Native subtree hosted inside the native form — the board
 * preview carousels, which are RN board renders and cannot be expressed as
 * SwiftUI or Compose. Rendered through `@expo/ui`'s `RNHostView`.
 *
 * `height` is REQUIRED, in points, and that is deliberate: `matchContents` asks
 * the native side to report a size back into Yoga, and that report has been
 * observed short of the truth inside a scrolling container (see
 * `sheet-detent-probe.ts`, which traces it to `RNHostView.swift`'s
 * `ReportSizeToYogaNodeModifier`). Both carousels are fixed-height anyway, so
 * the caller states the height rather than negotiating for it.
 */
export type MoreCustomRow = {
  kind: 'custom';
  key: string;
  content: ReactNode;
  height: number;
  /** Drop the row insets, separator and card padding — for a full-bleed carousel. */
  fullBleed?: boolean;
};

/** Discriminated union of every row kind the More screen needs. */
export type MoreRow =
  | MoreNavRow
  | MoreToggleRow
  | MoreSegmentedRow
  | MoreSelectRow
  | MoreInfoRow
  | MoreButtonRow
  | MoreSliderRow
  | MoreCustomRow;

/** One grouped section: an optional header title, optional footer note, and its rows. */
export type MoreSection = {
  key: string;
  title?: string;
  footer?: string;
  rows: MoreRow[];
};

/** The whole screen as plain data: an ordered list of sections. */
export type MoreFormModel = {
  sections: MoreSection[];
};

export type MoreFormProps = {
  model: MoreFormModel;
};
