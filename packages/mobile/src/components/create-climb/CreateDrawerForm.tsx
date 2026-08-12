import { useMemo } from 'react';
import { View, StyleSheet, type TextStyle } from 'react-native';
import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { CLIMB_CHARACTERISTICS } from '@boardsesh/shared-schema';
import { MOONBOARD_GRADES } from '@boardsesh/board-config';
import { Text } from '../Text';
import { SwitchRow } from '../SwitchRow';
import { AppMenu, type AppMenuAction } from '../AppMenu';
import { SegmentedControl } from '../SegmentedControl';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import type { MoonBoardAngle, MoonBoardMethodToken } from './moonboard-create';

const DESCRIPTION_MAX = 500;

type CreateDrawerFormProps = {
  boardName: BoardName;
  description: string;
  onChangeDescription: (next: string) => void;
  noMatch: boolean;
  onChangeNoMatch: (next: boolean) => void;
  isDraft: boolean;
  onChangeIsDraft: (next: boolean) => void;
  showAllHolds: boolean;
  onChangeShowAllHolds: (next: boolean) => void;
  moonboardAngle: MoonBoardAngle;
  onChangeMoonboardAngle: (next: MoonBoardAngle) => void;
  moonboardGrade: string | null;
  onChangeMoonboardGrade: (next: string | null) => void;
  moonboardMethod: MoonBoardMethodToken | null;
  onChangeMoonboardMethod: (next: MoonBoardMethodToken | null) => void;
  moonboardBenchmark: boolean;
  onChangeMoonboardBenchmark: (next: boolean) => void;
  canSetMoonboardBenchmark: boolean;
};

/**
 * The below-the-fold create form: the description text area and the climb-rule /
 * editor toggles (no-match, save-as-draft, show-all-holds). Board (BLE) connect
 * lives in the header lightbulb. Expects an spacing[4]-horizontally-padded
 * parent (the switches bleed to the drawer edges).
 */
export function CreateDrawerForm({
  boardName,
  description,
  onChangeDescription,
  noMatch,
  onChangeNoMatch,
  isDraft,
  onChangeIsDraft,
  showAllHolds,
  onChangeShowAllHolds,
  moonboardAngle,
  onChangeMoonboardAngle,
  moonboardGrade,
  onChangeMoonboardGrade,
  moonboardMethod,
  onChangeMoonboardMethod,
  moonboardBenchmark,
  onChangeMoonboardBenchmark,
  canSetMoonboardBenchmark,
}: CreateDrawerFormProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const isMoonBoard = boardName === 'moonboard';

  const gradeActions = useMemo<AppMenuAction[]>(
    () => [
      { label: t('createClimbForm.fields.gradeNone'), selected: moonboardGrade === null },
      ...MOONBOARD_GRADES.map((grade) => ({ label: grade.label, selected: moonboardGrade === grade.value })),
    ],
    [moonboardGrade, t],
  );
  const methodValues: Array<MoonBoardMethodToken | null> = [
    null,
    CLIMB_CHARACTERISTICS.METHOD_FOOTLESS,
    CLIMB_CHARACTERISTICS.METHOD_FOOTLESS_KICKBOARD,
    CLIMB_CHARACTERISTICS.METHOD_NO_KICKBOARD,
  ];
  const methodActions = useMemo<AppMenuAction[]>(
    () => [
      { label: t('createClimbForm.methodOptions.feetFollowHands'), selected: moonboardMethod === null },
      {
        label: t('createClimbForm.methodOptions.footless'),
        selected: moonboardMethod === CLIMB_CHARACTERISTICS.METHOD_FOOTLESS,
      },
      {
        label: t('createClimbForm.methodOptions.footlessKickboard'),
        selected: moonboardMethod === CLIMB_CHARACTERISTICS.METHOD_FOOTLESS_KICKBOARD,
      },
      {
        label: t('createClimbForm.methodOptions.noKickboard'),
        selected: moonboardMethod === CLIMB_CHARACTERISTICS.METHOD_NO_KICKBOARD,
      },
    ],
    [moonboardMethod, t],
  );
  const selectedGradeLabel =
    MOONBOARD_GRADES.find((grade) => grade.value === moonboardGrade)?.label ?? t('createClimbForm.fields.gradeNone');
  const selectedMethodLabel = methodActions.find((action) => action.selected)?.label ?? methodActions[0].label;

  const inputStyle = useMemo<TextStyle>(
    () => ({
      backgroundColor: systemColors.fill,
      color: systemColors.label,
      borderRadius: borderRadius.md,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[3],
      fontSize: 16,
    }),
    [systemColors],
  );

  return (
    <View style={styles.body}>
      <Text variant="footnote" style={styles.label}>
        {t('createClimbForm.fields.description')}
      </Text>
      <BottomSheetTextInput
        value={description}
        onChangeText={onChangeDescription}
        placeholder={t('createClimbForm.descriptionPlaceholder')}
        placeholderTextColor={systemColors.tertiaryLabel}
        maxLength={DESCRIPTION_MAX}
        multiline
        style={[inputStyle, styles.multiline]}
      />

      {isMoonBoard ? (
        <View style={styles.moonboardFields}>
          <Text variant="footnote" style={styles.label}>
            {t('createClimbForm.fields.angle')}
          </Text>
          <SegmentedControl
            options={[
              { key: '25', label: '25°' },
              { key: '40', label: '40°' },
            ]}
            selectedKey={String(moonboardAngle)}
            onSelect={(key) => onChangeMoonboardAngle(Number(key) as MoonBoardAngle)}
            accessibilityLabel={t('createClimbForm.fields.angle')}
          />

          <View style={styles.menuField}>
            <Text variant="footnote" style={styles.label}>
              {t('createClimbForm.fields.grade')}
            </Text>
            <AppMenu
              label={selectedGradeLabel}
              actions={gradeActions}
              onSelectIndex={(index) => onChangeMoonboardGrade(index === 0 ? null : MOONBOARD_GRADES[index - 1].value)}
              accessibilityLabel={t('createClimbForm.fields.grade')}
              maxWidth={220}
            />
          </View>

          <View style={styles.menuField}>
            <Text variant="footnote" style={styles.label}>
              {t('createClimbForm.fields.method')}
            </Text>
            <AppMenu
              label={selectedMethodLabel}
              actions={methodActions}
              onSelectIndex={(index) => onChangeMoonboardMethod(methodValues[index] ?? null)}
              accessibilityLabel={t('createClimbForm.fields.method')}
              maxWidth={240}
            />
          </View>
        </View>
      ) : null}

      <View style={styles.switches}>
        {!isMoonBoard ? (
          <SwitchRow
            label={t('mobile.create.settings.noMatchLabel')}
            description={t('mobile.create.settings.noMatchDescription')}
            value={noMatch}
            onValueChange={onChangeNoMatch}
          />
        ) : null}
        {isMoonBoard && canSetMoonboardBenchmark ? (
          <SwitchRow
            label={t('createClimbForm.fields.benchmark')}
            description={t('mobile.create.settings.benchmarkDescription')}
            value={moonboardBenchmark}
            onValueChange={onChangeMoonboardBenchmark}
            disabled={moonboardGrade === null}
          />
        ) : null}
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
    opacity: 0.6,
  },
  multiline: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
  switches: {
    marginTop: spacing[2],
    marginHorizontal: -spacing[4],
  },
  moonboardFields: {
    gap: spacing[2],
    marginTop: spacing[2],
  },
  menuField: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
  },
});
