// The toolbar's center element: a floating pill showing the current climb's name
// with the grade colorized on the right — the same treatment as the climb list
// rows. Tap opens the PlayDrawer. The pill's background adapts to the UI variant
// (Liquid Glass / Material / fallback) via AccessoryBarSurface; the tap-to-open
// behaviour is shared with the native accessory via useAccessoryClimbTap.

import { useMemo, type ReactNode } from 'react';
import { View, StyleSheet, type ColorValue } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import type { Climb } from '@boardsesh/queue';
import { TOOLBAR_CAPSULE_HEIGHT, TOOLBAR_CAPSULE_MAX_WIDTH } from '../../theme/layout';
import { spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useDrawerHost, type BoardConfig } from '../../providers/drawer-host-provider';
import { AccessoryBarSurface, type AccessoryBarSurfaceTreatment } from './AccessoryBarSurface';
import { AccessoryClimbThumbnail } from './AccessoryClimbThumbnail';
import { useAccessoryClimbTap } from './use-accessory-climb-tap';
import { useWallOrQueueCurrentClimb } from './use-wall-or-queue-climb';

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
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const { boardConfig } = useDrawerHost();
  const { formatGrade } = useGradeFormat();
  const { openGesture, dismissGesture, dismiss, canDismiss, currentItem } = useAccessoryClimbTap();
  // Swipe down to tuck the bar away; a quick tap still opens. The pan only
  // activates on a downward drag, so it never steals a tap. Exclusive gives the
  // dismiss priority so a deliberate drag never registers as an accidental open.
  const gesture = useMemo(
    () => (canDismiss ? Gesture.Exclusive(dismissGesture, openGesture) : openGesture),
    [canDismiss, dismissGesture, openGesture],
  );

  // Source-of-truth flip: show the wall's lit climb when a board feed is live
  // (flag-gated), else the local queue head.
  const currentClimb = useWallOrQueueCurrentClimb(currentItem?.climb ?? null);
  // Board art needs the active board config; matches the iOS 26 native accessory.
  const showThumbnail = boardConfig != null;

  const grades = useMemo(() => {
    const currentColor = currentClimb
      ? (getGradeColor(currentClimb.difficulty) ?? DEFAULT_GRADE_COLOR)
      : DEFAULT_GRADE_COLOR;
    return {
      current: currentClimb ? formatGrade(currentClimb.difficulty) : null,
      currentColor,
    };
  }, [currentClimb, formatGrade]);

  if (!currentClimb) return null;

  const capsuleRadius = surfaceTreatment === 'docked' ? 0 : height / 2;
  // Reserve room on the right so the name/grade never slide under the inline tick.
  const endActionReservedWidth = endAction ? endActionSize + spacing[2] : 0;
  const labelRight = spacing[4] + endActionReservedWidth;

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
      <GestureDetector gesture={gesture}>
        <View
          style={[styles.tapArea, { height, borderRadius: capsuleRadius }]}
          accessibilityRole="button"
          accessibilityLabel={currentClimb.name}
          accessibilityActions={
            canDismiss ? [{ name: 'dismiss', label: t('mobile.accessoryBar.hideControlAria') }] : undefined
          }
          onAccessibilityAction={
            canDismiss
              ? (event) => {
                  if (event.nativeEvent.actionName === 'dismiss') dismiss();
                }
              : undefined
          }
        >
          <View style={[styles.labelSlot, { right: labelRight }]}>
            <ClimbLabel
              climb={currentClimb}
              labelColor={systemColors.label}
              formattedGrade={grades.current}
              gradeColor={grades.currentColor}
              showThumbnail={showThumbnail}
              boardConfig={boardConfig}
            />
          </View>
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
    width: spacing[1],
  },
  // Centered-pill cap; omitted on the full-width Material bar.
  capsuleCap: {
    maxWidth: TOOLBAR_CAPSULE_MAX_WIDTH,
  },
  tapArea: {
    flex: 1,
    overflow: 'hidden',
    justifyContent: 'center',
    paddingHorizontal: spacing[4],
  },
  labelSlot: {
    position: 'absolute',
    left: spacing[4],
    right: spacing[4],
    justifyContent: 'center',
  },
  endActionSlot: {
    position: 'absolute',
    top: 0,
    right: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
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
