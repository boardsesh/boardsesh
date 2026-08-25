// Shared view-model for the platform-split SwitcherForm — the native body of the
// Branch-switcher and diagnostics screens. The implementation is split across
// SwitcherForm.ios.tsx (a real SwiftUI `Form`) and SwitcherForm.android.tsx (a
// Jetpack Compose `LazyColumn` of Material cards), each rendered as ONE `Host`
// that fills the screen. The split keeps each platform's @expo/ui native tree —
// which resolves native views at module load — off the other platform's bundle.
//
// The screens own their route guards,
// data hooks, confirm/Alert/haptics, and the `channel-switch.ts` state machine,
// then build a plain `SwitcherFormModel` (sections of typed rows) and hand it to
// <SwitcherForm />. The two screens are structurally the same OTA-target switcher
// (info section → target list → custom-text field → reset), so they share ONE
// generic form rather than duplicating two near-identical native trees — the same
// sections-of-rows shape MoreForm uses. No native imports in this file.

/**
 * The render/interaction state of a single switch-target row (a preview channel,
 * a tester preset channel, or a branch). Derived once by `deriveSwitchRowState`
 * (SwitcherForm.logic.ts) so iOS and Android can't drift:
 * - `active`     — the row is the live target; shows a checkmark, not pressable.
 * - `switching`  — this row is mid-switch; shows a spinner, not pressable.
 * - `disabled`   — another row is switching; dimmed, not pressable.
 * - `pressable`  — tappable to switch (shows a chevron when `showChevronWhenPressable`).
 * - `inert`      — OTA updates unusable (dev / Expo Go); rendered for review but not tappable.
 */
export type SwitchRowState = 'active' | 'switching' | 'disabled' | 'pressable' | 'inert';

/** A read-only label/value pair (the "Current" section's build channel / runtime version). */
export type SwitcherInfoRow = {
  kind: 'info';
  key: string;
  label: string;
  value: string;
};

/** A single status line: the preview list's loading (`busy`), error, or empty state. */
export type SwitcherStatusRow = {
  kind: 'status';
  key: string;
  label: string;
  /** When true, a leading spinner accompanies the label (the loading state). */
  busy?: boolean;
};

/** A selectable switch target. `state` is precomputed; the native side just renders it. */
export type SwitcherTargetRow = {
  kind: 'target';
  key: string;
  title: string;
  /** Secondary line (the preview row's raw channel); omitted for preset/branch rows. */
  subtitle?: string;
  state: SwitchRowState;
  /** Preview rows show a chevron when pressable; preset/branch rows don't. */
  showChevronWhenPressable: boolean;
  /** Wired by the screen only when the row is pressable. */
  onPress?: () => void;
};

/** The manual channel / custom branch text field. Bridges to a native TextField. */
export type SwitcherFieldRow = {
  kind: 'field';
  key: string;
  /** Accessible name + (Android) the field's floating label. */
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (text: string) => void;
  /** Fires on the keyboard submit ("go") — the screen switches to the trimmed value. */
  onSubmit: () => void;
  editable: boolean;
};

/** A plain action button row: the manual "Switch", reset, and the tester Sentry rows. */
export type SwitcherActionRow = {
  kind: 'action';
  key: string;
  label: string;
  /** Semantic trailing icon, mapped per-platform (SF Symbol / Material glyph). */
  icon?: 'switch' | 'reset' | 'send' | 'warning' | 'flame';
  /** Colours the row red + sets the native destructive role (the reset row). */
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
};

export type SwitcherRow =
  | SwitcherInfoRow
  | SwitcherStatusRow
  | SwitcherTargetRow
  | SwitcherFieldRow
  | SwitcherActionRow;

export type SwitcherSection = {
  key: string;
  /** Section header (iOS `Section` title / Android list title). */
  title?: string;
  /** A secondary footnote rendered above the section body (the preview list intro). */
  intro?: string;
  /** A footnote rendered below the section (the "updates unavailable" notice). */
  footer?: string;
  rows: SwitcherRow[];
};

export type SwitcherFormModel = {
  sections: SwitcherSection[];
};

export type SwitcherFormProps = {
  model: SwitcherFormModel;
};
