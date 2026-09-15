// The fields every board has, whatever kind of board it is (epic #5346, SW-09).
//
// Extracted from `BoardForm.tsx` rather than copied, because a spray wall needs
// exactly the same name / gym / visibility / location block and a second copy
// would drift on the first change to any of them. What is NOT here is
// everything a wall does not have: the board → layout → size → sets cascade,
// the angle adjustability toggle, the LED switch, the serial and the timer.
//
// The two halves are separate components because `BoardForm` splits them across
// its own chrome — name and gym sit in the main form, visibility and location
// behind "More options" — and the wall wizard puts both on one step. Merging
// them into one component would force one of the two callers to fake the other's
// layout.
//
// Neither half knows which builder is driving it. The props are the SLICE of a
// builder they touch, so `useBoardBuilder` and `useSprayWallBuilder` both satisfy
// them structurally without either importing the other.

import { useCallback, useEffect, type ComponentProps } from 'react';
import { Pressable, StyleSheet, TextInput } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { useDeviceLocation } from '../../lib/use-device-location';
import { SwitchRow } from '../SwitchRow';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import type { PickedGym } from './GymPickerSheet';
import { spacing, borderRadius } from '../../theme/tokens';

/**
 * A gym as the picker hands it back and both builders hold it.
 *
 * Re-exported rather than re-declared: the builders' `setSelectedGym` has to
 * accept exactly what `GymPickerSheet.onSelect` produces, and a second
 * structurally-identical declaration is a type that drifts the first time the
 * picker learns a new field.
 */
export type BoardGymSelection = PickedGym;

/** The name + gym slice of a builder. */
export type BoardIdentityBuilder = {
  name: string;
  setName: (next: string) => void;
  selectedGym: { uuid: string; name: string } | null;
};

/** The visibility + location slice of a builder. */
export type BoardVisibilityBuilder = {
  isPublic: boolean;
  setIsPublic: (next: boolean) => void;
  isUnlisted: boolean;
  setIsUnlisted: (next: boolean) => void;
  hideLocation: boolean;
  setHideLocation: (next: boolean) => void;
  locationName: string;
  setLocationName: (next: string) => void;
  coords: { latitude: number; longitude: number } | null;
  setCoords: (next: { latitude: number; longitude: number } | null) => void;
};

/** Uppercase caption above a field group. Exported so both forms label alike. */
export function SectionLabel({ children }: { children: string }) {
  const { systemColors } = useTheme();
  return (
    <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionLabel}>
      {children}
    </Text>
  );
}

/** Themed text input for a builder's form fields (name / location / serial). */
export function BuilderTextInput({ style, ...props }: ComponentProps<typeof TextInput>) {
  const { systemColors } = useTheme();
  return (
    <TextInput
      placeholderTextColor={systemColors.tertiaryLabel}
      {...props}
      style={[
        styles.input,
        {
          color: systemColors.label,
          borderColor: systemColors.separator,
          backgroundColor: systemColors.secondaryBackground,
        },
        style,
      ]}
    />
  );
}

/**
 * Name the board and say which gym it is in.
 *
 * The gym row is deliberately in the MAIN form on both callers rather than
 * behind an "advanced" disclosure: attaching a board to its gym is what puts it
 * on the map under that gym, and burying it is how boards ended up as lone pins
 * (#4166).
 */
export function BoardIdentityFields({
  builder,
  namePlaceholder,
  onOpenGymPicker,
}: {
  builder: BoardIdentityBuilder;
  /** Shown while the name is blank — usually the auto-generated default. */
  namePlaceholder: string;
  /**
   * Open the gym picker.
   *
   * The SHEET itself is the host's, deliberately: it has to be a sibling of the
   * host's ScrollView, not a descendant of it, or it inherits the scroller's
   * clipping and its pan. This component only draws the row that asks for it.
   */
  onOpenGymPicker: () => void;
}) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();

  return (
    <>
      <SectionLabel>{t('mobile.custom.name')}</SectionLabel>
      <BuilderTextInput
        value={builder.name}
        onChangeText={builder.setName}
        placeholder={namePlaceholder}
        accessibilityLabel={t('mobile.custom.name')}
        maxLength={100}
        returnKeyType="done"
      />

      <SectionLabel>{t('mobile.create.gym')}</SectionLabel>
      <Pressable
        onPress={onOpenGymPicker}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.create.gym')}
        style={({ pressed }) => [
          styles.gymRow,
          {
            backgroundColor: pressed ? systemColors.tertiaryBackground : systemColors.secondaryBackground,
            borderColor: systemColors.separator,
          },
        ]}
      >
        <Text
          variant="body"
          color={builder.selectedGym ? systemColors.label : systemColors.secondaryLabel}
          numberOfLines={1}
          style={styles.gymRowLabel}
        >
          {builder.selectedGym?.name ?? t('mobile.create.gymNone')}
        </Text>
        <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
      </Pressable>
    </>
  );
}

/**
 * Who can see the board, and where it is.
 *
 * Owns the location-permission flow: `location.coords` stays null until the
 * climber taps "Use my location", so the effect below only ever stamps
 * coordinates somebody opted into.
 */
export function BoardVisibilityFields({
  builder,
  publicHint,
}: {
  builder: BoardVisibilityBuilder;
  /** Overrides the default "public" caption — a wall is private by default and says so. */
  publicHint?: string;
}) {
  const { t } = useTranslation('boards');
  const { setCoords } = builder;
  const location = useDeviceLocation();
  const requestLocation = location.request;
  const onUseMyLocation = useCallback(() => void requestLocation(), [requestLocation]);
  const onClearLocation = useCallback(() => setCoords(null), [setCoords]);

  useEffect(() => {
    if (location.coords) setCoords(location.coords);
  }, [location.coords, setCoords]);

  return (
    <>
      <SwitchRow
        label={t('mobile.create.public')}
        description={publicHint ?? t('mobile.create.publicHint')}
        value={builder.isPublic}
        onValueChange={builder.setIsPublic}
      />
      <SwitchRow label={t('mobile.create.unlisted')} value={builder.isUnlisted} onValueChange={builder.setIsUnlisted} />
      <SwitchRow
        label={t('mobile.create.hideLocation')}
        value={builder.hideLocation}
        onValueChange={builder.setHideLocation}
      />

      <SectionLabel>{t('mobile.create.location')}</SectionLabel>
      <BuilderTextInput
        value={builder.locationName}
        onChangeText={builder.setLocationName}
        placeholder={t('mobile.create.locationPlaceholder')}
        accessibilityLabel={t('mobile.create.location')}
        maxLength={120}
      />
      {/* Stamping coordinates used to be one-way — the button simply went
          disabled, leaving no way to undo a wrong location. */}
      {builder.coords ? (
        <Button title={t('mobile.create.clearLocation')} variant="text" onPress={onClearLocation} role="destructive" />
      ) : (
        <Button title={t('mobile.create.useMyLocation')} variant="text" onPress={onUseMyLocation} />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  sectionLabel: {
    marginTop: spacing[3],
    marginBottom: spacing[1],
    textTransform: 'uppercase',
  },
  input: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 17,
  },
  gymRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    borderRadius: borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  gymRowLabel: {
    flex: 1,
  },
});
