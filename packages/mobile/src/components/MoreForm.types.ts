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
// `sfSymbol` is a plain string here (the `sf-symbols-typescript` SFSymbol union
// isn't resolvable from this shared module); the iOS tree narrows it to the
// Image `systemName` type at the call site.

/** A choice in a segmented control or select menu. */
export type MoreOption = {
  key: string;
  label: string;
};

/**
 * A tappable row that navigates somewhere. Renders a trailing chevron; an
 * optional leading SF Symbol (iOS) and an optional trailing badge ("New" pill).
 */
export type MoreNavRow = {
  kind: 'nav';
  key: string;
  label: string;
  subtitle?: string;
  /** Leading SF Symbol name on iOS (e.g. `person.crop.circle` for Edit Profile). */
  sfSymbol?: string;
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

/** A standalone action button (Sign Out, Delete Account). */
export type MoreButtonRow = {
  kind: 'button';
  key: string;
  label: string;
  role?: 'destructive';
  onPress: () => void;
};

/** Discriminated union of every row kind the More screen needs. */
export type MoreRow = MoreNavRow | MoreToggleRow | MoreSegmentedRow | MoreSelectRow | MoreButtonRow;

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
