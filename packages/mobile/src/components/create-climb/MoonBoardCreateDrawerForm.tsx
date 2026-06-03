import { useMemo } from 'react';
import { View, StyleSheet, Pressable, ScrollView, type TextStyle } from 'react-native';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { MOONBOARD_ANGLES, MOONBOARD_GRADES } from '@boardsesh/board-config';
import { Text } from '../Text';
import { SwitchRow } from '../SwitchRow';
import { SegmentedControl } from '../SegmentedControl';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';

const DESCRIPTION_MAX = 500;

type MoonBoardAngle = (typeof MOONBOARD_ANGLES)[number];

type MoonBoardCreateDrawerFormProps = {
  description: string;
  isDraft: boolean;
  showAllHolds: boolean;
  angle: MoonBoardAngle;
  userGrade: string | undefined;
  isBenchmark: boolean;
  onChangeDescription: (next: string) => void;
  onChangeIsDraft: (next: boolean) => void;
  onChangeShowAllHolds: (next: boolean) => void;
  onChangeAngle: (next: MoonBoardAngle) => void;
  onChangeUserGrade: (next: string | undefined) => void;
  onChangeIsBenchmark: (next: boolean) => void;
};

export function MoonBoardCreateDrawerForm({
  description,
  isDraft,
  showAllHolds,
  angle,
  userGrade,
  isBenchmark,
  onChangeDescription,
  onChangeIsDraft,
  onChangeShowAllHolds,
  onChangeAngle,
  onChangeUserGrade,
  onChangeIsBenchmark,
}: MoonBoardCreateDrawerFormProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();

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

  return (
    <View style={styles.body}>
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
              <Text variant="footnote" color={selected ? iosSystemColors.white : undefined} style={styles.gradeLabel}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: spacing[2],
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
  gradeLabel: {
    fontWeight: '600',
  },
  switches: {
    marginTop: spacing[3],
    marginHorizontal: -spacing[4],
  },
});
