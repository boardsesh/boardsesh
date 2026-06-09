import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { getGradesForBoard } from '@boardsesh/board-config';
import {
  DEFAULT_GRADE_FOCUS_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  type GeneratorOptions,
  type WorkoutType,
} from '@boardsesh/playlist-generator';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../../lib/analytics';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { spacing, borderRadius } from '../../../theme/tokens';
import { brandColors as staticBrandColors } from '../../../theme/colors';
import { iosSystemColors } from '../../../theme/ios-colors';

export type GeneratorSelection = { type: 'off' } | { type: 'on'; options: GeneratorOptions };

type GeneratorPickerCardProps = {
  boardName: BoardName | null;
  /** Board angle, forwarded to the `Workout Generator Opened` event to match web. */
  angle: number | null;
  selection: GeneratorSelection;
  onChange: (selection: GeneratorSelection) => void;
};

type ChipValue = WorkoutType | 'off';

// Static value list — the labels are looked up via inline `t('mobile.session.preGenerator…')`
// calls in `chipLabel()` so the i18n key analyser can see every key as a
// literal. Adding a new entry requires adding both a value here and a case in
// `chipLabel`.
const CHIP_VALUES: ChipValue[] = ['off', 'volume', 'pyramid', 'ladder', 'gradeFocus'];

function chipLabel(value: ChipValue, t: (key: string) => string): string {
  switch (value) {
    case 'off':
      return t('mobile.session.preGeneratorOff');
    case 'volume':
      return t('mobile.session.preGeneratorVolume');
    case 'pyramid':
      return t('mobile.session.preGeneratorPyramid');
    case 'ladder':
      return t('mobile.session.preGeneratorLadder');
    case 'gradeFocus':
      return t('mobile.session.preGeneratorGradeFocus');
  }
}

function buildDefaultOptions(type: WorkoutType, targetGrade: number): GeneratorOptions {
  switch (type) {
    case 'volume':
      return { ...DEFAULT_VOLUME_OPTIONS, targetGrade };
    case 'pyramid':
      return { ...DEFAULT_PYRAMID_OPTIONS, targetGrade };
    case 'ladder':
      return { ...DEFAULT_LADDER_OPTIONS, targetGrade };
    case 'gradeFocus':
      return { ...DEFAULT_GRADE_FOCUS_OPTIONS, targetGrade };
  }
}

function getDefaultTargetGrade(boardName: BoardName | null): number {
  if (!boardName) return 15;
  const grades = getGradesForBoard(boardName);
  if (grades.length === 0) return 15;
  return grades[Math.floor(grades.length / 2)].difficulty_id;
}

/**
 * Workout-type selector. Off keeps the queue empty (user fills it manually);
 * any other choice pre-populates the queue from the shared `@boardsesh/playlist-generator`
 * algorithm and the chosen target grade. Defaults come from the shared package
 * so web and mobile agree on the starting state for each workout type.
 */
export function GeneratorPickerCard({ boardName, angle, selection, onChange }: GeneratorPickerCardProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { formatGrade } = useGradeFormat();

  const handleSelectType = (value: ChipValue) => {
    if (value === 'off') {
      onChange({ type: 'off' });
      return;
    }
    // Enabling the generator (off → a workout type) reveals the configurator —
    // the mobile analogue of web's `Workout Generator Opened`. Match web's exact
    // payload (playlist-generator-drawer.tsx): `{ targetType, boardName, angle }`.
    // The pre-session flow always feeds the session queue, so targetType is
    // 'session'; PostHog groups by exact prop name, so the keys must line up.
    if (selection.type === 'off') {
      track(SHARED_EVENTS.WorkoutGeneratorOpened, { targetType: 'session', boardName, angle });
    }
    const currentTarget = selection.type === 'on' ? selection.options.targetGrade : getDefaultTargetGrade(boardName);
    onChange({ type: 'on', options: buildDefaultOptions(value, currentTarget) });
  };

  const handleSelectGrade = (difficultyId: number) => {
    if (selection.type !== 'on') return;
    onChange({ type: 'on', options: { ...selection.options, targetGrade: difficultyId } });
  };

  const gradeChoices = boardName ? getGradesForBoard(boardName) : [];
  const activeType = selection.type === 'on' ? selection.options.type : 'off';

  return (
    <View
      style={[styles.card, { backgroundColor: systemColors.secondaryBackground, borderColor: systemColors.separator }]}
    >
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.label}>
        {t('mobile.session.preGeneratorLabel')}
      </Text>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {CHIP_VALUES.map((value) => {
          const isActive = value === activeType;
          return (
            <Pressable
              key={value}
              onPress={() => handleSelectType(value)}
              style={[
                styles.chip,
                {
                  // Border is a FOREGROUND → scheme-aware brand; the active fill
                  // (white text on it) stays the static light brand.
                  borderColor: isActive ? brandColors.primary : systemColors.separator,
                  backgroundColor: isActive ? staticBrandColors.primary : 'transparent',
                },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
            >
              <Text variant="footnote" color={isActive ? iosSystemColors.white : systemColors.label}>
                {chipLabel(value, t)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {selection.type === 'on' && boardName != null ? (
        <View style={styles.gradeSection}>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.subLabel}>
            {t('mobile.session.preGeneratorTargetGrade')}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {gradeChoices.map((grade) => {
              const isActive = grade.difficulty_id === selection.options.targetGrade;
              const gradeLabel = formatGrade(grade.difficulty_name) ?? grade.difficulty_name;
              return (
                <Pressable
                  key={grade.difficulty_id}
                  onPress={() => handleSelectGrade(grade.difficulty_id)}
                  style={[
                    styles.gradeChip,
                    {
                      // Border is a FOREGROUND → scheme-aware; active fill stays static.
                      borderColor: isActive ? brandColors.primary : systemColors.separator,
                      backgroundColor: isActive ? staticBrandColors.primary : 'transparent',
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isActive }}
                  accessibilityLabel={gradeLabel}
                >
                  <Text variant="footnote" color={isActive ? iosSystemColors.white : systemColors.label}>
                    {gradeLabel}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing[3],
    gap: spacing[2],
  },
  label: {
    paddingHorizontal: spacing[4],
  },
  subLabel: {
    paddingHorizontal: spacing[4],
    marginTop: spacing[1],
  },
  chipRow: {
    paddingHorizontal: spacing[4],
    gap: spacing[2],
  },
  chip: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.full,
    borderWidth: 1,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gradeSection: {
    gap: spacing[2],
  },
  gradeChip: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: 16,
    borderWidth: 1,
    minWidth: 48,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
