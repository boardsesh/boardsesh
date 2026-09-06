import { memo, useCallback } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
// The play drawer's outer scroll is a react-native-gesture-handler ScrollView, so
// a nested horizontal shelf must also be RNGH's ScrollView — otherwise on Android
// the outer scroll's native gesture handler swallows the horizontal pans and this
// strip never scrolls (a plain RN ScrollView isn't in RNGH's gesture tree). Same
// pattern as WorkoutTypeShelf inside PreSessionView's RNGH scroll.
import { ScrollView } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';
import { betaLinkIdentity } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useBetaLinks } from '../../lib/graphql/hooks';
import { useIsOffline } from '../../hooks/use-is-offline';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { BetaVideoCard, BETA_CARD_WIDTH, BETA_CARD_HEIGHT } from './BetaVideoCard';

type BetaVideosSectionProps = {
  climbUuid: string;
  boardName: string;
};

const SKELETON_COUNT = 3;
const CARD_GAP = spacing[3];

// The "+" add button now lives in the section header (DeferredSections passes it
// as the CollapsibleSection headerAction, so it sits to the right of the "Beta
// Videos" title). This component just renders the count + carousel + states.
export const BetaVideosSection = memo(function BetaVideosSection({ climbUuid, boardName }: BetaVideosSectionProps) {
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const { brandColors } = useTheme();
  // The cheap boolean, not the whole snapshot: this section is memo'd inside
  // the play drawer, and subscribing to every probe result and failure-counter
  // tick would re-render it for changes it does not read.
  const effectiveOffline = useIsOffline();
  const { data: links, isLoading, isError, refetch, isRefetching } = useBetaLinks(boardName, climbUuid);

  const handleRetry = useCallback(() => {
    void Haptics.selectionAsync();
    void refetch();
  }, [refetch]);

  const hasContent = links !== undefined && links.length > 0;

  return (
    <View>
      {hasContent && (
        <View style={styles.headerRow}>
          <Text variant="footnote" color={iosSystemColors.systemGray}>
            {t('mobile.betaVideos.videoCount', { count: links.length })}
          </Text>
        </View>
      )}

      {isLoading ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          scrollEnabled={false}
        >
          {Array.from({ length: SKELETON_COUNT }).map((_, index) => (
            <View key={`skeleton-${index}`} style={styles.skeletonCard} />
          ))}
        </ScrollView>
      ) : effectiveOffline && !hasContent ? (
        // Nothing can reach us, so a red error glyph and a Retry that cannot
        // possibly work are noise in a drawer that is otherwise happily offline
        // — and "No beta videos yet" would be a claim we can't back. One muted
        // line; the global connectivity banner owns the recovery.
        <View style={styles.errorContainer}>
          <Text variant="subheadline" color={iosSystemColors.systemGray} style={styles.errorText}>
            {tCommon('mobile.connectivity.needsConnection')}
          </Text>
        </View>
      ) : isError ? (
        <View style={styles.errorContainer}>
          <Icon name="error" size={20} color={iosSystemColors.systemRed} />
          <Text variant="subheadline" color={iosSystemColors.systemGray} style={styles.errorText}>
            {t('mobile.betaVideos.errorTitle')}
          </Text>
          <Pressable
            onPress={handleRetry}
            disabled={isRefetching}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.betaVideos.retry')}
            style={({ pressed }) => [
              styles.retryButton,
              { borderColor: brandColors.primary },
              isRefetching && styles.retryButtonDisabled,
              pressed && !isRefetching && { backgroundColor: `${brandColors.primary}1A` },
            ]}
          >
            <Text variant="footnote" color={brandColors.primary}>
              {t('mobile.betaVideos.retry')}
            </Text>
          </Pressable>
        </View>
      ) : !links || links.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Icon name="video" size={20} color={iosSystemColors.systemGray} />
          <Text variant="subheadline" color={iosSystemColors.systemGray}>
            {t('mobile.betaVideos.empty')}
          </Text>
        </View>
      ) : (
        <ScrollView
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          snapToInterval={BETA_CARD_WIDTH + CARD_GAP}
          decelerationRate="fast"
          snapToAlignment="start"
        >
          {links.map((link) => (
            <BetaVideoCard key={betaLinkIdentity(link.link)} link={link} />
          ))}
        </ScrollView>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: spacing[2],
  },
  scrollContent: {
    gap: CARD_GAP,
    paddingVertical: spacing[1],
  },
  skeletonCard: {
    width: BETA_CARD_WIDTH,
    height: BETA_CARD_HEIGHT,
    borderRadius: borderRadius.md,
    backgroundColor: `${iosSystemColors.systemGray}26`,
  },
  emptyContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingVertical: spacing[3],
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingVertical: spacing[3],
  },
  errorText: {
    flex: 1,
  },
  retryButton: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  retryButtonDisabled: {
    opacity: 0.5,
  },
});
