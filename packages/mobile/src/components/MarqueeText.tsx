// A single-line label that slowly scrolls its text back and forth when it would
// otherwise truncate — the "now playing" treatment used on the queue bar so a
// long climb name can be read in full. Mirrors the web climb chrome
// (`packages/web/app/components/climb-card/marquee-text.tsx`); the pacing math is
// shared via `@boardsesh/play-view` so both platforms scroll at the same speed.
//
// Falls back to a plain tail-ellipsis Text when it isn't the active item, when
// the name fits, or when Reduce Motion is on — so the scrolling is a strict
// enhancement and the reanimated path never mounts in the static case.

import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  View,
  StyleSheet,
  type ColorValue,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { computeMarqueeDurationS } from '@boardsesh/play-view';
import { Text } from './Text';
import type { TextVariant } from '../theme/typography';
import { useReduceMotion } from '../hooks/use-reduce-motion';

// Cycle shape, mirroring the web keyframes (marquee-text.module.css): dwell at the
// start, travel to the end, dwell, travel back, short end dwell. Fractions of the
// full cycle, summing to 1.
const START_DWELL_FRACTION = 0.12;
const TRAVEL_FRACTION = 0.36;
const MID_DWELL_FRACTION = 0.12;
const END_DWELL_FRACTION = 0.04;
// Below this much overflow it's not worth the motion — just ellipsize.
const MIN_OVERFLOW_PX = 2;
// The off-screen measurer needs room to lay the name out on one unclamped line.
// An absolutely-positioned node with no width is otherwise sized to its container
// and (with numberOfLines=1) truncates to it — reporting the clip width, so
// overflow reads as ~0 and the marquee never starts. A large fixed width frees it.
const MEASURE_MAX_WIDTH = 100000;

type MarqueeTextProps = {
  /** The label content (a climb name). */
  children: ReactNode;
  /**
   * Only the active/head item scrolls; everything else stays ellipsized. The bar
   * callsites pass `true` (they only ever render the queue head); the prop exists
   * so this can be reused in list rows where only the focused row should scroll.
   */
  active: boolean;
  variant?: TextVariant;
  color?: ColorValue;
  /** Clip container style — put the flex sizing (e.g. `flex: 1`) here. */
  style?: StyleProp<ViewStyle>;
  /** Text style (e.g. `fontWeight`). */
  textStyle?: StyleProp<TextStyle>;
  maxFontSizeMultiplier?: number;
  /**
   * Lines for the non-scrolling fallback (name fits, not active, or Reduce Motion).
   * Defaults to 1 (tail-ellipsis) for the fixed-height bars. A roomy surface like
   * the play-drawer header passes 2 so a Reduce-Motion user still reads the whole
   * name (wrapped) instead of a truncation.
   */
  fallbackLines?: number;
  /**
   * Shrink the type down to this scale (0.9 = 90%) instead of scrolling when
   * that fits the whole label (#7017). A name a few points too long would
   * otherwise scroll by those few points, and at rest at the far end its first
   * glyph sits clipped under the edge ("ɹrain from the Brain"). Off when left
   * out: the label scrolls past `MIN_OVERFLOW_PX`.
   */
  shrinkToFitScale?: number;
};

