import { PressableSurface } from '../PressableSurface';
// The "receipt" for the persistent filter-chip row: one removable pill per active
// filter, built from the existing getActiveFilterTokens output ({key,label,clear}).
// Tapping a pill clears just that one field. Rendered only when ≥1 filter is
// active; on Liquid Glass this replaces the single condensed filter-summary in
// the chrome, so the active filters show exactly once.

import { memo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import type { FilterToken } from '../../lib/filter-tokens';
import { spacing } from '../../theme/tokens';
import { hapticSelection } from '../../lib/haptics';
import { useTheme } from '../../providers/theme-provider';

type FilterTokenRowProps = {
  tokens: FilterToken[];
};

function TokenPill({ token }: { token: FilterToken }) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      onPress={() => {
        hapticSelection();
        token.clear();
      }}
      accessibilityRole="button"
      accessibilityLabel={t('mobile.search.removeFilterAria', { filter: token.label })}
      // An opaque fill: on iOS 26 the row floats over the scrolling list, and a
      // border alone leaves the label sitting on whatever is behind it. The fill
      // is on every path, so the pill is one thing wherever it is drawn: on the
      // Material band it is the band's own colour and does not show; on the iOS
      // band (before iOS 26, Reduce Transparency, Increase Contrast) it shows as
      // a quiet grey pill on the page colour.
      style={[styles.pill, { borderColor: systemColors.separator, backgroundColor: systemColors.secondaryBackground }]}
      hitSlop={6}
    >
      <Text variant="caption1" numberOfLines={1} style={styles.pillLabel}>
        {token.label}
      </Text>
      <Icon name="close" size={14} color={systemColors.secondaryLabel} />
    </PressableSurface>
  );
}

function FilterTokenRowComponent({ tokens }: FilterTokenRowProps) {
  if (tokens.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.list}
      keyboardShouldPersistTaps="handled"
    >
      {tokens.map((token) => (
        <TokenPill key={token.key} token={token} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    gap: spacing[2],
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    paddingStart: spacing[3],
    paddingEnd: spacing[2],
    paddingVertical: spacing[2],
    borderRadius: 20,
    borderWidth: 1,
  },
  pillLabel: {
    fontWeight: '500',
    maxWidth: 200,
  },
});

export const FilterTokenRow = memo(FilterTokenRowComponent);
