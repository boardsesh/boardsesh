import React, { useMemo, useRef } from 'react';
import { type ColorValue, type StyleProp, type TextStyle } from 'react-native';
import Animated, {
  LayoutAnimationConfig,
  ReduceMotion,
  useReducedMotion,
  withTiming,
  type EntryExitAnimationFunction,
} from 'react-native-reanimated';
import { Text, type TextVariant } from '../Text';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';

/** How far the old number leaves and the new one arrives, in points. */
const COUNT_SHIFT = 6;
const COUNT_FADE_MS = 200;
// `Never`, because Reduce Motion keeps the crossfade: it drops the shift, and a
// fade is what is left of the change.
const FADE = { duration: COUNT_FADE_MS, reduceMotion: ReduceMotion.Never } as const;

type SprayCountCrossfadeProps = {
  text: string;
  /** The number behind `text`: up moves the new line in from below, down from above. */
  value: number;
  variant: TextVariant;
  color: ColorValue;
  style?: StyleProp<TextStyle>;
};

/**
 * One line of the count capsule that crossfades when it changes: the old line
 * fades out moving 6 pt one way while the new one fades in from 6 pt the other.
 *
 * Built on keyed layout animations, so the outgoing line is kept by reanimated
 * in its last frame rather than by a second line in React's tree, and both run
 * on the UI thread. The first render shows the line without animating. With
 * Reduce Motion it is a crossfade with no shift.
 */
export const SprayCountCrossfade = React.memo(function SprayCountCrossfade({
  text,
  value,
  variant,
  color,
  style,
}: SprayCountCrossfadeProps) {
  const reduceMotion = useReducedMotion();
  const lastValueRef = useRef(value);
  const lastTextRef = useRef(text);
  const directionRef = useRef(1);
  if (lastTextRef.current !== text) {
    directionRef.current = value < lastValueRef.current ? -1 : 1;
    lastTextRef.current = text;
    lastValueRef.current = value;
  }
  const shift = reduceMotion ? 0 : COUNT_SHIFT * directionRef.current;

  const transitions = useMemo(() => {
    const entering: EntryExitAnimationFunction = () => {
      'worklet';
      return {
        initialValues: { opacity: 0, transform: [{ translateY: shift }] },
        animations: { opacity: withTiming(1, FADE), transform: [{ translateY: withTiming(0, FADE) }] },
      };
    };
    const exiting: EntryExitAnimationFunction = () => {
      'worklet';
      return {
        initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
        animations: { opacity: withTiming(0, FADE), transform: [{ translateY: withTiming(-shift, FADE) }] },
      };
    };
    return { entering, exiting };
  }, [shift]);

  return (
    <LayoutAnimationConfig skipEntering>
      <Animated.View key={text} entering={transitions.entering} exiting={transitions.exiting}>
        <Text
          variant={variant}
          color={color}
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={style}
        >
          {text}
        </Text>
      </Animated.View>
    </LayoutAnimationConfig>
  );
});
