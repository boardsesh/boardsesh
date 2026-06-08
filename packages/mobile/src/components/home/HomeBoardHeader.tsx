import { memo } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { useQueue } from '../../providers/queue-provider';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';

export type HomeBoardHeaderProps = {
  board: UserBoard;
};

/**
 * Compact header scoping Home to the active board: name + layout/size/angle, a
 * "Switch" affordance to the board picker, and — only when a session is live —
 * a "Continue session" chip. Deliberately light: Home is an optional visit, so
 * the curated rows below are the draw, not this header.
 */
export const HomeBoardHeader = memo(function HomeBoardHeader({ board }: HomeBoardHeaderProps) {
  const { t } = useTranslation('playlists');
  const { sessionId } = useQueue();

  const subtitle = [board.layoutName ?? board.sizeName ?? null, `${board.angle}°`].filter(Boolean).join(' · ');

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <View style={styles.titleColumn}>
          <Text variant="title2" numberOfLines={1} style={styles.boardName}>
            {board.name}
          </Text>
          {subtitle ? (
            <Text variant="footnote" numberOfLines={1} style={styles.subtitle}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={() => router.push({ pathname: '/boards', params: { returnTo: '/(tabs)/home' } })}
          accessibilityRole="button"
          hitSlop={8}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Text variant="subheadline" color={brandColors.primary} style={styles.switchLabel}>
            {t('home.switchBoard')}
          </Text>
        </Pressable>
      </View>

      {sessionId ? (
        <Pressable
          onPress={() => router.push('/(tabs)/record')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.sessionChip, pressed && styles.pressed]}
        >
          <Text variant="subheadline" color={iosSystemColors.white} style={styles.sessionLabel}>
            {t('home.continueSession')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
    gap: spacing[3],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  titleColumn: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  boardName: {
    fontWeight: '700',
  },
  subtitle: {
    opacity: 0.6,
  },
  switchLabel: {
    fontWeight: '600',
  },
  sessionChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.full,
    backgroundColor: brandColors.primary,
  },
  sessionLabel: {
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.6,
  },
});
