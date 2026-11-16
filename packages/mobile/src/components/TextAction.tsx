import { StyleSheet } from 'react-native';
import { Text, type TextVariant } from './Text';
import { Icon } from './Icon';
import { PressableSurface } from './PressableSurface';
import { useTheme } from '../providers/theme-provider';
import { selectByVariant } from '../theme/variants';
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

type ActionText = { textVariant: TextVariant; emphasized: boolean };

/**
 * The type of a borderless text button beside other text. Liquid Glass sets it in
 * subheadline at the emphasized weight (SectionHeader's "See all" is the same
 * semibold accent, a step smaller to sit under its footnote heading); Material
 * uses labelLarge (14/500), the M3 text-button type, unemphasized.
 */
const ACTION_TEXT: Record<UiVariant, ActionText> = {
  liquidGlass: { textVariant: 'subheadline', emphasized: true },
  material: { textVariant: 'label', emphasized: false },
};

/**
 * The label is about 20pt tall, so 12pt above and below bring the target to the
 * 44pt minimum without the action adding height to the row it sits in.
 */
const ACTION_HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 8 } as const;

/**
 * A borderless text button in the accent colour: a shelf's "See all", the Retry
 * after a quiet empty state. Violet here is right, because it can be tapped.
 * It takes no layout space beyond its label; the 44pt target comes from
 * `hitSlop`.
 */
export function TextAction({ label, onPress, accessibilityLabel, chevron = false, testID }: TextActionProps) {
  const { systemColors, variant } = useTheme();
  const actionText = selectByVariant(variant, ACTION_TEXT);
  return (
    <PressableSurface
      onPress={onPress}
      feedback="opacity"
      hitSlop={ACTION_HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={styles.action}
      testID={testID}
    >
      <Text
        variant={actionText.textVariant}
        emphasized={actionText.emphasized}
        color={systemColors.accent}
        numberOfLines={1}
      >
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
