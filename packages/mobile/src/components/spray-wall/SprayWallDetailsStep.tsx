// "Name your wall": the add-a-wall flow's last counted step, as a settings form.
//
// The same grouped rows as the Settings pages (#6477): the name, who can see
// it, the angle and the gym, each prefilled from what the server holds, so a
// climber who changes nothing taps Save once. The header's Save is the wizard's
// (`saveDetails`); this screen only edits the builder it is handed.
//
// The form is a native one (`MoreForm`), which hosts no text field, so the name
// opens a small sheet to type in, and the gym opens the gym picker. Both sheets
// sit beside the form, not inside it.

import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { MoreForm } from '../MoreForm';
import { GymPickerSheet } from '../board-discovery/GymPickerSheet';
import { SPRAY_ANGLE_OPTIONS, type SprayWallBuilder } from '../board-discovery/use-spray-wall-builder';
import { useDraftNumber } from '../../hooks/use-committed-slider-value';
import { hapticSelection } from '../../lib/haptics';
import { sprayWallVisibility } from '../../lib/spray/spray-share';
import { SPRAY_CAP_VALUES } from '../../lib/spray/spray-cap-copy';
import { buildSprayDetailsModel, parseSprayVisibility, snapSprayAngle } from './spray-details-model';
import { SprayWallNameSheet } from './SprayWallNameSheet';
import { opacity } from '../../theme/tokens';

type SprayWallDetailsStepProps = {
  builder: Pick<
    SprayWallBuilder,
    | 'name'
    | 'setName'
    | 'angle'
    | 'setAngle'
    | 'isPublic'
    | 'setIsPublic'
    | 'isUnlisted'
    | 'setIsUnlisted'
    | 'selectedGym'
    | 'setSelectedGym'
    | 'coords'
  >;
  /** The name the wall was created with ("Marco's Spray wall"), shown when the name is blank. */
  defaultName: string;
  /**
   * A Save is in flight. Nothing here may change under it: the diff it sent is
   * what the baseline moves to when it lands.
   */
  saving: boolean;
  /** The last Save's failure, or null. */
  error: string | null;
};

export function SprayWallDetailsStep({ builder, defaultName, saving, error }: SprayWallDetailsStepProps) {
  const { t } = useTranslation('boards');
  const [renameOpen, setRenameOpen] = useState(false);
  const [gymPickerOpen, setGymPickerOpen] = useState(false);

  // A drag moves the thumb only; release writes the builder.
  const { draftValue: draftAngle, setDraftValue: setDraftAngle } = useDraftNumber(builder.angle);

  const { setName, setAngle, setIsPublic, setIsUnlisted, setSelectedGym } = builder;
  const visibility = sprayWallVisibility(builder);

  const openRename = useCallback(() => {
    hapticSelection();
    setRenameOpen(true);
  }, []);
  const closeRename = useCallback(() => setRenameOpen(false), []);
  const finishRename = useCallback(
    (next: string) => {
      setName(next);
      setRenameOpen(false);
    },
    [setName],
  );

  const openGymPicker = useCallback(() => {
    hapticSelection();
    setGymPickerOpen(true);
  }, []);
  const closeGymPicker = useCallback(() => setGymPickerOpen(false), []);

  // Every callback the form hands a native control is stable: the model is
  // rebuilt on every drag frame, and a fresh closure each time would re-bind
  // the control's handlers per frame.
  const selectVisibility = useCallback(
    (key: string) => {
      const next = parseSprayVisibility(key);
      if (!next || next === visibility) return;
      hapticSelection();
      setIsPublic(next === 'public');
      setIsUnlisted(next === 'unlisted');
    },
    [visibility, setIsPublic, setIsUnlisted],
  );

  const changeAngle = useCallback(
    (value: number) => setDraftAngle(snapSprayAngle(value, SPRAY_ANGLE_OPTIONS)),
    [setDraftAngle],
  );
  const commitAngle = useCallback(
    (value: number) => {
      const angle = snapSprayAngle(value, SPRAY_ANGLE_OPTIONS);
      setDraftAngle(angle);
      setAngle(angle);
    },
    [setDraftAngle, setAngle],
  );
  const formatAngle = useCallback((angle: number) => t('sprayWizard.details.angleValue', { angle }), [t]);

  const model = useMemo(
    () =>
      buildSprayDetailsModel({
        t,
        name: builder.name,
        defaultName,
        onRename: openRename,
        visibility,
        onVisibilitySelect: selectVisibility,
        angle: draftAngle,
        angles: SPRAY_ANGLE_OPTIONS,
        onAngleChange: changeAngle,
        onAngleCommit: commitAngle,
        formatAngle,
        gymName: builder.selectedGym?.name ?? null,
        onOpenGym: openGymPicker,
        saveError: error,
        wallCap: SPRAY_CAP_VALUES.walls,
      }),
    [
      t,
      builder.name,
      defaultName,
      openRename,
      visibility,
      selectVisibility,
      draftAngle,
      changeAngle,
      commitAngle,
      formatAngle,
      builder.selectedGym,
      openGymPicker,
      error,
    ],
  );

  return (
    <View
      style={[styles.root, saving ? styles.saving : null]}
      pointerEvents={saving ? 'none' : 'auto'}
      testID="spray-details-step"
    >
      <MoreForm model={model} />
      <SprayWallNameSheet
        visible={renameOpen}
        name={builder.name}
        placeholder={defaultName}
        onDone={finishRename}
        onClose={closeRename}
      />
      {gymPickerOpen ? (
        <GymPickerSheet
          selectedUuid={builder.selectedGym?.uuid ?? null}
          boardCoords={builder.coords}
          showsOnMap={builder.isPublic}
          onSelect={(gym) => {
            setSelectedGym(gym);
            setGymPickerOpen(false);
          }}
          onRequestManualLocation={() => {
            setSelectedGym(null);
            setGymPickerOpen(false);
          }}
          onDismiss={closeGymPicker}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  // Nothing here moves under a save in flight, and the form says so.
  saving: {
    opacity: opacity.disabled,
  },
});
