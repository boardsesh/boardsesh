// The busy-wall question's answers (#7017): the wall button's row as two
// segments in the wall-button family (`WallControlButton`): the same height,
// pill radius and type, two equal halves with an 8pt gap.
//
//   [ (T)  Keep Test2's ]  [ 💡  Put mine up ]
//
// Put mine up is "Put on the wall" exactly (the tonal lavender fill, the bulb,
// the lavender label): it confirms the tap the climber just made. Keep is the
// neutral tonal fill with a hairline and the holder's face. Where a label
// won't fit in half the row the two stack full width, Put mine up on top.
//
// It draws a `BusyWallQuestionModel` (`resolveBusyWallQuestion`) and nothing
// else; the question itself is the header's caption, and the taps go to
// `useBusyWallQuestion`, which drops the ones that land too soon.

import { memo, useCallback, useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { LargeContentViewer } from '../LargeContentViewer';
import { BoardDriverAvatar } from '../board-presence/BoardDriverAvatar';
import { useTheme } from '../../providers/theme-provider';
import { withAlpha } from '../../theme/colors';
import { androidRipple } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import {
  BUSY_WALL_ROW_ORDER,
  BUSY_WALL_SEGMENT_EDGE,
  BUSY_WALL_SEGMENT_GAP,
  BUSY_WALL_SEGMENT_INNER_GAP,
  BUSY_WALL_SEGMENT_PADDING,
  BUSY_WALL_STACK_ORDER,
  resolveBusyWallFit,
  type BusyWallQuestionModel,
  type BusyWallSegmentId,
} from './busy-wall-question';
import { useBusyWallQuestionText } from './busy-wall-question-text';
import { WALL_CONTROL_TONAL_ALPHA } from './wall-control';
import { WALL_CONTROL_HEIGHT } from './WallControlButton';

const ICON_SIZE = 20;
/** The wall button's own shrink before a label truncates. */
const MIN_FONT_SCALE = 0.8;
/** Frees the hidden measurers from the row's width, so they report one unclamped line. */
const MEASURE_MAX_WIDTH = 100000;

type BusyWallQuestionGroupProps = {
  model: BusyWallQuestionModel;
  onKeep: () => void;
  onPut: () => void;
};

type LabelWidths = { put: number | null; keep: number | null; keepShort: number | null };

function BusyWallQuestionGroupComponent({ model, onKeep, onPut }: BusyWallQuestionGroupProps) {
  const { brandColors, systemColors } = useTheme();
  const text = useBusyWallQuestionText(model);
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const [labelWidths, setLabelWidths] = useState<LabelWidths>({ put: null, keep: null, keepShort: null });

  const handleRowLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.floor(event.nativeEvent.layout.width);
    setRowWidth((previous) => (previous === width ? previous : width));
  }, []);
  const measure = useCallback(
    (label: keyof LabelWidths) => (event: LayoutChangeEvent) => {
      const width = Math.ceil(event.nativeEvent.layout.width);
      setLabelWidths((previous) => (previous[label] === width ? previous : { ...previous, [label]: width }));
    },
    [],
  );

  const fit = resolveBusyWallFit({
    rowWidth,
    putLabelWidth: labelWidths.put,
    keepLabelWidth: labelWidths.keep,
    keepShortLabelWidth: labelWidths.keepShort,
  });
  const keepLabel = fit.keepLabel === 'full' ? text.keepLabel : text.keepShortLabel;
  const order = fit.stacked ? BUSY_WALL_STACK_ORDER : BUSY_WALL_ROW_ORDER;

  // Put mine up takes Put on the wall's look; Keep the neutral tonal one.
  const looks = (segment: BusyWallSegmentId) =>
    segment === 'put'
      ? {
          background: withAlpha(brandColors.primaryFill, WALL_CONTROL_TONAL_ALPHA),
          foreground: brandColors.primary,
          border: null,
        }
      : { background: systemColors.tertiaryFill, foreground: systemColors.label, border: systemColors.separator };

  const segment = (segmentId: BusyWallSegmentId): ReactNode => {
    const look = looks(segmentId);
    const isPut = segmentId === 'put';
    const label = isPut ? text.putLabel : keepLabel;
    const onPress = isPut ? onPut : onKeep;
    const face = isPut ? null : model.holderFace;
    return (
      <PressableSurface
        key={segmentId}
        testID={isPut ? 'busy-wall-put' : 'busy-wall-keep'}
        onPress={onPress}
        accessibilityRole="button"
        // The short "Keep theirs" is a fit, not a different answer: the name is always spoken.
        accessibilityLabel={isPut ? text.putLabel : text.keepLabel}
        accessibilityState={{ disabled: !model.ready }}
        // The label colour is a platform colour on iOS, where no ripple draws anyway.
        android_ripple={androidRipple(typeof look.foreground === 'string' ? look.foreground : brandColors.primary)}
        style={({ pressed }) => [
          styles.segment,
          fit.stacked ? styles.segmentStacked : styles.segmentSideBySide,
          { backgroundColor: look.background },
          look.border !== null && [styles.hairline, { borderColor: look.border }],
          pressed && styles.pressed,
        ]}
      >
        <View style={styles.edge} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {isPut ? (
            <Icon
              name={model.putBulbFilled ? 'lightbulb.fill' : 'lightbulb'}
              size={ICON_SIZE}
              color={model.putBulbFilled ? brandColors.live : look.foreground}
              maxFontSizeMultiplier={1}
            />
          ) : face ? (
            <BoardDriverAvatar
              size={BUSY_WALL_SEGMENT_EDGE}
              userId={null}
              uri={face.avatarUrl}
              name={face.name}
              status="none"
            />
          ) : null}
        </View>
        <LargeContentViewer title={label} onActivate={onPress} style={styles.labelViewer}>
          <Text
            variant="subheadline"
            color={look.foreground}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={MIN_FONT_SCALE}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={styles.label}
          >
            {label}
          </Text>
        </LargeContentViewer>
      </PressableSurface>
    );
  };

  return (
    <View
      testID="busy-wall-question"
      style={[styles.group, fit.stacked ? styles.groupStacked : styles.groupSideBySide]}
      onLayout={handleRowLayout}
    >
      {/* One unclamped line each, at the current text size: what decides the fit. */}
      <View
        style={styles.measure}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {(
          [
            ['put', text.putLabel],
            ['keep', text.keepLabel],
            ['keepShort', text.keepShortLabel],
          ] as const
        ).map(([label, value]) => (
          <Text
            key={label}
            variant="subheadline"
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={styles.label}
            onLayout={measure(label)}
          >
            {value}
          </Text>
        ))}
      </View>
      {order.map(segment)}
    </View>
  );
}

