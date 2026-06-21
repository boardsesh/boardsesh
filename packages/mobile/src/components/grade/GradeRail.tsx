import { useCallback, useEffect, useMemo, useRef, useState, type ElementRef, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { Grade } from '@boardsesh/shared-schema';
import {
  RANGE_EXTEND_WINDOW_MS,
  clearGradeBound,
  computeGradeTap,
  isAnyGrade,
  isGradeEndpoint,
  isGradeInRange,
  isRangeGrade,
  isSingleGrade,
  type GradeBound,
} from '@boardsesh/climb-filters';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { Text } from '../Text';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { useEffectiveSurfaceMode } from '../../hooks/use-effective-surface-mode';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { gradeRailCenter } from '../../lib/grade-seed';
import { hapticSelection } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';
import { GradeChip } from './GradeChip';

const CLEAR_DISMISS_MS = 300;

type ChipLayout = { x: number; width: number };

type RailFrameProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

function RailFrame({ children, style }: RailFrameProps) {
  const { systemColors } = useTheme();
  const surfaceMode = useEffectiveSurfaceMode();
  // On the material/solid paths the background must NOT carry elevation: GlassSurface
  // gives its material surface `shadows.sm` (elevation 2), and on Android elevation
  // drives z-order, so an absoluteFill background view would paint ON TOP of the
  // elevation-less grade chips and hide them. A flat coloured fill renders the chips.
  const flatFill = surfaceMode === 'material' || surfaceMode === 'solid';
  return (
    <View collapsable={false} style={[styles.frame, style]}>
      {flatFill ? (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: systemColors.secondaryBackground, borderRadius: 24 }]}
        />
      ) : (
        <GlassSurface
          glassEffectStyle="regular"
          fallbackColor={systemColors.secondaryBackground}
          borderRadius={24}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      )}
      {children}
    </View>
  );
}

function sortedGrades(grades: readonly Grade[]): Grade[] {
  return [...grades].sort((firstGrade, secondGrade) => firstGrade.difficultyId - secondGrade.difficultyId);
}

