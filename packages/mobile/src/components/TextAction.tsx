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

type HitArea = {
  paddingVertical: number;
  marginVertical: number;
  paddingHorizontal: number;
  marginHorizontal: number;
};

type ActionLook = {
  textVariant: TextVariant;
  emphasized: boolean;
  hitArea: HitArea;
};

/** The smallest tap target each design language asks for: 44pt (HIG), 48dp (M3). */
export const TEXT_ACTION_MIN_TARGET = { liquidGlass: 44, material: 48 } as const satisfies Record<UiVariant, number>;

/** How far the target reaches past the label on each side, left and right. */
const HORIZONTAL_REACH = 8;

/**
 * The target around a one-line label, big enough for the variant's minimum
 * (44pt, 48dp) and taking no room in the row it sits in: padding grows the
 * pressable's own box, and the same negative margin hands that room back, so
 * the label stays where it was.
 *
 * Real layout rather than `hitSlop`: on Fabric a view hit-tests its children
 * only inside its own bounds, unless a child's layout overflows them. A shelf
 * header's row is one line tall, so slop past it was dead; an overflowing box
 * is not.
 */
function hitAreaFor(variant: UiVariant, textVariant: TextVariant): HitArea {
  const vertical = Math.ceil(
    (TEXT_ACTION_MIN_TARGET[variant] - textStylesByVariant[variant][textVariant].lineHeight) / 2,
  );
  return {
    paddingVertical: vertical,
    marginVertical: -vertical,
    paddingHorizontal: HORIZONTAL_REACH,
    marginHorizontal: -HORIZONTAL_REACH,
  };
}

/**
 * The type of a borderless text button beside other text. Liquid Glass sets it in
 * subheadline at the emphasized weight (SectionHeader's "See all" is the same
 * semibold accent, a step smaller to sit under its footnote heading); Material
 * uses labelLarge (14/500), the M3 text-button type, unemphasized.
 */
const ACTION_LOOK: Record<UiVariant, ActionLook> = {
  liquidGlass: { textVariant: 'subheadline', emphasized: true, hitArea: hitAreaFor('liquidGlass', 'subheadline') },
  material: { textVariant: 'label', emphasized: false, hitArea: hitAreaFor('material', 'label') },
};

/**
 * A borderless text button in the accent colour: a shelf's "See all", the Retry
 * after a quiet empty state. Violet here is right, because it can be tapped.
 * It takes no layout space beyond its label; the 44pt (48dp on Material) target
 * is its own padded box, handed back by a negative margin (`hitAreaFor`).
 */
export function TextAction({ label, onPress, accessibilityLabel, chevron = false, testID }: TextActionProps) {
  const { systemColors, variant } = useTheme();
  const look = selectByVariant(variant, ACTION_LOOK);
  return (
    <PressableSurface
      onPress={onPress}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={[styles.action, look.hitArea]}
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
