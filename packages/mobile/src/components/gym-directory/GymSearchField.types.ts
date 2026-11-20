import type { PlaceSuggestion } from '@boardsesh/shared-schema';

export type GymSearchFieldProps = {
  text: string;
  hasSelectedPlace: boolean;
  isGeocoding: boolean;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  onSelectPlace: (place: PlaceSuggestion) => void;
  onClear: () => void;
};
