import { useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet, type TextStyle } from 'react-native';
import { BottomSheetModal, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { SwitchRow } from '../SwitchRow';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { brandColors } from '../../theme/colors';
import { Button } from '../Button';

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;

type CreateClimbSettingsSheetProps = {
  visible: boolean;
  name: string;
  description: string;
  isDraft: boolean;
  showAllHolds: boolean;
  onChangeName: (next: string) => void;
  onChangeDescription: (next: string) => void;
  onChangeIsDraft: (next: boolean) => void;
  onChangeShowAllHolds: (next: boolean) => void;
  // BLE connect. `bleAvailable` is false when no board is active (no provider).
  bleAvailable: boolean;
  bleConnected: boolean;
  bleConnecting: boolean;
  onConnectBoard: () => void;
  onDismiss: () => void;
};

/**
 * Gear-sheet for the create-climb editor: climb name + description, the draft
 * toggle, the show-all-holds discoverability toggle, and a one-tap board (BLE)
 * connect so the user can light their wall while building.
 */
export function CreateClimbSettingsSheet({
  visible,
  name,
  description,
  isDraft,
  showAllHolds,
  onChangeName,
  onChangeDescription,
  onChangeIsDraft,
  onChangeShowAllHolds,
  bleAvailable,
  bleConnected,
  bleConnecting,
  onConnectBoard,
  onDismiss,
}: CreateClimbSettingsSheetProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const sheetRef = useRef<BottomSheetModal>(null);

  useEffect(() => {
    if (visible) {
      sheetRef.current?.present();
    } else {
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  const inputStyle = useMemo<TextStyle>(
    () => ({
      backgroundColor: systemColors.fill as string,
      color: systemColors.label as string,
      borderRadius: borderRadius.md,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[3],
      fontSize: 16,
    }),
    [systemColors],
  );

  // Keep the modal mounted and drive it purely via present()/dismiss() in the
  // effect above. Returning null on !visible would unmount the sheet before the
  // dismiss effect runs (sheetRef goes null), so the close animation never plays.
  return (
    <ModalSheet ref={sheetRef} snapPoints={['72%']} onDismiss={onDismiss} scrollable>
      <View style={styles.body}>
        <Text variant="title3" style={styles.title}>
          {t('createClimbForm.settings.title')}
        </Text>

        <Text variant="footnote" style={styles.label}>
          {t('createClimbForm.fields.name')}
        </Text>
        <BottomSheetTextInput
          value={name}
          onChangeText={onChangeName}
          placeholder={t('createClimbForm.namePlaceholder')}
          placeholderTextColor={systemColors.tertiaryLabel as string}
          maxLength={NAME_MAX}
          style={inputStyle}
          returnKeyType="done"
        />

        <Text variant="footnote" style={styles.label}>
          {t('createClimbForm.fields.description')}
        </Text>
        <BottomSheetTextInput
          value={description}
          onChangeText={onChangeDescription}
          placeholder={t('createClimbForm.descriptionPlaceholder')}
          placeholderTextColor={systemColors.tertiaryLabel as string}
          maxLength={DESCRIPTION_MAX}
          multiline
          style={[inputStyle, styles.multiline]}
        />

        <View style={styles.switches}>
          <SwitchRow
            label={t('mobile.create.settings.draftLabel')}
            description={t('mobile.create.settings.draftDescription')}
            value={isDraft}
            onValueChange={onChangeIsDraft}
          />
          <SwitchRow
            label={t('mobile.create.settings.showAllHoldsLabel')}
            description={t('mobile.create.settings.showAllHoldsDescription')}
            value={showAllHolds}
            onValueChange={onChangeShowAllHolds}
          />
        </View>

        <View style={styles.bleSection}>
          {bleConnected ? (
            <View style={styles.bleConnected}>
              <Icon name="bluetooth.connected" size={20} color={brandColors.success} />
              <Text variant="subheadline" color={systemColors.secondaryLabel}>
                {t('mobile.create.settings.bleConnected')}
              </Text>
            </View>
          ) : (
            <Button
              title={t('mobile.create.settings.connectBoard')}
              icon="bluetooth"
              variant="outlined"
              onPress={onConnectBoard}
              loading={bleConnecting}
              disabled={!bleAvailable || bleConnecting}
            />
          )}
          {!bleAvailable ? (
            <Text variant="footnote" color={systemColors.tertiaryLabel} style={styles.bleHint}>
              {t('mobile.create.settings.bleUnavailable')}
            </Text>
          ) : null}
        </View>
      </View>
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[6],
    gap: spacing[2],
  },
  title: {
    marginBottom: spacing[2],
  },
  label: {
    marginTop: spacing[2],
    opacity: 0.6,
  },
  multiline: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
  switches: {
    marginTop: spacing[3],
    marginHorizontal: -spacing[4],
  },
  bleSection: {
    marginTop: spacing[4],
    gap: spacing[2],
  },
  bleConnected: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  bleHint: {
    textAlign: 'center',
  },
});
