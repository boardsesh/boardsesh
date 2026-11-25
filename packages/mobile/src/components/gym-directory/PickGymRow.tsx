import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Gym, PlaceSuggestion } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { PressableSurface } from '../PressableSurface';
import { ArtRow } from '../ArtRow';
import { StatusPill } from '../StatusPill';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { GymListingPill } from '../gym-page/GymListingPill';
import { InsetGroupedCell } from '../gym-page/InsetGroupedCell';
import type { GroupedCellPosition } from '../gym-page/gym-page-view-model';

// The rows of the add-a-board flow's "Which gym?" step (`GymStep`, rows from
// `gym-pick-rows.ts`): gyms to choose with one tap, the towns suggested for
// the search text, and "Add my gym". The builders' gym picker (the same step in
// pick mode) adds "Not at a gym" and ticks the board's current gym. Each is a slice of an inset-grouped card
// that carries its own 16pt gutter, and reads its own colours so the list's
// `renderItem` deps stay free of theme values.

/** The art at the head of a pick row: a glyph on a quiet 36pt circle. */
const PickGlyph = memo(function PickGlyph({ icon }: { icon: IconName }) {
  const { systemColors } = useTheme();
  return (
    <View style={[styles.glyphCircle, { backgroundColor: systemColors.tertiaryFill }]}>
      <Icon name={icon} size={18} color={systemColors.secondaryLabel} />
    </View>
  );
});

const GYM_GLYPH = <PickGlyph icon="gym" />;
const ADD_GLYPH = <PickGlyph icon="plus" />;
const PLACE_GLYPH = <PickGlyph icon="location" />;
const NO_GYM_GLYPH = <PickGlyph icon="pin" />;

/**
 * A gym to choose: its name, "1.2 km · street" (left out when there is
 * neither), then how many boards it has and, when its staff run it, "Run by
 * the gym". The whole row picks.
 */
export const PickGymRow = memo(function PickGymRow({
  gym,
  subtitle,
  boardsLabel,
  position,
  selected,
  checked,
  onPickGym,
}: {
  gym: Gym;
  subtitle: string | null;
  boardsLabel: string;
  position: GroupedCellPosition;
  selected: boolean;
  /**
   * A choice of the board's gym (the builders' picker): a checkmark on the
   * current gym instead of a chevron, and its pin selection is not drawn.
   * Undefined on the wizard, where a row moves the flow on.
   */
  checked?: boolean;
  onPickGym: (gym: Gym) => void;
}) {
  const handlePress = useCallback(() => onPickGym(gym), [onPickGym, gym]);
  const details = useMemo(
    () => (
      <View style={styles.details}>
        {subtitle ? (
          <Text variant="subheadline" tone="secondary">
            {subtitle}
          </Text>
        ) : null}
        <View style={styles.pills}>
          <StatusPill label={boardsLabel} testID="gym-pick-boards" />
          {gym.listingState === 'RUN_BY_GYM' ? (
            <GymListingPill listingState={gym.listingState} testID="gym-pick-listing" />
          ) : null}
        </View>
      </View>
    ),
    [subtitle, boardsLabel, gym.listingState],
  );
  return (
    <InsetGroupedCell position={position} separatorInset="compact">
      <ArtRow
        art={GYM_GLYPH}
        artSize="compact"
        title={gym.name}
        titleVariant="body"
        subtitle={details}
        accessory={checked === undefined ? 'chevron' : 'checkmark'}
        selected={checked ?? selected}
        onPress={handlePress}
        testID={`gym-pick-${gym.uuid}`}
      />
    </InsetGroupedCell>
  );
});

/** A town suggested for the search text: a tap flies the map there and lists its gyms. */
export const PickPlaceRow = memo(function PickPlaceRow({
  place,
  label,
  position,
  onSelectPlace,
}: {
  place: PlaceSuggestion;
  label: string;
  position: GroupedCellPosition;
  onSelectPlace: (place: PlaceSuggestion) => void;
}) {
  const handlePress = useCallback(() => onSelectPlace(place), [onSelectPlace, place]);
  return (
    <InsetGroupedCell position={position} separatorInset="compact">
      <ArtRow
        art={PLACE_GLYPH}
        artSize="compact"
        title={label}
        titleVariant="body"
        onPress={handlePress}
        testID={`gym-pick-place-${place.id}`}
      />
    </InsetGroupedCell>
  );
});

/** "Try again" under a failed lookup's notice. */
export const PickRetryAction = memo(function PickRetryAction({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      feedback="opacity"
      accessibilityRole="button"
      hitSlop={8}
      style={styles.retry}
      testID="gym-pick-retry"
    >
      <Text variant="subheadline" color={systemColors.accent}>
        {label}
      </Text>
    </PressableSurface>
  );
});

/**
 * "Add my gym", its own card: the gym isn't listed, add it. On the builders'
 * picker it is "My gym isn't listed", the last slice of a card under "Not at a
 * gym".
 */
export const AddGymRow = memo(function AddGymRow({
  title,
  subtitle,
  position = 'only',
  onAddGym,
}: {
  title: string;
  subtitle?: string;
  position?: GroupedCellPosition;
  onAddGym: () => void;
}) {
  return (
    <InsetGroupedCell position={position} separatorInset="compact">
      <ArtRow
        art={ADD_GLYPH}
        artSize="compact"
        title={title}
        titleVariant="body"
        subtitle={subtitle}
        accessory="chevron"
        onPress={onAddGym}
        testID="gym-pick-add-gym"
      />
    </InsetGroupedCell>
  );
});

/** "Not at a gym" on the builders' picker: the board isn't linked to any gym. Ticked while it isn't. */
export const NoGymRow = memo(function NoGymRow({
  title,
  subtitle,
  checked,
  position,
  onPickNone,
}: {
  title: string;
  subtitle: string;
  checked: boolean;
  position: GroupedCellPosition;
  onPickNone: () => void;
}) {
  return (
    <InsetGroupedCell position={position} separatorInset="compact">
      <ArtRow
        art={NO_GYM_GLYPH}
        artSize="compact"
        title={title}
        titleVariant="body"
        subtitle={subtitle}
        accessory="checkmark"
        selected={checked}
        onPress={onPickNone}
        testID="gym-pick-no-gym"
      />
    </InsetGroupedCell>
  );
});

const styles = StyleSheet.create({
  glyphCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  details: {
    gap: spacing[1],
  },
  pills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[1],
  },
  retry: {
    alignSelf: 'center',
    marginTop: spacing[2],
    paddingVertical: spacing[1],
  },
});
