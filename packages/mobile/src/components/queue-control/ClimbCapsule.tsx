// The toolbar's center element: a floating pill showing the current climb's name
// with the grade colorized on the right — the same treatment as the climb list
// rows. Tap opens the PlayDrawer; horizontal swipe steps the queue (prev/next)
// with the neighbouring climb peeking in. The pill's background adapts to the UI
// variant (Liquid Glass / Material / fallback) via AccessoryBarSurface; the
// swipe/peek/tap behaviour is shared with the native accessory via useQueueCarousel.

import { useMemo, type ReactNode } from 'react';
import { View, StyleSheet, type ColorValue } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import type { Climb } from '@boardsesh/queue';
import { TOOLBAR_CAPSULE_HEIGHT, TOOLBAR_CAPSULE_MAX_WIDTH } from '../../theme/layout';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useDrawerHost, type BoardConfig } from '../../providers/drawer-host-provider';
import { AccessoryBarSurface, type AccessoryBarSurfaceTreatment } from './AccessoryBarSurface';
import { AccessoryClimbThumbnail } from './AccessoryClimbThumbnail';
import { useQueueCarousel } from './use-queue-carousel';

type ClimbLabelProps = {
  climb: Climb;
  labelColor: ColorValue;
  formattedGrade: string | null;
  gradeColor: string;
  showThumbnail: boolean;
  boardConfig: BoardConfig | null;
};

function ClimbLabel({ climb, labelColor, formattedGrade, gradeColor, showThumbnail, boardConfig }: ClimbLabelProps) {
  return (
    <View style={styles.labelInner}>
      {showThumbnail ? <AccessoryClimbThumbnail climb={climb} boardConfig={boardConfig} /> : null}
      <Text
        variant="subheadline"
        color={labelColor}
        numberOfLines={1}
        ellipsizeMode="tail"
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.name}
      >
        {climb.name}
      </Text>
      {formattedGrade ? (
        <Text
          variant="headline"
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={[styles.gradeText, { color: gradeColor }]}
        >
          {formattedGrade}
        </Text>
      ) : null}
    </View>
  );
}

type ClimbCapsuleProps = {
  height?: number;
  /** Span the full available width instead of the centered 260px cap (Material bar). */
  fillWidth?: boolean;
  /** Action floated inside the capsule on the right, outside the swipe target (e.g. the tick). */
  endAction?: ReactNode;
  endActionSize?: number;
  /** Surface silhouette; Material docks this row while other variants float it. */
  surfaceTreatment?: AccessoryBarSurfaceTreatment;
};

