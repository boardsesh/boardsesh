import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { EmptyState } from '../EmptyState';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { hapticSelection } from '../../lib/haptics';
import type { FilterToken } from '../../lib/filter-tokens';
import type { LockedDimensions } from '../../lib/dimension-chips';
import { getSearchRecoveryTokens } from '../../lib/search-empty-recovery';

type SearchEmptyRecoveryProps = {
  query: string;
  boardName: string;
  angle: number;
  tokens: readonly FilterToken[];
  lockedDimensions: LockedDimensions;
  onOpenFilters: () => void;
};

const RemoveFilterAction = memo(function RemoveFilterAction({ token }: { token: FilterToken }) {
  const { t } = useTranslation('climbs');
  const { systemColors, radii } = useTheme();
  const label = t('mobile.search.removeFilterAria', { filter: token.label });
  return (
    <PressableSurface
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        hapticSelection();
        token.clear();
      }}
      style={[
        styles.removeAction,
        {
          borderColor: systemColors.separator,
          backgroundColor: systemColors.secondaryBackground,
          borderRadius: radii.button,
        },
      ]}
    >
      <Text variant="subheadline" style={[styles.actionLabel, { color: systemColors.accent }]}>
        {label}
      </Text>
      <Icon name="close" size={16} color={systemColors.accent} />
    </PressableSurface>
  );
});

export const SearchEmptyRecovery = memo(function SearchEmptyRecovery({
  query,
  boardName,
  angle,
  tokens,
  lockedDimensions,
  onOpenFilters,
}: SearchEmptyRecoveryProps) {
  const { t } = useTranslation('climbs');
  const recoveryTokens = useMemo(() => getSearchRecoveryTokens(tokens, lockedDimensions), [tokens, lockedDimensions]);
  return (
    <EmptyState
      size="section"
      icon="search"
      testID="search-empty-recovery"
      title={query.length > 0 ? t('mobile.emptyState.noMatches.title') : t('mobile.emptyState.noClimbs.title')}
      body={
        query.length > 0
          ? t('mobile.emptyState.noMatches.description', { query })
          : t('mobile.emptyState.noClimbs.subtitle')
      }
      actions={
        <>
          <Text variant="subheadline" style={styles.centered}>
            {t('mobile.emptyState.recovery.scope', { board: boardName, angle })}
          </Text>
          {tokens.length > 0 ? (
            <Text variant="footnote" tone="secondary" style={styles.centered}>
              {t('mobile.emptyState.recovery.filters', { filters: tokens.map((token) => token.label).join(' · ') })}
            </Text>
          ) : null}
          {recoveryTokens.length > 0 ? (
            <>
              <Text variant="subheadline" tone="secondary" style={styles.centered}>
                {t('mobile.emptyState.recovery.removeHint')}
              </Text>
              <View style={styles.actions}>
                {recoveryTokens.map((token) => (
                  <RemoveFilterAction key={token.key} token={token} />
                ))}
              </View>
            </>
          ) : null}
          <Button title={t('mobile.emptyState.recovery.openFilters')} variant="outlined" onPress={onOpenFilters} />
        </>
      }
    />
  );
});

const styles = StyleSheet.create({
  centered: {
    textAlign: 'center',
  },
  actions: {
    alignSelf: 'stretch',
    gap: spacing[2],
  },
  removeAction: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: spacing[2],
  },
  actionLabel: {
    flex: 1,
  },
});