export const MarqueeText = memo(function MarqueeText({
  children,
  active,
  variant = 'body',
  color,
  style,
  textStyle,
  maxFontSizeMultiplier,
  fallbackLines = 1,
  shrinkToFitScale,
}: MarqueeTextProps) {
  const reduceMotion = useReduceMotion();
  const [clipWidth, setClipWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);

  const overflow = contentWidth - clipWidth;
  // Close enough to shrink into place: the whole label shows, first glyph included.
  const shrinksToFit =
    shrinkToFitScale !== undefined && clipWidth > 0 && overflow > 0 && clipWidth / contentWidth >= shrinkToFitScale;
  const shouldScroll = active && !reduceMotion && clipWidth > 0 && overflow > MIN_OVERFLOW_PX && !shrinksToFit;

  const onClipLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width);
    setClipWidth((previous) => (previous === width ? previous : width));
  }, []);
  const onContentLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.ceil(event.nativeEvent.layout.width);
    setContentWidth((previous) => (previous === width ? previous : width));
  }, []);

  return (
    <View style={[styles.clip, style]} onLayout={onClipLayout}>
      {/* Off-layout measurer: a row sizes its child to content width (the main
          axis never stretches), so this reports the name's true single-line width
          even when the visible copy is clamped to the clip. */}
      <View
        style={styles.measure}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text
          variant={variant}
          color={color}
          numberOfLines={1}
          maxFontSizeMultiplier={maxFontSizeMultiplier}
          style={textStyle}
          onLayout={onContentLayout}
        >
          {children}
        </Text>
      </View>

      {shouldScroll ? (
        <MarqueeScroller overflow={overflow}>
          {/* Pin to the full measured width and clip (don't ellipsize): otherwise
              RN measures numberOfLines=1 against the clip width and the scrolling
              copy keeps a "…" at the edge while it slides. */}
          <Text
            variant={variant}
            color={color}
            numberOfLines={1}
            ellipsizeMode="clip"
            maxFontSizeMultiplier={maxFontSizeMultiplier}
            style={[textStyle, { width: contentWidth }]}
          >
            {children}
          </Text>
        </MarqueeScroller>
      ) : shrinksToFit ? (
        <Text
          variant={variant}
          color={color}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={shrinkToFitScale}
          maxFontSizeMultiplier={maxFontSizeMultiplier}
          style={textStyle}
        >
          {children}
        </Text>
      ) : (
        <Text
          variant={variant}
          color={color}
          numberOfLines={fallbackLines}
          ellipsizeMode="tail"
          maxFontSizeMultiplier={maxFontSizeMultiplier}
          style={textStyle}
        >
          {children}
        </Text>
      )}
    </View>
  );
});

type MarqueeScrollerProps = {
  overflow: number;
  children: ReactNode;
};

// Drives the back-and-forth translateX. Mounted only while actually scrolling, so
// the reanimated hooks never run in the static/fallback case.
function MarqueeScroller({ overflow, children }: MarqueeScrollerProps) {
  const translateX = useSharedValue(0);

  useEffect(() => {
    const totalMs = computeMarqueeDurationS(overflow) * 1000;
    const startDwellMs = totalMs * START_DWELL_FRACTION;
    const travelMs = totalMs * TRAVEL_FRACTION;
    const midDwellMs = totalMs * MID_DWELL_FRACTION;
    const endDwellMs = totalMs * END_DWELL_FRACTION;
    const easing = Easing.inOut(Easing.ease);
    translateX.value = withRepeat(
      withSequence(
        withTiming(0, { duration: startDwellMs }),
        withTiming(-overflow, { duration: travelMs, easing }),
        withTiming(-overflow, { duration: midDwellMs }),
        withTiming(0, { duration: travelMs, easing }),
        withTiming(0, { duration: endDwellMs }),
      ),
      -1,
    );
    return () => cancelAnimation(translateX);
  }, [overflow, translateX]);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));

  return <Animated.View style={[styles.scrollRow, animatedStyle]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  clip: {
    overflow: 'hidden',
    justifyContent: 'center',
  },
  measure: {
    position: 'absolute',
    left: 0,
    top: 0,
    opacity: 0,
    flexDirection: 'row',
    // Unclamp the measurer so the single-line text reports its true width (see
    // MEASURE_MAX_WIDTH). It's opacity-0 and clipped, so the width is inert.
    width: MEASURE_MAX_WIDTH,
  },
  scrollRow: {
    flexDirection: 'row',
    // Shrink-wrap to the text's full width (like the measurer) instead of being
    // stretched to the clip — so the name reliably overflows and scrolls, rather
    // than depending on the child overflowing a stretched parent.
    alignSelf: 'flex-start',
  },
});
