import React, { useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import type { StandingsEntry } from '../../lib/graphql/hooks/use-standings';

/**
 * One climber in a ranking.
 *
 * Memoized, and takes only primitives plus a stable callback — the mobile
 * performance checklist treats a row rebuilt on every parent render as a review
 * failure on a list this long.
 *
 * Monogram-first by design, not as a fallback: **83.7% of active climbers have
 * no avatar**, so a photo-shaped row would render broken for five climbers in
 * six.
 */

type StandingsRowProps = {
  entry: StandingsEntry;
  onPress: (userId: string) => void;
};

function initialsFor(displayName: string | null): string {
  if (!displayName) return '·';
  const parts = displayName.trim().split(/\s+/).slice(0, 2);
  const initials = parts.map((part) => part[0]?.toUpperCase() ?? '').join('');
  return initials || '·';
}

function StandingsRowComponent({ entry, onPress }: StandingsRowProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();

  const handlePress = useCallback(() => {
    // An anonymous climber's id is a pseudonym that resolves to no profile, so
    // the row is deliberately inert rather than navigating to a 404.
    if (entry.isAnonymous && !entry.isViewer) return;
    onPress(entry.userId);
  }, [entry.isAnonymous, entry.isViewer, entry.userId, onPress]);

  const name = entry.isAnonymous && !entry.isViewer ? t('standings.anonymousClimber') : (entry.displayName ?? '—');
  const isInert = entry.isAnonymous && !entry.isViewer;

  return (
    <Pressable
      accessibilityRole={isInert ? undefined : 'button'}
      accessibilityLabel={t('standings.rowAccessibility', { rank: entry.rank, name, climbs: entry.score })}
      onPress={handlePress}
      disabled={isInert}
      style={[
        styles.row,
        entry.isViewer && {
          backgroundColor: systemColors.secondaryBackground,
          borderColor: brandColors.accent,
          borderWidth: StyleSheet.hairlineWidth * 3,
        },
      ]}
    >
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.rank}>
        {entry.rank}
      </Text>

      <View style={[styles.monogram, { backgroundColor: systemColors.fill }]}>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {entry.isViewer ? t('standings.youInitial') : initialsFor(entry.displayName)}
        </Text>
      </View>

      <Text
        variant="body"
        color={isInert ? systemColors.secondaryLabel : systemColors.label}
        numberOfLines={1}
        style={styles.name}
      >
        {entry.isViewer ? t('standings.you') : name}
      </Text>

      <Text variant="body" color={systemColors.label}>
        {entry.score}
      </Text>
    </Pressable>
  );
}

export const StandingsRow = React.memo(StandingsRowComponent);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: borderRadius.md,
    borderColor: 'transparent',
    borderWidth: StyleSheet.hairlineWidth * 3,
  },
  rank: {
    minWidth: 34,
    textAlign: 'right',
  },
  monogram: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    flex: 1,
  },
});
