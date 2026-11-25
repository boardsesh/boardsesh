import type { PlaceSuggestion } from '@boardsesh/shared-schema';

export type GymSearchFieldProps = {
  text: string;
  hasSelectedPlace: boolean;
  isGeocoding: boolean;
  /** The field's placeholder and accessibility label. Defaults to the gym finder's. */
  placeholder?: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  /** A town picked from the suggestions under the field. */
  onSelectPlace: (place: PlaceSuggestion) => void;
  onClear: () => void;
  /** The field gained or lost focus (a screen can raise its list while typing). */
  onFocusChange?: (focused: boolean) => void;
  /**
   * Where the town suggestions go. `overlay` (the default, the gym map) floats
   * them under the field. `inline` draws none: the field hands them to
   * `onSuggestionsChange` and the screen lists them in its own rows, so nothing
   * floats over the list (the add-a-board gym step's "Places" section).
   */
  suggestionsPlacement?: 'overlay' | 'inline';
  /**
   * With `inline`: the towns to list, every time they change; empty once a
   * town is picked, the search is submitted or there is nothing to suggest.
   * They stay through a blur, so a tap on one in the list is never lost.
   */
  onSuggestionsChange?: (suggestions: readonly PlaceSuggestion[]) => void;
};
