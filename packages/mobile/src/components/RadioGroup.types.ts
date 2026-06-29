// Shared props for the platform-split RadioGroup. The implementation is split
// across RadioGroup.ios.tsx (native @expo/ui SwiftUI inline Picker) and
// RadioGroup.android.tsx (native @expo/ui Jetpack Compose RadioButton group).
// The split keeps each platform's @expo/ui native tree — which resolves native
// views at module load — off the other platform's bundle. The public API is
// byte-identical to the previous hand-rolled RN RadioGroup, so every call site
// and the `index.ts` re-export are unchanged.
//
// `description` and `disabled` are honoured on Android (the Compose row can show
// a subtitle and omit `selectable`); the iOS inline Picker can express neither,
// so they're ignored there. The one call site that used them (the status filter's
// signed-out "drafts" gating) now handles that at the call site, so this is a
// graceful degrade, not a regression.

export type RadioOption<T extends string> = {
  value: T;
  label: string;
  /** Android only — rendered as a secondary line. The iOS inline Picker can't show it, so it's ignored there. */
  description?: string;
  /** Android only — dims + un-taps the row. The iOS inline Picker can't disable one option, so it's ignored there. */
  disabled?: boolean;
};

export type RadioGroupProps<T extends string> = {
  options: ReadonlyArray<RadioOption<T>>;
  value: T;
  onChange: (value: T) => void;
};
