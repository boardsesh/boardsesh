import { memo, useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { timing } from '../../theme/animations';
import { borderRadius, overlays, spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { hasUsedResetZoom, markResetZoomUsed } from '../../lib/reset-zoom-hint';

type ResetZoomButtonProps = {
  /** Drives the cross-fade, the label reveal, and the pointerEvents / a11y gating. */
  visible: boolean;
  onPress: () => void;
  /** Caller owns POSITION only — every other visual is fixed here. */
  style?: StyleProp<ViewStyle>;
};

/** How long the label stays out after a zoom before the button collapses. */
const LABEL_HOLD_MS = 3000;

/**
 * The "back to 1x" control shared by every zoomable board.
 *
 * It sits ON the board, bottom-right. That is deliberate and was the outcome of
 * QA on #5113: the original was a wide text pill at the TOP-right whose touch
 * rect swallowed 14 hold centres, which made the holds under it unselectable
 * exactly while you were zoomed in to paint them. At 32dp in the corner nearest
 * the thumb it is small enough not to be in the way, and moving it off the board
 * entirely cost more than it bought.
 *
 * It introduces itself once and then gets out of the way. Until the control has
 * been used on this device, each zoom extends it to show `common:board.resetZoom`
 * for three seconds; after the first press it is a bare glyph forever. An icon
 * alone is not self-evident — a viewfinder is not an established "reset zoom"
 * idiom — but a label that keeps reappearing is the footprint that caused the
 * bug it is meant to fix. Staying collapsed is also what keeps the control
 * locale-invariant: German ("Zoom zurücksetzen") is a ~120dp pill.
 *
 * The icon is on the TRAILING edge so it stays put as the pill grows and shrinks
 * against its right-anchored position.
 */
export const ResetZoomButton = memo(function ResetZoomButton({ visible, onPress, style }: ResetZoomButtonProps) {
  const { t } = useTranslation('common');
  const label = t('board.resetZoom');

  // Natural width of the extended pill, measured once from the laid-out row. The
  // width is animated explicitly rather than left to a layout animation: the
  // button is pinned to a corner, so an unmanaged reflow moves it rather than
  // just resizing it.
  const [extendedWidth, setExtendedWidth] = useState<number | null>(null);
  const handleRowLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = Math.ceil(event.nativeEvent.layout.width);
    setExtendedWidth((previous) => (previous === null || Math.abs(previous - measured) > 1 ? measured : previous));
  }, []);

  // null while the marker is still being read. The hint holds until then rather
  // than flashing out and snapping away, which would read as a glitch.
  const [hintPending, setHintPending] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    void hasUsedResetZoom().then((used) => {
      if (active) setHintPending(!used);
    });
    return () => {
      active = false;
    };
  }, []);

  const handlePress = useCallback(() => {
    if (hintPending !== false) {
      setHintPending(false);
      void markResetZoomUsed();
    }
    onPress();
  }, [hintPending, onPress]);

  const opacity = useSharedValue(visible ? 1 : 0);
  const width = useSharedValue<number>(glassSize.mini);

  useEffect(() => {
    opacity.value = withTiming(visible ? 1 : 0, { duration: timing.fast });
  }, [visible, opacity]);

  // Extends on every zoom UNTIL the control has been used once, then never
  // again — seeing the label is not the same as having learned the glyph, so
  // the marker is written on press rather than on display.
  useEffect(() => {
    if (!visible || extendedWidth === null || hintPending !== true) {
      width.value = glassSize.mini;
      return;
    }
    width.value = withTiming(extendedWidth, { duration: timing.normal });
    const collapse = setTimeout(() => {
      width.value = withTiming(glassSize.mini, { duration: timing.normal });
    }, LABEL_HOLD_MS);
    return () => clearTimeout(collapse);
  }, [visible, extendedWidth, hintPending, width]);

  const fadeStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const widthStyle = useAnimatedStyle(() => ({ width: width.value }));

  return (
    <Animated.View
      style={[styles.wrapper, style, fadeStyle]}
      pointerEvents={visible ? 'auto' : 'none'}
      // Faded out is not just invisible: a control left in the a11y tree is a
      // target VoiceOver lands on that does nothing.
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
    >
      <Pressable onPress={handlePress} accessibilityRole="button" accessibilityLabel={label} hitSlop={8}>
        <Animated.View style={[styles.pill, widthStyle]}>
          {/* Laid out at natural width and measured; the pill above clips it.
              Right-aligned so the glyph holds the trailing edge while the label
              slides out to its left. */}
          <View style={styles.row} onLayout={handleRowLayout}>
            <Text variant="footnote" numberOfLines={1} style={styles.label}>
              {label}
            </Text>
            <View style={styles.glyph}>
              <Icon name="crop.free" size={16} color={overlays.onScrim} />
            </View>
          </View>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
  },
  pill: {
    height: glassSize.mini,
    borderRadius: borderRadius.full,
    // Fixed scrim rather than a theme surface: this sits on board art, which is
    // arbitrary content in both schemes.
    backgroundColor: overlays.scrim,
    overflow: 'hidden',
    // The row is pinned to the trailing edge so shrinking the pill eats the
    // label from the left and leaves the glyph where the thumb last saw it.
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  label: {
    color: overlays.onScrim,
    paddingLeft: spacing[3],
  },
  glyph: {
    width: glassSize.mini,
    height: glassSize.mini,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
