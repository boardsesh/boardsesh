import { useCallback, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { betaLinkIdentity } from '@boardsesh/shared-schema';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { Button } from '../../../src/components/Button';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { BetaVideoCard } from '../../../src/components/play-drawer/BetaVideoCard';
import { useUserBetaLinks, type RecentBetaVideo } from '../../../src/lib/graphql/hooks';
import { useBottomChromeMetrics } from '../../../src/hooks/use-bottom-chrome-metrics';
import { useTheme } from '../../../src/providers/theme-provider';
import { spacing } from '../../../src/theme/tokens';

const GRID_COLUMNS = 3;
const GRID_PAGE_SIZE = 30;

const keyExtractor = (video: RecentBetaVideo) => betaLinkIdentity(video.betaLink.link);

/**
 * Full vertical grid of a climber's beta videos — the "See all" target of the
 * profile beta shelf. Same offset-paged hook as the shelf, drained one page per
 * end-reach.
 */
export default function UserBetaScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const { t } = useTranslation('you');
  const { systemColors } = useTheme();
  const navigation = useNavigation();
  const bottomChrome = useBottomChromeMetrics();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[4];

  const { videos, isLoading, isLoadingMore, hasError, loadMore, refetch } = useUserBetaLinks(userId, GRID_PAGE_SIZE);

  // Solid native header with a title + back button (the root stack defaults to
  // headerShown: false), matching the "See all" playlist screen.
  useEffect(() => {
    navigation.setOptions({
      headerShown: true,
      headerTransparent: false,
      headerBlurEffect: undefined,
      title: t('mobile.profile.betaShelf.allTitle'),
    });
  }, [navigation, t]);

  const renderItem = useCallback(
    ({ item }: { item: RecentBetaVideo }) => (
      <View style={styles.cell}>
        <BetaVideoCard link={item.betaLink} />
      </View>
    ),
    [],
  );

  if (isLoading && videos.length === 0) {
    return (
      <View style={[styles.flex, styles.centered, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (hasError && videos.length === 0) {
    return (
      <View style={[styles.flex, styles.centered, { backgroundColor: systemColors.background }]}>
        <Icon name="error" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.profile.errorTitle')}
        </Text>
        <View style={styles.stateCta}>
          <Button title={t('mobile.social.retry')} onPress={refetch} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      <FlashList
        data={videos}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        numColumns={GRID_COLUMNS}
        contentContainerStyle={{ paddingTop: spacing[3], paddingBottom, paddingHorizontal: spacing[2] }}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          <View style={styles.stateBlock}>
            <Icon name="video" size={48} color={systemColors.tertiaryLabel} />
            <Text variant="headline" style={styles.stateTitle}>
              {t('mobile.profile.betaShelf.empty')}
            </Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.stateBody}>
              {t('mobile.profile.betaShelf.emptyBody')}
            </Text>
          </View>
        }
        ListFooterComponent={
          isLoadingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator size="small" />
            </View>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing[8] },
  cell: {
    flex: 1,
    alignItems: 'center',
    marginBottom: spacing[3],
  },
  stateBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing[16],
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  stateTitle: {
    marginTop: spacing[3],
    textAlign: 'center',
  },
  stateBody: {
    textAlign: 'center',
  },
  stateCta: {
    marginTop: spacing[4],
  },
  footer: {
    paddingVertical: spacing[5],
    alignItems: 'center',
  },
});