export const BusyWallQuestionGroup = memo(BusyWallQuestionGroupComponent);

const styles = StyleSheet.create({
  // Fills the row it replaces; the row's own padding is the 16pt gutters.
  group: {
    flex: 1,
    gap: BUSY_WALL_SEGMENT_GAP,
  },
  groupSideBySide: {
    flexDirection: 'row',
  },
  groupStacked: {
    flexDirection: 'column',
  },
  segment: {
    height: WALL_CONTROL_HEIGHT,
    borderRadius: WALL_CONTROL_HEIGHT / 2,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: BUSY_WALL_SEGMENT_PADDING,
    gap: BUSY_WALL_SEGMENT_INNER_GAP,
    overflow: 'hidden',
  },
  // Two equal halves: `flex: 1` sizes both from zero, whatever their labels.
  segmentSideBySide: {
    flex: 1,
  },
  segmentStacked: {
    alignSelf: 'stretch',
  },
  hairline: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  edge: {
    width: BUSY_WALL_SEGMENT_EDGE,
    height: BUSY_WALL_SEGMENT_EDGE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelViewer: { flex: 1, alignItems: 'center' },
  label: {
    fontWeight: '600',
    textAlign: 'center',
  },
  measure: {
    position: 'absolute',
    left: 0,
    top: 0,
    opacity: 0,
    width: MEASURE_MAX_WIDTH,
    alignItems: 'flex-start',
  },
  pressed: {
    opacity: 0.6,
    transform: [{ scale: 0.98 }],
  },
});
