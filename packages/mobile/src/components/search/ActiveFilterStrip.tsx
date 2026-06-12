import { StyleSheet, type StyleProp, View, type ViewStyle } from 'react-native';
import { Chip } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import type { FilterToken } from '../../lib/filter-tokens';
import { useTheme } from '../../providers/theme-provider';
import { withAlpha } from '../../theme/colors';
import { spacing } from '../../theme/tokens';
import { iconMap } from '../icon-map';

type ActiveFilterStripProps = {
  totalCount?: number;
  tokens: readonly FilterToken[];
  align?: 'start' | 'end';
  style?: StyleProp<ViewStyle>;
};

export function ActiveFilterStrip({ totalCount, tokens, align = 'start', style }: ActiveFilterStripProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  const showCount = totalCount != null;
  if (!showCount && tokens.length === 0) return null;

  return (
    <View style={[styles.row, align === 'end' ? styles.alignEnd : null, style]}>
      {showCount ? (
        <Chip
          compact
          mode="flat"
          icon={iconMap.search.android}
          accessibilityLabel={t('mobile.search.climbsCount', { count: totalCount })}
          style={[
            styles.chip,
            styles.countChip,
            {
              backgroundColor: withAlpha(brandColors.primary, 0.12),
              borderColor: withAlpha(brandColors.primary, 0.18),
            },
          ]}
          textStyle={[styles.chipText, { color: brandColors.primary }]}
        >
          {t('mobile.search.climbsCount', { count: totalCount })}
        </Chip>
      ) : null}
      {tokens.map((token) => (
        <Chip
          key={token.key}
          compact
          mode="flat"
          onPress={token.clear}
          onClose={token.clear}
          closeIcon={iconMap.close.android}
          accessibilityLabel={token.label}
          style={[styles.chip, { backgroundColor: systemColors.fill }]}
          textStyle={[styles.chipText, { color: systemColors.label }]}
        >
          {token.label}
        </Chip>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  alignEnd: {
    justifyContent: 'flex-end',
  },
  chip: {
    minHeight: 30,
  },
  countChip: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: {
    fontWeight: '600',
  },
});
