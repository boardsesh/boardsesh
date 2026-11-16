import { StyleSheet } from 'react-native';
import { Text, type TextVariant } from './Text';
import { Icon } from './Icon';
import { PressableSurface } from './PressableSurface';
import { useTheme } from '../providers/theme-provider';
import { selectByVariant } from '../theme/variants';
import { textStylesByVariant } from '../theme/typography';
import type { UiVariant } from '../theme/resolve-ui-variant';

export type TextActionProps = {
  label: string;
  onPress: () => void;
  /** Defaults to `label`. Set it when the label alone is ambiguous ("See all" what?). */
  accessibilityLabel?: string;
  /** A trailing chevron, for an action that opens more of the same ("See all"). */
  chevron?: boolean;
  testID?: string;
};

type ActionLook = {
  textVariant: TextVariant;
  emphasized: boolean;
  hitSlop: { top: number; bottom: number; left: number; right: number };
};

/** The smallest tap target each design language asks for: 44pt (HIG), 48dp (M3). */
export const TEXT_ACTION_MIN_TARGET = { liquidGlass: 44, material: 48 } as const satisfies Record<UiVariant, number>;

/**
 * Enough slop above and below a one-line label to reach the variant's minimum
 * target, without the action adding height to the row it sits in.
 */
function hitSlopFor(variant: UiVariant, textVariant: TextVariant): ActionLook['hitSlop'] {
  const vertical = Math.ceil(
    (TEXT_ACTION_MIN_TARGET[variant] - textStylesByVariant[variant][textVariant].lineHeight) / 2,
  );
  return { top: vertical, bottom: vertical, left: 8, right: 8 };
}

/**
 * The type of a borderless text button beside other text. Liquid Glass sets it in
 * subheadline at the emphasized weight (SectionHeader's "See all" is the same
 * semibold accent, a step smaller to sit under its footnote heading); Material
 * uses labelLarge (14/500), the M3 text-button type, unemphasized.
 */
const ACTION_LOOK: Record<UiVariant, ActionLook> = {
  liquidGlass: { textVariant: 'subheadline', emphasized: true, hitSlop: hitSlopFor('liquidGlass', 'subheadline') },
  material: { textVariant: 'label', emphasized: false, hitSlop: hitSlopFor('material', 'label') },
};

/**
 * A borderless text button in the accent colour: a shelf's "See all", the Retry
 * after a quiet empty state. Violet here is right, because it can be tapped.
 * It takes no layout space beyond its label; the 44pt (48dp on Material) target
 * comes from `hitSlop`.
 */
export function TextAction({ label, onPress, accessibilityLabel, chevron = false, testID }: TextActionProps) {
  const { systemColors, variant } = useTheme();
  const look = selectByVariant(variant, ACTION_LOOK);
  return (
    <PressableSurface
      onPress={onPress}
      feedback="opacity"
      hitSlop={look.hitSlop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={styles.action}
      testID={testID}
    >
      <Text variant={look.textVariant} emphasized={look.emphasized} color={systemColors.accent} numberOfLines={1}>
        {label}
      </Text>
      {chevron ? <Icon maxFontSizeMultiplier={1} name="chevron.right" size={12} color={systemColors.accent} /> : null}
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flexShrink: 0,
  },
});
