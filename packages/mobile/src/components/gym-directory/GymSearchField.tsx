import { memo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { PlaceSuggestion } from '@boardsesh/shared-schema';
import { placeSuggestionLabel } from '@boardsesh/gym-filters';
import { AccessibleTextInput } from '../AccessibleTextInput';
import { ActivityIndicator } from '../ActivityIndicator';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { usePlaceSuggestions } from '../../lib/use-place-suggestions';
import { useTheme } from '../../providers/theme-provider';
import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import { borderRadius, spacing } from '../../theme/tokens';
import type { GymSearchFieldProps } from './GymSearchField.types';

/**
 * The native gym search: a text field whose text the screen applies (a gym
 * name, or a place to geocode on submit), with up to five town suggestions from
 * our gazetteer under it as the climber types, like the browser's. A town works
 * without location permission: picking one hands it to `onSelectPlace`, which
 * moves the map there.
 */
export function GymSearchField({
  text,
  hasSelectedPlace,
  isGeocoding,
  placeholder,
  onChangeText,
  onSubmit,
  onSelectPlace,
  onClear,
}: GymSearchFieldProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const styles = useTypographyStyles(createStyles);
  const { suggestions } = usePlaceSuggestions(text, hasSelectedPlace);
  const fieldLabel = placeholder ?? t('mobile.gyms.searchPlaceholder');
  return (
    <View style={styles.column}>
      <View style={[styles.field, { backgroundColor: systemColors.background, borderColor: systemColors.separator }]}>
        <Icon name="search" size={18} color={systemColors.secondaryLabel} />
        <AccessibleTextInput
          value={text}
          onChangeText={onChangeText}
          onSubmitEditing={onSubmit}
          placeholder={fieldLabel}
          accessibilityLabel={fieldLabel}
          placeholderTextColor={systemColors.tertiaryLabel}
          style={[styles.input, { color: systemColors.label }]}
          autoCorrect={false}
          returnKeyType="search"
          testID="gym-search-input"
        />
        {isGeocoding ? <ActivityIndicator /> : null}
        {text.length > 0 || hasSelectedPlace ? (
          <PressableSurface onPress={onClear} hitSlop={8} accessibilityLabel={t('mobile.gyms.clearSearch')}>
            <Icon name="close" size={18} color={systemColors.secondaryLabel} />
          </PressableSurface>
        ) : null}
      </View>
      {suggestions.length > 0 ? (
        <View
          style={[
            styles.suggestions,
            { backgroundColor: systemColors.background, borderColor: systemColors.separator },
          ]}
          accessibilityLabel={t('mobile.gyms.placesLabel')}
          testID="gym-search-places"
        >
          {suggestions.map((place) => (
            <PlaceRow key={place.id} place={place} onSelectPlace={onSelectPlace} />
          ))}
          <Text variant="caption2" tone="secondary" style={styles.attribution}>
            {t('mobile.gyms.placesAttribution')}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** One town under the field. At most five, so a plain map, not a list. */
const PlaceRow = memo(function PlaceRow({
  place,
  onSelectPlace,
}: {
  place: PlaceSuggestion;
  onSelectPlace: (place: PlaceSuggestion) => void;
}) {
  const { systemColors } = useTheme();
  const handlePress = useCallback(() => onSelectPlace(place), [onSelectPlace, place]);
  const label = placeSuggestionLabel(place);
  return (
    <PressableSurface
      onPress={handlePress}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={label}
      style={placeRowStyles.row}
      testID={`gym-search-place-${place.id}`}
    >
      <Icon name="location" size={16} color={systemColors.secondaryLabel} />
      <Text variant="body" numberOfLines={1} style={placeRowStyles.label}>
        {label}
      </Text>
    </PressableSurface>
  );
});

const placeRowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 44,
    paddingHorizontal: spacing[3],
  },
  label: { flex: 1 },
});

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    column: { gap: spacing[1] },
    field: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[2],
      paddingHorizontal: spacing[3],
      minHeight: 44,
      borderRadius: borderRadius.lg,
      borderWidth: StyleSheet.hairlineWidth,
    },
    input: { flex: 1, fontSize: textStyles.callout.fontSize },
    suggestions: {
      borderRadius: borderRadius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: 'hidden',
    },
    attribution: {
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[1],
    },
  });
