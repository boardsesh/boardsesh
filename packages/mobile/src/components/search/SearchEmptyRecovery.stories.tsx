import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import type { StoryModule } from '../../dev/stories/types';
import type { FilterToken } from '../../lib/filter-tokens';
import { NO_LOCKED_DIMENSIONS } from '../../lib/dimension-chips';
import { SearchEmptyRecovery } from './SearchEmptyRecovery';

const noop = () => {};

// The former resolved-empty branch, retained only in the dev story registry
// for a before/after comparison against the recovery component.
function BeforeRecovery() {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  return (
    <View style={styles.beforeContainer}>
      <Icon name="search" size={48} color={systemColors.tertiaryLabel} />
      <Text variant="headline" style={styles.beforeTitle}>
        {t('mobile.emptyState.noMatches.title')}
      </Text>
      <Text variant="subheadline" style={styles.beforeSubtitle}>
        {t('mobile.emptyState.noMatches.description', { query: 'Moonage' })}
      </Text>
    </View>
  );
}

function AfterRecovery({ filtered = true }: { filtered?: boolean }) {
  const { t } = useTranslation('climbs');
  const [hasRating, setHasRating] = useState(filtered);
  const [hasSetter, setHasSetter] = useState(filtered);
  const tokens: FilterToken[] = [];
  if (hasRating)
    tokens.push({ key: 'minRating', label: t('mobile.search.rating', { count: 4 }), clear: () => setHasRating(false) });
  if (hasSetter)
    tokens.push({
      key: 'setter',
      label: t('mobile.search.setterName', { setter: 'Sam' }),
      clear: () => setHasSetter(false),
    });
  return (
    <SearchEmptyRecovery
      query="Moonage"
      boardName="Kilter Homewall"
      angle={40}
      tokens={tokens}
      lockedDimensions={NO_LOCKED_DIMENSIONS}
      onOpenFilters={noop}
    />
  );
}

const stories: StoryModule = {
  title: 'Climb search / Empty recovery',
  stories: {
    before: { name: 'Before: resolved empty search', render: () => <BeforeRecovery /> },
    after: { name: 'After: remove one chosen filter', render: () => <AfterRecovery /> },
    unfiltered: { name: 'After: no removable filters', render: () => <AfterRecovery filtered={false} /> },
  },
};

export default stories;

const styles = StyleSheet.create({
  beforeContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 120,
    paddingHorizontal: 32,
    gap: 8,
  },
  beforeTitle: { marginTop: 12, opacity: 0.6 },
  beforeSubtitle: { opacity: 0.4, textAlign: 'center' },
});