type GradeRangeRailProps = {
  grades: readonly Grade[];
  bound: GradeBound;
  sendDifficultyIds?: readonly number[];
  onChange: (next: GradeBound) => void;
  /**
   * Asked to dismiss itself (swipe the handle down, completed range, or cleared
   * selection). Only ever called when `dismissible` is true, so an inline,
   * always-open rail (e.g. inside the filter sheet) can omit it.
   */
  onRequestClose?: () => void;
  dismissible?: boolean;
  showTitle?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function GradeRangeRail({
  grades: unsortedGrades,
  bound,
  sendDifficultyIds = [],
  onChange,
  onRequestClose,
  dismissible = true,
  showTitle = false,
  style,
}: GradeRangeRailProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const scrollRef = useRef<ElementRef<typeof ScrollView>>(null);
  const chipLayoutsRef = useRef<Record<number, ChipLayout>>({});
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSingleAtRef = useRef<number | undefined>(undefined);
  // The pending dismiss runs through a ref so a parent re-render that swaps the
  // onRequestClose identity between scheduling and firing can't strand a stale
  // closure on the timer.
  const onRequestCloseRef = useRef(onRequestClose);
  const [railWidth, setRailWidth] = useState(0);
  const didCenterRef = useRef(false);

  const grades = useMemo(() => sortedGrades(unsortedGrades), [unsortedGrades]);
  const gradeIds = useMemo(() => grades.map((grade) => grade.difficultyId), [grades]);
  const centerId = useMemo(() => gradeRailCenter(bound, grades, sendDifficultyIds), [bound, grades, sendDifficultyIds]);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    onRequestCloseRef.current = onRequestClose;
  }, [onRequestClose]);

  const handleRequestClose = useCallback(() => {
    clearDismissTimer();
    onRequestCloseRef.current?.();
  }, [clearDismissTimer]);

  useEffect(() => clearDismissTimer, [clearDismissTimer]);

  const scheduleDismiss = useCallback(
    (delay: number) => {
      clearDismissTimer();
      dismissTimerRef.current = setTimeout(() => onRequestCloseRef.current?.(), delay);
    },
    [clearDismissTimer],
  );

  const handleGestureClose = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-10, 10])
        .failOffsetX([-32, 32])
        .onEnd((event) => {
          'worklet';
          if (Math.abs(event.translationY) > 24 || Math.abs(event.velocityY) > 450) {
            runOnJS(handleRequestClose)();
          }
        }),
    [handleRequestClose],
  );

  const maybeCenter = useCallback(() => {
    if (didCenterRef.current || railWidth === 0 || centerId == null) return;
    const chipLayout = chipLayoutsRef.current[centerId];
    if (!chipLayout) return;
    didCenterRef.current = true;
    const offset = Math.max(0, chipLayout.x + chipLayout.width / 2 - railWidth / 2);
    scrollRef.current?.scrollTo({ x: offset, animated: false });
  }, [centerId, railWidth]);

  const handleTapGrade = useCallback(
    (difficultyId: number) => {
      hapticSelection();
      clearDismissTimer();
      const withinWindow =
        lastSingleAtRef.current !== undefined && Date.now() - lastSingleAtRef.current < RANGE_EXTEND_WINDOW_MS;
      const result = computeGradeTap(bound, gradeIds, difficultyId, withinWindow);
      onChange(result.next);
      lastSingleAtRef.current = isSingleGrade(result.next) ? Date.now() : undefined;
      // The rail auto-closes only when a tap *completes a range* — extending a
      // single grade into a two-ended range. Every other tap keeps it open:
      // picking the first grade, switching the single grade, adjusting an
      // existing range, and crucially clearing a grade (tapping the already-
      // selected one). That clear case is how a user starts a fresh range from a
      // prior selection, so closing there would cut them off mid-build. To
      // dismiss without finishing a range, swipe the handle down.
      const completedRange = isSingleGrade(bound) && isRangeGrade(result.next);
      if (dismissible && completedRange) {
        scheduleDismiss(CLEAR_DISMISS_MS);
      }
    },
    [bound, gradeIds, onChange, clearDismissTimer, dismissible, scheduleDismiss],
  );

  const handleClear = useCallback(() => {
    hapticSelection();
    clearDismissTimer();
    lastSingleAtRef.current = undefined;
    onChange(clearGradeBound());
    if (dismissible) scheduleDismiss(CLEAR_DISMISS_MS);
  }, [clearDismissTimer, dismissible, onChange, scheduleDismiss]);

  const anySelected = isAnyGrade(bound);

  return (
    <RailFrame style={style}>
      {dismissible ? (
        <GestureDetector gesture={handleGestureClose}>
          <PressableSurface
            onPress={handleRequestClose}
            feedback="opacity"
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.gradeRail.closeAria')}
            style={styles.handleButton}
          >
            <View style={[styles.handle, { backgroundColor: systemColors.tertiaryLabel }]} />
          </PressableSurface>
        </GestureDetector>
      ) : null}
      {showTitle ? (
        <View style={styles.topRow}>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.title}>
            {t('mobile.filter.gradeRange')}
          </Text>
        </View>
      ) : null}
      <ScrollView
        ref={scrollRef}
        horizontal
        nestedScrollEnabled={Platform.OS === 'android'}
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={styles.railScroll}
        contentContainerStyle={styles.railContent}
        onScrollBeginDrag={clearDismissTimer}
        onLayout={(event) => {
          setRailWidth(event.nativeEvent.layout.width);
          maybeCenter();
        }}
      >
        <GradeChip
          label={t('mobile.search.gradeClear')}
          tone={anySelected ? 'selected' : 'neutral'}
          gradeColor={brandColors.primary}
          onPress={handleClear}
          accessibilityLabel={anySelected ? t('mobile.gradeRail.anyGradeAria') : t('mobile.gradeRail.clearFilterAria')}
          accessibilityState={{ selected: anySelected }}
        />
        {grades.map((grade) => {
          const label = formatGrade(grade.name) ?? grade.name;
          const gradeColor = getGradeColor(grade.name) ?? DEFAULT_GRADE_COLOR;
          const endpoint = isGradeEndpoint(bound, grade.difficultyId);
          const insideRange = !endpoint && isGradeInRange(bound, grade.difficultyId);
          const tone = endpoint ? 'selected' : insideRange ? 'range' : 'neutral';
          return (
            <GradeChip
              key={grade.difficultyId}
              label={label}
              tone={tone}
              gradeColor={gradeColor}
              onPress={() => handleTapGrade(grade.difficultyId)}
              accessibilityLabel={
                endpoint
                  ? t('mobile.gradeRail.selectedFilterAria', { grade: label })
                  : insideRange
                    ? t('mobile.gradeRail.rangeFilterAria', { grade: label })
                    : t('mobile.gradeRail.setFilterAria', { grade: label })
              }
              accessibilityHint={endpoint ? undefined : t('mobile.gradeRail.rangeHint')}
              accessibilityState={{ selected: endpoint }}
              onLayout={({ nativeEvent }) => {
                chipLayoutsRef.current[grade.difficultyId] = nativeEvent.layout;
                maybeCenter();
              }}
            />
          );
        })}
      </ScrollView>
    </RailFrame>
  );
}