export function ClimbCapsule({
  height = TOOLBAR_CAPSULE_HEIGHT,
  fillWidth = false,
  endAction,
  endActionSize = 0,
  surfaceTreatment = 'floating',
}: ClimbCapsuleProps) {
  const { systemColors } = useTheme();
  const { boardConfig } = useDrawerHost();
  const { formatGrade } = useGradeFormat();
  const {
    onLayout,
    composedGesture,
    currentLabelStyle,
    nextPeekStyle,
    prevPeekStyle,
    currentItem,
    previousItem,
    nextItem,
    canPeek,
    handleNext,
    handlePrevious,
    swipeAccessibilityActions,
  } = useQueueCarousel();

  const currentClimb = currentItem?.climb ?? null;
  const previousClimb = previousItem?.climb ?? null;
  const nextClimb = nextItem?.climb ?? null;
  // Board art needs the active board config; matches the iOS 26 native accessory.
  const showThumbnail = boardConfig != null;

  const grades = useMemo(() => {
    const color = (climb: Climb | null) =>
      climb ? (getGradeColor(climb.difficulty) ?? DEFAULT_GRADE_COLOR) : DEFAULT_GRADE_COLOR;
    return {
      current: currentClimb ? formatGrade(currentClimb.difficulty) : null,
      previous: previousClimb ? formatGrade(previousClimb.difficulty) : null,
      next: nextClimb ? formatGrade(nextClimb.difficulty) : null,
      currentColor: color(currentClimb),
      previousColor: color(previousClimb),
      nextColor: color(nextClimb),
    };
  }, [currentClimb, previousClimb, nextClimb, formatGrade]);

  if (!currentClimb) return null;

  const capsuleRadius = surfaceTreatment === 'docked' ? 0 : height / 2;
  // Reserve room on the right so the name/grade never slide under the inline tick.
  const endActionReservedWidth = endAction ? endActionSize + 8 : 0;
  const labelRight = 16 + endActionReservedWidth;

  // The docked Material bar stays on a neutral M3 surface (a step above the tab bar
  // via elevation) and marks the grade with a vivid leading colour stripe — distinct
  // from the tab bar without painting a full grade-coloured band. The grade number
  // keeps its per-grade colour, matching the list rows.
  const showGradeAccent = surfaceTreatment === 'docked';

  return (
    <AccessoryBarSurface
      height={height}
      borderRadius={capsuleRadius}
      treatment={surfaceTreatment}
      style={[styles.capsule, fillWidth ? null : styles.capsuleCap]}
    >
      {showGradeAccent ? (
        <View
          testID="grade-accent"
          pointerEvents="none"
          style={[styles.gradeAccent, { backgroundColor: grades.currentColor }]}
        />
      ) : null}
      <GestureDetector gesture={composedGesture}>
        <View
          style={[styles.swipeArea, { height, borderRadius: capsuleRadius }]}
          onLayout={onLayout}
          accessibilityRole="button"
          accessibilityLabel={currentClimb.name}
          accessibilityActions={swipeAccessibilityActions}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'next') handleNext();
            else if (event.nativeEvent.actionName === 'previous') handlePrevious();
          }}
        >
          <Animated.View style={[styles.labelSlot, { right: labelRight }, currentLabelStyle]}>
            <ClimbLabel
              climb={currentClimb}
              labelColor={systemColors.label}
              formattedGrade={grades.current}
              gradeColor={grades.currentColor}
              showThumbnail={showThumbnail}
              boardConfig={boardConfig}
            />
          </Animated.View>
          {nextClimb && canPeek ? (
            <Animated.View style={[styles.peekSlot, { right: labelRight }, nextPeekStyle]} pointerEvents="none">
              <ClimbLabel
                climb={nextClimb}
                labelColor={systemColors.label}
                formattedGrade={grades.next}
                gradeColor={grades.nextColor}
                showThumbnail={showThumbnail}
                boardConfig={boardConfig}
              />
            </Animated.View>
          ) : null}
          {previousClimb && canPeek ? (
            <Animated.View style={[styles.peekSlot, { right: labelRight }, prevPeekStyle]} pointerEvents="none">
              <ClimbLabel
                climb={previousClimb}
                labelColor={systemColors.label}
                formattedGrade={grades.previous}
                gradeColor={grades.previousColor}
                showThumbnail={showThumbnail}
                boardConfig={boardConfig}
              />
            </Animated.View>
          ) : null}
        </View>
      </GestureDetector>
      {endAction ? <View style={[styles.endActionSlot, { width: endActionSize, height }]}>{endAction}</View> : null}
    </AccessoryBarSurface>
  );
}

const styles = StyleSheet.create({
  capsule: {
    flex: 1,
  },
  // Leading grade marker on the docked Material bar: a vivid full-height stripe in
  // the raw grade colour, sitting in the label's left padding so it never overlaps
  // text. Distinguishes the bar from the tab bar and reads grade at a glance.
  gradeAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
  },
  // Centered-pill cap; omitted on the full-width Material bar.
  capsuleCap: {
    maxWidth: TOOLBAR_CAPSULE_MAX_WIDTH,
  },
  swipeArea: {
    flex: 1,
    overflow: 'hidden',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  labelSlot: {
    position: 'absolute',
    left: 16,
    right: 16,
    justifyContent: 'center',
  },
  peekSlot: {
    position: 'absolute',
    left: 16,
    right: 16,
    justifyContent: 'center',
  },
  endActionSlot: {
    position: 'absolute',
    top: 0,
    right: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  gradeText: {
    // Colorized like the list rows; right-aligned with a reserved min width
    // (tabular digits) so the grade column stays put as you swipe between climbs.
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    minWidth: 40,
    textAlign: 'right',
  },
  name: {
    flex: 1,
    fontWeight: '600',
  },
});
