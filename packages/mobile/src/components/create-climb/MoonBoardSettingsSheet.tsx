import { useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet, Pressable, ScrollView, type TextStyle } from 'react-native';
import { BottomSheetModal, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { MOONBOARD_ANGLES, MOONBOARD_GRADES } from '@boardsesh/board-config';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { SwitchRow } from '../SwitchRow';
import { SegmentedControl } from '../SegmentedControl';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';
import { brandColors } from '../../theme/colors';
import { Button } from '../Button';

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;

type MoonBoardAngle = (typeof MOONBOARD_ANGLES)[number];

type MoonBoardSettingsSheetProps = {
  visible: boolean;
  name: string;
  description: string;
  isDraft: boolean;
  showAllHolds: boolean;
  angle: MoonBoardAngle;
  userGrade: string | undefined;
  isBenchmark: boolean;
  onChangeName: (next: string) => void;
  onChangeDescription: (next: string) => void;
  onChangeIsDraft: (next: boolean) => void;
  onChangeShowAllHolds: (next: boolean) => void;
  onChangeAngle: (next: MoonBoardAngle) => void;
  onChangeUserGrade: (next: string | undefined) => void;
  onChangeIsBenchmark: (next: boolean) => void;
  // BLE connect.
  bleAvailable: boolean;
  bleConnected: boolean;
  bleConnecting: boolean;
  onConnectBoard: () => void;
  onDismiss: () => void;
};

/**
 * Gear-sheet for the MoonBoard create editor. Like the Aurora sheet (name,
 * description, draft + show-all-holds toggles, BLE connect) plus the
 * MoonBoard-only fields: angle (25/40), a suggested grade picker, and the
 * benchmark toggle.
 */
export function MoonBoardSettingsSheet({
  visible,
  name,
  description,
  isDraft,
  showAllHolds,
  angle,
  userGrade,
  isBenchmark,
  onChangeName,
  onChangeDescription,
  onChangeIsDraft,
  onChangeShowAllHolds,
  onChangeAngle,
  onChangeUserGrade,
  onChangeIsBenchmark,
  bleAvailable,
  bleConnected,
  bleConnecting,
  onConnectBoard,
  onDismiss,
}: MoonBoardSettingsSheetProps) {
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

  const angleOptions = useMemo(() => MOONBOARD_ANGLES.map((value) => ({ key: String(value), label: `${value}°` })), []);

  if (!visible) return null;

  return (
    <ModalSheet ref={sheetRef} snapPoints={['82%']} onDismiss={onDismiss} scrollable>
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

        <Text variant="footnote" style={styles.label}>
          {t('mobile.create.moonboard.angleLabel')}
        </Text>
        <SegmentedControl
          options={angleOptions}
          selectedKey={String(angle)}
          onSelect={(key) => onChangeAngle(Number(key) as MoonBoardAngle)}
          trackColor={systemColors.fill}
          accessibilityLabel={t('mobile.create.moonboard.angleLabel')}
        />

        <Text variant="footnote" style={styles.label}>
          {t('mobile.create.moonboard.gradeLabel')}
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.gradeRow}>
          {MOONBOARD_GRADES.map((grade) => {
            const selected = userGrade === grade.value;
            return (
              <Pressable
                key={grade.value}
                onPress={() => {
                  hapticSelection();
                  // Tapping the selected grade clears it (optional field).
                  onChangeUserGrade(selected ? undefined : grade.value);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={grade.label}
                style={[
                  styles.gradeChip,
                  { backgroundColor: systemColors.fill },
                  selected && { backgroundColor: brandColors.primary },
                ]}
              >
                <Text variant="footnote" color={selected ? '#FFFFFF' : undefined} style={styles.gradeChipLabel}>
                  {grade.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.switches}>
          <SwitchRow
            label={t('mobile.create.moonboard.benchmarkLabel')}
            description={t('mobile.create.moonboard.benchmarkDescription')}
            value={isBenchmark}
            onValueChange={onChangeIsBenchmark}
          />
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
  gradeRow: {
    gap: spacing[2],
    paddingVertical: spacing[1],
  },
  gradeChip: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.md,
  },
  gradeChipLabel: {
    fontWeight: '600',
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
