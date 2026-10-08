import { AccessibleTextInput as TextInput } from '../AccessibleTextInput';
import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import { PressableSurface } from '../PressableSurface';
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

import { useCallback, useEffect, useMemo, type ComponentProps } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { useDeviceLocation, type LocationStatus } from '../../lib/use-device-location';
import { canOpenAppSettings, openAppSettings } from '../../lib/open-app-settings';
import { SwitchRow } from '../SwitchRow';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { SegmentedControl } from '../SegmentedControl';
import { sprayWallVisibility, type SprayWallVisibility } from '../../lib/spray/spray-share';
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
  const styles = useTypographyStyles(createStyles);
  const { systemColors } = useTheme();
  return (
    <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionLabel}>
      {children}
    </Text>
  );
}

/** Themed text input for a builder's form fields (name / location / serial). */
export function BuilderTextInput({ style, ...props }: ComponentProps<typeof TextInput>) {
  const styles = useTypographyStyles(createStyles);
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
  const styles = useTypographyStyles(createStyles);
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
        // A board name is a proper noun ("Garage", "The Cave"); autocorrect
        // rewrote it and spell-check underlined it in red (#5960).
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="done"
      />

      <SectionLabel>{t('mobile.create.gym')}</SectionLabel>
      <PressableSurface
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
      </PressableSurface>
    </>
  );
}

/**
 * Who can see a spray wall, as one three-way control with a hint for each
 * answer.
 *
 * A wall's visibility is two flags on the board row, but two switches for them
 * made "Public AND Unlisted" reachable, a state nobody means to pick, and the
 * Unlisted switch had no hint at all (#5960). Edit board and the add-a-wall
 * wizard both draw this, so the two never disagree. Writing the pair
 * exclusively keeps the round trip honest: public wins on read.
 */
export function SprayWallVisibilityField({
  builder,
}: {
  builder: Pick<BoardVisibilityBuilder, 'isPublic' | 'setIsPublic' | 'isUnlisted' | 'setIsUnlisted'>;
}) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const visibility = sprayWallVisibility(builder);
  const { setIsPublic, setIsUnlisted } = builder;
  const onSelect = useCallback(
    (next: SprayWallVisibility) => {
      setIsPublic(next === 'public');
      setIsUnlisted(next === 'unlisted');
    },
    [setIsPublic, setIsUnlisted],
  );
  const options = useMemo(
    () => [
      { key: 'private' as const, label: t('mobile.sprayVisibility.private') },
      { key: 'unlisted' as const, label: t('mobile.sprayVisibility.unlisted') },
      { key: 'public' as const, label: t('mobile.sprayVisibility.public') },
    ],
    [t],
  );

  return (
    <>
      <SectionLabel>{t('mobile.sprayVisibility.label')}</SectionLabel>
      <SegmentedControl<SprayWallVisibility>
        options={options}
        selectedKey={visibility}
        onSelect={onSelect}
        accessibilityLabel={t('mobile.sprayVisibility.label')}
      />
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.visibilityHint}>
        {visibility === 'public'
          ? t('mobile.sprayVisibility.publicHint')
          : visibility === 'unlisted'
            ? t('mobile.sprayVisibility.unlistedHint')
            : t('mobile.sprayVisibility.privateHint')}
      </Text>
    </>
  );
}

/**
 * What to say under "Use my location" after the tap. A denial or a failed fix
 * used to leave the button looking exactly as it did before (#5960).
 */
export function locationRequestFeedback(status: LocationStatus): 'denied' | 'unavailable' | null {
  if (status === 'denied' || status === 'unavailable') return status;
  return null;
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
  hideVisibilitySwitches = false,
}: {
  builder: BoardVisibilityBuilder;
  /**
   * Drop the public / unlisted switches, leaving only the location rows.
   *
   * For a caller that expresses the same three states through one control: two
   * independent booleans make "unlisted AND public" reachable, which is a state
   * nobody means to pick, and two controls for it can disagree with each other.
   * Both spray callers use this and draw `SprayWallVisibilityField` instead.
   */
  hideVisibilitySwitches?: boolean;
}) {
  const { t } = useTranslation('boards');
  const { setCoords } = builder;
  const { systemColors } = useTheme();
  // Re-asks after a denial: the row offers Open Settings, and a climber who
  // comes back having allowed location gets it from one more tap.
  const location = useDeviceLocation({ retryAfterDenial: true });
  const requestLocation = location.request;
  const locationFeedback = locationRequestFeedback(location.status);
  const onUseMyLocation = useCallback(() => void requestLocation(), [requestLocation]);
  const onClearLocation = useCallback(() => setCoords(null), [setCoords]);
  const onOpenSettings = useCallback(() => void openAppSettings(), []);

  useEffect(() => {
    if (location.coords) setCoords(location.coords);
  }, [location.coords, setCoords]);

  return (
    <>
      {hideVisibilitySwitches ? null : (
        <>
          <SwitchRow
            label={t('mobile.create.public')}
            description={t('mobile.create.publicHint')}
            value={builder.isPublic}
            onValueChange={builder.setIsPublic}
          />
          <SwitchRow
            label={t('mobile.create.unlisted')}
            value={builder.isUnlisted}
            onValueChange={builder.setIsUnlisted}
          />
        </>
      )}
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
        <Button
          title={t('mobile.create.useMyLocation')}
          variant="text"
          onPress={onUseMyLocation}
          loading={location.status === 'loading'}
        />
      )}
      {!builder.coords && locationFeedback ? (
        <>
          <Text variant="footnote" color={systemColors.secondaryLabel} accessibilityLiveRegion="polite">
            {locationFeedback === 'denied'
              ? t('mobile.create.locationDeniedHint')
              : t('mobile.create.locationUnavailableHint')}
          </Text>
          {locationFeedback === 'denied' && canOpenAppSettings() ? (
            <Button title={t('mobile.firstBoard.openSettings')} variant="text" onPress={onOpenSettings} />
          ) : null}
        </>
      ) : null}
    </>
  );
}

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
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
      fontSize: textStyles.body.fontSize,
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
    visibilityHint: {
      marginTop: spacing[2],
      lineHeight: 18,
    },
  });
