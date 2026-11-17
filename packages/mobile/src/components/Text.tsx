import {
  Platform,
  Text as RNText,
  type TextProps as RNTextProps,
  type TextStyle,
  type ColorValue,
  StyleSheet,
} from 'react-native';
import { emphasizedWeightsByVariant, textStyles, type TextVariant } from '../theme/typography';
import { dynamicTypeRamps } from '../theme/dynamic-type';
import { useBoldText } from '../hooks/use-bold-text';
import { boldTextWeight } from '../theme/accessible-typography';
import { useOptionalTheme, type ResolvedSystemColors } from '../providers/theme-provider';

export type { TextVariant };

/**
 * The label colour a `Text` takes when it has no explicit `color`: `primary` is
 * `label`, `secondary` is `secondaryLabel`, `tertiary` is `tertiaryLabel`. Use it
 * to step text down in the hierarchy instead of dimming it with `opacity`, which
 * fades it into whatever sits behind it and loses contrast in dark mode.
 */
export type TextTone = 'primary' | 'secondary' | 'tertiary';

type TextProps = RNTextProps & {
  variant?: TextVariant;
  /** An explicit colour. Wins over `tone`. */
  color?: ColorValue;
  /** Which label colour the text takes when `color` is not set. Defaults to `primary`. */
  tone?: TextTone;
  /**
   * The style's emphasized weight (HIG Typography, "Emphasized weight"; M3
   * emphasized type on Material). See `emphasizedWeights` in theme/typography.ts.
   * A `fontWeight` in `style` still wins, and Bold Text still steps it up.
   */
  emphasized?: boolean;
  /**
   * Set for a number that changes in place (a slider readout, a counter, a
   * score column). Tabular figures give every digit the same advance, so the
   * value doesn't jitter sideways as it changes (HIG Typography; M3 does the
   * same with `tnum` in data tables).
   */
  numeric?: boolean;
};

/**
 * Static fallback scale (the Liquid Glass / Apple HIG values). Used only when no
 * ThemeProvider is mounted — e.g. the pre-provider root error boundary. Under a
 * provider, `Text` reads the variant-resolved `theme.textStyles` so the Material
 * variant gets the M3 (Roboto) scale.
 */
export const variantStyles = StyleSheet.create(textStyles);

/** Tabular figures, shared so every `numeric` Text gets the same style object. */
const tabularStyle = StyleSheet.create({ numeric: { fontVariant: ['tabular-nums'] } }).numeric;

type EmphasisStyles = Record<TextVariant, Pick<TextStyle, 'fontWeight'>>;

/** One shared weight style per variant and style, so `emphasized` allocates nothing per render. */
function emphasisStylesFor(variant: keyof typeof emphasizedWeightsByVariant): EmphasisStyles {
  const weights = emphasizedWeightsByVariant[variant];
  const styles: Partial<EmphasisStyles> = {};
  for (const textVariant of Object.keys(weights) as TextVariant[]) {
    styles[textVariant] = { fontWeight: weights[textVariant] };
  }
  return styles as EmphasisStyles;
}

const emphasisStylesByVariant = {
  liquidGlass: emphasisStylesFor('liquidGlass'),
  material: emphasisStylesFor('material'),
} as const;

const toneColorKeys = {
  primary: 'label',
  secondary: 'secondaryLabel',
  tertiary: 'tertiaryLabel',
} as const satisfies Record<TextTone, keyof ResolvedSystemColors>;

export function Text({
  variant = 'body',
  color,
  tone = 'primary',
  emphasized = false,
  numeric = false,
  style,
  ...props
}: TextProps) {
  // Default to the adaptive label colour so uncoloured text is readable in
  // dark mode (RN's default text colour is a non-adaptive black). An explicit
  // `color` prop or a `style.color` still wins. `useOptionalTheme` keeps this
  // safe in the pre-provider error boundary (falls back to the RN default).
  const theme = useOptionalTheme();
  const boldText = useBoldText();
  const resolvedColor = color ?? theme?.systemColors[toneColorKeys[tone]];
  // Pull the type scale from the theme so the resolved per-UI-variant scale
  // (HIG on Liquid Glass, M3 on Material) applies. Falls back to the static glass
  // scale when no provider is mounted.
  const typeStyle = theme?.textStyles[variant] ?? variantStyles[variant];
  const emphasisStyle = emphasized ? emphasisStylesByVariant[theme?.variant ?? 'liquidGlass'][variant] : undefined;

  // Ordinary text can pass style arrays through to RN unchanged. Resolve the
  // caller's final weight only when the accessibility override needs it, so Bold
  // Text steps up whichever weight won: the style's, the emphasized one, or the
  // caller's own.
  const boldStyle = boldText
    ? { fontWeight: boldTextWeight(StyleSheet.flatten([typeStyle, emphasisStyle, style])?.fontWeight) }
    : undefined;

  return (
    <RNText
      allowFontScaling
      maxFontSizeMultiplier={0}
      // Scale on the matching UIKit text style's curve rather than React Native's
      // single multiplier table (see `dynamicTypeRamps`). Layout that has to match
      // this text reads `textFontScale`. An explicit `dynamicTypeRamp` still wins.
      dynamicTypeRamp={Platform.OS === 'ios' ? dynamicTypeRamps[variant] : undefined}
      style={[
        typeStyle,
        emphasisStyle,
        numeric ? tabularStyle : undefined,
        resolvedColor != null ? { color: resolvedColor } : undefined,
        style,
        boldStyle,
      ]}
      {...props}
    />
  );
}