type GradeSingleSelectRailProps = {
  grades: readonly Grade[];
  selectedDifficultyId: number | null | undefined;
  consensusDifficultyId?: number | null;
  onSelect: (difficultyId: number | undefined) => void;
  allowClear?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function GradeSingleSelectRail({
  grades: unsortedGrades,
  selectedDifficultyId,
  consensusDifficultyId,
  onSelect,
  allowClear = true,
  style,
}: GradeSingleSelectRailProps) {
  const { t } = useTranslation('climbs');
  const { formatGrade } = useGradeFormat();
  const scrollRef = useRef<ElementRef<typeof ScrollView>>(null);
  const chipLayoutsRef = useRef<Record<number, ChipLayout>>({});
  const [railWidth, setRailWidth] = useState(0);
  const didCenterRef = useRef(false);
  const grades = useMemo(() => sortedGrades(unsortedGrades), [unsortedGrades]);
  const focusId = selectedDifficultyId ?? consensusDifficultyId ?? undefined;

  const maybeCenter = useCallback(() => {
    if (didCenterRef.current || railWidth === 0 || focusId == null) return;
    const chipLayout = chipLayoutsRef.current[focusId];
    if (!chipLayout) return;
    didCenterRef.current = true;
    const offset = Math.max(0, chipLayout.x + chipLayout.width / 2 - railWidth / 2);
    scrollRef.current?.scrollTo({ x: offset, animated: false });
  }, [focusId, railWidth]);

  useEffect(() => {
    didCenterRef.current = false;
    maybeCenter();
  }, [focusId, maybeCenter]);

  const handleSelect = useCallback(
    (difficultyId: number) => {
      hapticSelection();
      onSelect(allowClear && selectedDifficultyId === difficultyId ? undefined : difficultyId);
    },
    [allowClear, selectedDifficultyId, onSelect],
  );

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.singleSelectContent, style]}
      onLayout={(event) => {
        setRailWidth(event.nativeEvent.layout.width);
        maybeCenter();
      }}
    >
      {grades.map((grade) => {
        const label = formatGrade(grade.name) ?? grade.name;
        const gradeColor = getGradeColor(grade.name) ?? DEFAULT_GRADE_COLOR;
        const selected = grade.difficultyId === selectedDifficultyId;
        const consensus = !selected && grade.difficultyId === consensusDifficultyId;
        return (
          <GradeChip
            key={grade.difficultyId}
            label={label}
            tone={selected ? 'selected' : consensus ? 'consensus' : 'neutral'}
            gradeColor={gradeColor}
            onPress={() => handleSelect(grade.difficultyId)}
            accessibilityLabel={
              selected
                ? t('mobile.gradeRail.selectedLogGradeAria', { grade: label })
                : consensus
                  ? t('mobile.gradeRail.consensusGradeAria', { grade: label })
                  : t('mobile.gradeRail.setLogGradeAria', { grade: label })
            }
            accessibilityState={{ selected }}
            onLayout={({ nativeEvent }) => {
              chipLayoutsRef.current[grade.difficultyId] = nativeEvent.layout;
              maybeCenter();
            }}
          />
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    borderRadius: 24,
    minHeight: 62,
    paddingTop: 2,
    paddingBottom: spacing[2],
  },
  handleButton: {
    minHeight: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handle: {
    width: 38,
    height: 4,
    borderRadius: 2,
  },
  topRow: {
    minHeight: 28,
    paddingHorizontal: spacing[3],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontWeight: '600',
  },
  railContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 52,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
  },
  railScroll: {
    flexGrow: 0,
    minHeight: 52,
  },
  singleSelectContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
});
