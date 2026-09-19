// Shared props for the platform-split SwitchRow. The implementation is split
// across SwitchRow.ios.tsx (native @expo/ui SwiftUI Toggle) and
// SwitchRow.android.tsx (native @expo/ui Jetpack Compose Row + Switch). The
// split keeps each platform's @expo/ui native tree — which resolves native views
// at module load — off the other platform's bundle. The public API is identical
// to the previous react-native implementation, so every consumer is unchanged.

export type SwitchRowProps = {
  /** Primary line, also the accessibility (VoiceOver / TalkBack) label. */
  label: string;
  /** Optional secondary line, rendered as native secondary text. */
  description?: string;
  /**
   * Let a long description wrap instead of truncating to one line. Only the web
   * row truncates by default; the iOS Toggle and the Compose Row already wrap.
   */
  wrapDescription?: boolean;
  /** Current on/off state. */
  value: boolean;
  /** Fired with the next state when the row is toggled (no-op when disabled). */
  onValueChange: (next: boolean) => void;
  /** Dims the control and ignores taps. */
  disabled?: boolean;
  /**
   * On-track colour for the switch when on. Defaults to the brand accent (purple)
   * so every existing call site is unchanged; the logbook passes `brandColors.accent`
   * (amber) so its switches match the amber chip row.
   */
  tint?: string;
};
