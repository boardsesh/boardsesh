import { StyleSheet, View } from 'react-native';
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
  /**
   * Which way the target's extra height goes (`TextActionReach`). Defaults to
   * `even`; a shelf header's action leans `up`, the first action under a
   * header leans `down`.
   */
  reach?: TextActionReach;
  testID?: string;
};

/**
 * Where the target's extra height goes around its one-line label: `even` above
 * and below, `up` mostly above (a shelf header's action, with its content 8pt
 * below), `down` mostly below (an action at the top of a shelf's content).
 */
export type TextActionReach = 'even' | 'up' | 'down';

/**
 * The most a target leans toward the neighbour it is stacked against: half the
 * 8pt between a shelf header and its content, so the header's action and the
 * first action under it never overlap, even when the action wraps under the
 * title at a large text size.
 */
export const TEXT_ACTION_NEIGHBOUR_REACH = 4;

type HitArea = {
  paddingTop: number;
  marginTop: number;
  paddingBottom: number;
  marginBottom: number;
  paddingHorizontal: number;
  marginHorizontal: number;
};

type ActionLook = {
  textVariant: TextVariant;
  emphasized: boolean;
  hitAreas: Record<TextActionReach, HitArea>;
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
 *
 * The padded box sits in a slot as tall as the label (`TextAction`): Yoga
 * centres an item of a wrapping row (ShelfHeader's title row) by its border
 * box, ignoring its margins, so a box leaning up would push its label down.
 */
function hitAreaFor(variant: UiVariant, textVariant: TextVariant, reach: TextActionReach): HitArea {
  const extra = Math.max(0, TEXT_ACTION_MIN_TARGET[variant] - textStylesByVariant[variant][textVariant].lineHeight);
  const half = Math.ceil(extra / 2);
  const leaning = Math.max(0, extra - TEXT_ACTION_NEIGHBOUR_REACH);
  const [top, bottom] =
    reach === 'up'
      ? [leaning, TEXT_ACTION_NEIGHBOUR_REACH]
      : reach === 'down'
        ? [TEXT_ACTION_NEIGHBOUR_REACH, leaning]
        : [half, half];
  return {
    paddingTop: top,
    marginTop: -top,
    paddingBottom: bottom,
    marginBottom: -bottom,
    paddingHorizontal: HORIZONTAL_REACH,
    marginHorizontal: -HORIZONTAL_REACH,
  };
}

function hitAreasFor(variant: UiVariant, textVariant: TextVariant): Record<TextActionReach, HitArea> {
  return {
    even: hitAreaFor(variant, textVariant, 'even'),
    up: hitAreaFor(variant, textVariant, 'up'),
    down: hitAreaFor(variant, textVariant, 'down'),
  };
}

/**
 * The type of a borderless text button beside other text. Liquid Glass sets it in
 * subheadline at the emphasized weight (SectionHeader's "See all" is the same
 * semibold accent, a step smaller to sit under its footnote heading); Material
 * uses labelLarge (14/500), the M3 text-button type, unemphasized.
 */
const ACTION_LOOK: Record<UiVariant, ActionLook> = {
  liquidGlass: { textVariant: 'subheadline', emphasized: true, hitAreas: hitAreasFor('liquidGlass', 'subheadline') },
  material: { textVariant: 'label', emphasized: false, hitAreas: hitAreasFor('material', 'label') },
};

/**
 * How far a target reaches past its label, above and below. A block whose
 * action leans toward a neighbour with a target of its own (a shelf's last
 * line, over the next shelf header's action) keeps that much room below it,
 * so the two never overlap.
 */
export function textActionOverhang(variant: UiVariant, reach: TextActionReach): { top: number; bottom: number } {
  const hitArea = ACTION_LOOK[variant].hitAreas[reach];
  return { top: hitArea.paddingTop, bottom: hitArea.paddingBottom };
}

/**
 * A borderless text button in the accent colour: a shelf's "See all", the Retry
 * after a quiet empty state. Violet here is right, because it can be tapped.
 * It takes no layout space beyond its label; the 44pt (48dp on Material) target
 * is its own padded box, handed back by a negative margin (`hitAreaFor`).
 */
export function TextAction({
  label,
  onPress,
  accessibilityLabel,
  chevron = false,
  reach = 'even',
  testID,
}: TextActionProps) {
  const { systemColors, variant } = useTheme();
  const look = selectByVariant(variant, ACTION_LOOK);
  // The slot is the label's own size, with no margins, so whatever row holds
  // it lines the label up; only the pressable inside leans (`hitAreaFor`).
  return (
    <View style={styles.slot}>
      <PressableSurface
        onPress={onPress}
        feedback="opacity"
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        style={[styles.action, look.hitAreas[reach]]}
        testID={testID}
      >
        <Text variant={look.textVariant} emphasized={look.emphasized} color={systemColors.accent} numberOfLines={1}>
          {label}
        </Text>
        {chevron ? <Icon maxFontSizeMultiplier={1} name="chevron.right" size={12} color={systemColors.accent} /> : null}
      </PressableSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  slot: {
    flexShrink: 0,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
});
