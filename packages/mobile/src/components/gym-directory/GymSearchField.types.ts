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
};
