import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { useTheme } from '../providers/theme-provider';
import type { StatusColors } from '../theme/variants/variant-tokens';
import { borderRadius, spacing } from '../theme/tokens';

/** Only `neutral` today. A positive or warning tone joins when a semantic colour covers it. */
export type StatusPillTone = 'neutral';

export type StatusPillProps = {
  label: string;
  tone?: StatusPillTone;
  testID?: string;
};

function toneColors(status: StatusColors, tone: StatusPillTone): StatusColors {
  switch (tone) {
    case 'neutral':
      return status;
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
export const StatusPill = memo(function StatusPill({ label, tone = 'neutral', testID }: StatusPillProps) {
  const { status } = useTheme();
  const colors = toneColors(status, tone);
  const fillStyle = useMemo(() => [styles.pill, { backgroundColor: colors.fill }], [colors.fill]);
  return (
    <View style={fillStyle} testID={testID}>
      <Text variant="caption1" emphasized color={colors.label}>
        {label}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  pill: {
    flexShrink: 0,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
});
