import { View, ScrollView, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { HomeBoardHeader, HomeRecommendedRows, HomeJumpBackIn, HomeBetaRow } from '../../../src/components/home';
import { useActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { useProfile } from '../../../src/lib/graphql/hooks';
import { useAuth } from '../../../src/providers/auth-provider';
import { useBottomChromeMetrics } from '../../../src/hooks/use-bottom-chrome-metrics';
import { brandColors } from '../../../src/theme/colors';
import { iosSystemColors } from '../../../src/theme/ios-colors';
import { spacing, borderRadius } from '../../../src/theme/tokens';

/**
 * Home — the board-aware landing. The app cold-starts on the climbs search tab,
 * so Home is an optional, occasional visit: a place to see what's worth climbing
 * on your board (curated/fresh rows), fresh community beta, and a path back into
 * your playlists. Scoped entirely to the active board.
 */
export default function HomeScreen() {
  const { t } = useTranslation('common');
  const { t: tPlaylists } = useTranslation('playlists');
  const insets = useSafeAreaInsets();
  const bottomChrome = useBottomChromeMetrics();
  const { data: activeBoard } = useActiveBoard();
  const { data: profile } = useProfile();
  const { isAuthenticated } = useAuth();

  const userId = isAuthenticated ? (profile?.id ?? null) : null;

  return (
    <ScrollView
      style={styles.flex}
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={{
        paddingTop: insets.top + spacing[2],
        paddingBottom: bottomChrome.scrollBottomPadding + spacing[6],
      }}
    >
      <Text variant="largeTitle" style={styles.screenTitle}>
        {t('mobile.nav.home')}
      </Text>

      {activeBoard ? (
        <>
          <HomeBoardHeader board={activeBoard} />
          <HomeRecommendedRows
            board={{
              boardName: activeBoard.boardType as BoardName,
              layoutId: activeBoard.layoutId,
              sizeId: activeBoard.sizeId,
              setIds: activeBoard.setIds,
              angle: activeBoard.angle,
            }}
            boardUuid={activeBoard.uuid}
            isOwned={activeBoard.isOwned}
            userId={userId}
          />
          <HomeJumpBackIn boardType={activeBoard.boardType} layoutId={activeBoard.layoutId} />
          <HomeBetaRow boardType={activeBoard.boardType} layoutId={activeBoard.layoutId} />
        </>
      ) : (
        <View style={styles.emptyContainer}>
          <Icon name="boards" size={48} color={iosSystemColors.systemGray4} />
          <Text variant="headline" style={styles.emptyTitle}>
            {tPlaylists('home.pickBoard.title')}
          </Text>
          <Text variant="subheadline" style={styles.emptySubtitle}>
            {tPlaylists('home.pickBoard.description')}
          </Text>
          <Pressable
            onPress={() => router.push('/boards')}
            accessibilityRole="button"
            style={({ pressed }) => [styles.pickButton, pressed && styles.pressed]}
          >
            <Text variant="headline" color={iosSystemColors.white}>
              {tPlaylists('home.pickBoard.cta')}
            </Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  screenTitle: {
    paddingHorizontal: spacing[4],
    paddingTop: 0,
    paddingBottom: spacing[2],
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing[10] * 2,
    paddingHorizontal: 32,
    gap: spacing[2],
  },
  emptyTitle: {
    marginTop: 12,
    opacity: 0.7,
  },
  emptySubtitle: {
    opacity: 0.5,
    textAlign: 'center',
  },
  pickButton: {
    marginTop: spacing[4],
    paddingHorizontal: spacing[6],
    paddingVertical: spacing[3],
    borderRadius: borderRadius.full,
    backgroundColor: brandColors.primary,
  },
  pressed: {
    opacity: 0.85,
  },
});
