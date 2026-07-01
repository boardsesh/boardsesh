import { type ColorValue, type StyleProp, type TextStyle } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { Text } from '../Text';
import { type TextVariant } from '../../theme/typography';
import { useCountUp } from '../../hooks/use-count-up';

type CountUpNumberProps = {
  value: number;
  variant?: TextVariant;
  color?: ColorValue;
  style?: StyleProp<TextStyle>;
  /** Final-value label so assistive tech never reads intermediate count-up numbers. */
  accessibilityLabel?: string;
};

/**
 * A numeral that counts up from 0 on mount. Isolated into its own component so
 * only this leaf re-renders during the tween, never the parent tile/hero. Snaps
 * to the final value under Reduce Motion (the count-up is gated on it) and always
 * carries the final value as its accessibility label.
 */
export function CountUpNumber({ value, variant = 'title1', color, style, accessibilityLabel }: CountUpNumberProps) {
  const reduceMotion = useReducedMotion();
  const display = useCountUp(value, !reduceMotion);
  return (
    <Text variant={variant} color={color} style={style} accessibilityLabel={accessibilityLabel ?? `${value}`}>
      {display}
    </Text>
  );
}
