import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { useTheme } from '../providers/theme-provider';
import { Icon } from './Icon';
import type { IconName } from './icon-map';
import { withAlpha } from '@boardsesh/velvet-tokens';
import type { StatusColors } from '../theme/variants/variant-tokens';
import { borderRadius, spacing } from '../theme/tokens';

/**
 * `neutral` is the quiet default. `positive` and `warning` tint the capsule with the
 * semantic green or orange ("Connected", "Improved") and never use the brand violet.
 */
export type StatusPillTone = 'neutral' | 'positive' | 'warning';

export type StatusPillProps = {
  label: string;
  tone?: StatusPillTone;
  /** A 12pt glyph before the label, in the label colour. */
  icon?: IconName;
  testID?: string;
};

const TINT_ALPHA = 0.15;

function toneColors(status: StatusColors, brand: { success: string; warning: string }, tone: StatusPillTone) {
  switch (tone) {
    case 'neutral':
      return status;
    case 'positive':
      return { fill: withAlpha(brand.success, TINT_ALPHA), label: brand.success };
    case 'warning':
      return { fill: withAlpha(brand.warning, TINT_ALPHA), label: brand.warning };
    default:
      tone satisfies never;
      return status;
  }
}

/**
 * A status you can't tap ("Ready to review", "Following"): `theme.status`, a quiet
 * `tertiaryFill` capsule with `secondaryLabel` text in caption 1 at its
 * emphasized weight. Never violet, so it doesn't read as a button beside one.
 *
 * It never shrinks and never truncates: put it in a row beside text that can
 * (`ArtRow`'s `status` does this), so the title gives way first.
 */
export const StatusPill = memo(function StatusPill({ label, tone = 'neutral', icon, testID }: StatusPillProps) {
  const { status, brandColors } = useTheme();
  const colors = toneColors(status, brandColors, tone);
  const fillStyle = useMemo(() => [styles.pill, { backgroundColor: colors.fill }], [colors.fill]);
  return (
    <View style={fillStyle} testID={testID}>
      {icon ? <Icon name={icon} size={12} color={colors.label} /> : null}
      <Text variant="caption1" emphasized color={colors.label}>
        {label}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  pill: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
});
