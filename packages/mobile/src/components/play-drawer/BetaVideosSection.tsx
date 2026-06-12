import { memo, useCallback, useRef } from 'react';
import { ScrollView, View, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';
import { betaLinkIdentity } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useBetaLinks, useProfile } from '../../lib/graphql/hooks';
import { useAuth } from '../../providers/auth-provider';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { BetaVideoCard, BETA_CARD_WIDTH, BETA_CARD_HEIGHT } from './BetaVideoCard';
import { BetaVideoAddSheet, type BetaVideoAddSheetHandle } from './BetaVideoAddSheet';

type BetaVideosSectionProps = {
  climbUuid: string;
  boardName: string;
  angle: number;
};

const SKELETON_COUNT = 3;
const CARD_GAP = spacing[3];

export const BetaVideosSection = memo(function BetaVideosSection({
  climbUuid,
  boardName,
  angle,
}: BetaVideosSectionProps) {
  const { t } = useTranslation('session');
  const { isAuthenticated } = useAuth();
  const { brandColors } = useTheme();
  const addSheetRef = useRef<BetaVideoAddSheetHandle>(null);
  const { data: links, isLoading, isError, refetch, isRefetching } = useBetaLinks(boardName, climbUuid);
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const currentUserId = profile?.id ?? null;

  const handleOpenAddSheet = useCallback(() => {
    void Haptics.selectionAsync();
    addSheetRef.current?.open();
  }, []);

  const handleRetry = useCallback(() => {
    void Haptics.selectionAsync();
    void refetch();
  }, [refetch]);

  const hasContent = links !== undefined && links.length > 0;

  return (
    <View>
      <View style={styles.headerRow}>
        {hasContent && (
          <Text variant="footnote" color={iosSystemColors.systemGray}>
            {t('mobile.betaVideos.videoCount', { count: links.length })}
          </Text>
        )}
        <View style={styles.headerSpacer} />
        {isAuthenticated && (
          <Pressable
            onPress={handleOpenAddSheet}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.betaVideos.addButton')}
            style={({ pressed }) => [styles.addButton, pressed && { backgroundColor: `${brandColors.primary}1A` }]}
            hitSlop={8}
          >
            <Icon name="add" size={22} color={brandColors.primary} />
          </Pressable>
        )}
      </View>

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
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          snapToInterval={BETA_CARD_WIDTH + CARD_GAP}
          decelerationRate="fast"
          snapToAlignment="start"
        >
          {links.map((link) => (
            <BetaVideoCard
              key={betaLinkIdentity(link.link)}
              link={link}
              boardName={boardName}
              climbUuid={climbUuid}
              currentUserId={currentUserId}
            />
          ))}
        </ScrollView>
      )}

      {isAuthenticated && (
        <BetaVideoAddSheet ref={addSheetRef} boardName={boardName} climbUuid={climbUuid} angle={angle} />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: spacing[2],
    minHeight: 24,
  },
  headerSpacer: {
    flex: 1,
  },
  addButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.full,
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
