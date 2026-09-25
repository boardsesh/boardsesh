import { memo, useCallback, useMemo } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
// RNGH ScrollView (not react-native's): the play drawer's outer scroll is an RNGH
// ScrollView, so this nested horizontal strip must join the same gesture tree or
// Android's outer scroll swallows its horizontal pans and it never scrolls. Same
// pattern as WorkoutTypeShelf / BetaVideosSection.
import { ScrollView } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import type { Climb, BoardName, SimilarClimb } from '@boardsesh/shared-schema';
import * as Haptics from 'expo-haptics';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ClimbListThumbnail } from '../ClimbListThumbnail';
import { buildClimbStub, formatByline, rankBySizeCompatibility } from './similar-climbs-utils';
import { useSimilarClimbs } from '../../lib/graphql/hooks';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useOfflineNudge } from '../../lib/offline-nudges/use-offline-nudge';
import { useConfirmBoardDownload } from '../../offline/use-confirm-board-download';
import { offlineBoardKeyForBoard, useSetting } from '../../settings';
import { OfflineNudgeCard } from '../offline/OfflineNudgeCard';
import { useIsOffline } from '../../hooks/use-is-offline';
import { useToast } from '../../providers/toast-provider';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';

type SimilarClimbsSectionProps = {
  climbUuid: string;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  onClimbPress: (climb: Climb) => void;
};

const SKELETON_COUNT = 3;
const CARD_WIDTH = 96;

export const SimilarClimbsSection = memo(function SimilarClimbsSection({
  climbUuid,
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  onClimbPress,
}: SimilarClimbsSectionProps) {
  const { t } = useTranslation('session');
  const { t: tClimbs } = useTranslation('climbs');
  const { brandColors } = useTheme();
  const { resolveGrade } = useDisplayGrade();
  const scope = useMemo(() => ({ boardName, layoutId, sizeId }), [boardName, layoutId, sizeId]);
  const {
    data: climbs,
    isLoading,
    isError,
    refetch,
    source,
    isResolvingSource,
  } = useSimilarClimbs(scope, climbUuid, angle);

  // Wall-compatible climbs rank first; incompatible ones are dimmed and last.
  const ranked = useMemo(() => rankBySizeCompatibility(climbs ?? [], sizeId), [climbs, sizeId]);

  const handlePress = useCallback(
    (similar: SimilarClimb) => {
      void Haptics.selectionAsync();
      onClimbPress(buildClimbStub(similar, boardName));
    },
    [onClimbPress, boardName],
  );

  const handleRetry = useCallback(() => {
    void Haptics.selectionAsync();
    void refetch();
  }, [refetch]);

  if (isLoading || isResolvingSource) {
    return (
      <View style={styles.loading}>
        <ScrollView
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.scroller}
        >
          {Array.from({ length: SKELETON_COUNT }, (_, index) => (
            <View key={index} style={[styles.card, styles.skeletonCard]} />
          ))}
        </ScrollView>
        {/* The first read of a downloaded board builds its holds index, which
            can take a few seconds on a big catalogue. Say so. */}
        {source === 'local' ? (
          <Text variant="caption1" color={iosSystemColors.systemGray}>
            {t('mobile.similarClimbs.preparing')}
          </Text>
        ) : null}
      </View>
    );
  }

  // Similar climbs only read a downloaded board (the server query is too
  // expensive to run for everyone), so a board that is not downloaded gets
  // the download offer in place of the strip.
  if (source === 'download') {
    return <SimilarClimbsDownloadOffer boardName={boardName} layoutId={layoutId} sizeId={sizeId} />;
  }

  if (isError) {
    return (
      <Pressable
        onPress={handleRetry}
        style={styles.emptyContainer}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.similarClimbs.retry')}
      >
        <Icon name="refresh" size={20} color={brandColors.primary} />
        <Text variant="subheadline" color={brandColors.primary}>
          {t('mobile.similarClimbs.retry')}
        </Text>
      </Pressable>
    );
  }

  if (ranked.length === 0) return <SimilarClimbsEmpty message={t('mobile.similarClimbs.empty')} />;

  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.scroller}
    >
      {ranked.map(({ climb: similar, compatible }) => {
        // SimilarClimb carries no Boardsesh grade today, so `resolveGrade` falls
        // back to the legacy label + colour — lights up once the backend stamps them.
        const { label: formattedGrade, color: gradeColor } = resolveGrade({ difficulty: similar.difficultyName });
        const byline = formatByline(similar, tClimbs);
        return (
          <Pressable
            key={similar.uuid}
            onPress={() => handlePress(similar)}
            style={({ pressed }) => [styles.card, !compatible && styles.cardDimmed, pressed && styles.cardPressed]}
            accessibilityRole="button"
            accessibilityLabel={similar.name || t('mobile.queue.unknownClimb')}
          >
            <ClimbListThumbnail
              frames={similar.frames ?? ''}
              boardName={boardName as BoardName}
              layoutId={similar.layoutId}
              sizeId={sizeId}
              setIds={setIds}
            />
            <Text variant="subheadline" numberOfLines={2} style={styles.name}>
              {similar.name}
            </Text>
            {formattedGrade ? (
              <View style={[styles.gradeChip, { backgroundColor: gradeColor }]}>
                <Text variant="caption2" color={iosSystemColors.white}>
                  {formattedGrade}
                </Text>
              </View>
            ) : null}
            {byline ? (
              <Text variant="caption2" color={iosSystemColors.systemGray} numberOfLines={1} style={styles.byline}>
                {byline}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
});

function SimilarClimbsEmpty({ message }: { message: string }) {
  return (
    <View style={styles.emptyContainer}>
      <Icon name="search" size={20} color={iosSystemColors.systemGray} />
      <Text variant="subheadline" color={iosSystemColors.systemGray}>
        {message}
      </Text>
    </View>
  );
}

type DownloadOfferProps = { boardName: string; layoutId: number; sizeId: number };

/**
 * The carrot for a board that is not on the phone. Offered only for the
 * climber's ACTIVE board, and only when the drawer shows that exact board
 * (type, layout, size): a climb reached by deep link or a party queue may be
 * on a board this climber does not own, and downloading a stranger's board
 * from here would be the wrong offer. Those get the plain empty state.
 */
const SimilarClimbsDownloadOffer = memo(function SimilarClimbsDownloadOffer({
  boardName,
  layoutId,
  sizeId,
}: DownloadOfferProps) {
  const { t } = useTranslation('session');
  const { t: tBoards } = useTranslation('boards');
  const { data: activeBoard } = useActiveBoard();
  const board =
    activeBoard &&
    activeBoard.boardType === boardName &&
    activeBoard.layoutId === layoutId &&
    activeBoard.sizeId === sizeId
      ? activeBoard
      : null;
  const nudge = useOfflineNudge({ surface: 'similar_climbs', board });
  const { confirmAndDownload, armWithoutConfirm } = useConfirmBoardDownload();
  const [enabledScopeKeys] = useSetting('syncEnabledBoards');
  const isOffline = useIsOffline();
  const { showToast } = useToast();

  const handleDownload = useCallback(() => {
    if (!board) return;
    void Haptics.selectionAsync();
    const attribution = { trigger: 'similar_climbs', source: 'play_drawer' } as const;
    // No signal: arm only. A cycle kicked from here would fail and spend a
    // bootstrap attempt (see OfflineCatalogCta); the scheduler pulls the board
    // the moment the phone reconnects.
    if (isOffline) {
      nudge.accept('armed');
      armWithoutConfirm(board, attribution);
      showToast(tBoards('mobile.offline.nudge.noCatalog.armedToast', { name: board.name }), 'success');
      return;
    }
    // The size dialog inside confirmAndDownload is the consent gate: only a
    // confirmed download counts as an accept.
    void confirmAndDownload(board, attribution).then((confirmed) => {
      if (confirmed) nudge.accept('download');
    });
  }, [board, isOffline, nudge, armWithoutConfirm, confirmAndDownload, showToast, tBoards]);

  if (board && nudge.visible) {
    return (
      <OfflineNudgeCard
        testID="similar-climbs-download-offer"
        title={tBoards('mobile.offline.nudge.similarClimbs.title')}
        body={tBoards('mobile.offline.nudge.similarClimbs.body', { name: board.name })}
        primaryLabel={tBoards('mobile.offline.nudge.similarClimbs.cta', { name: board.name })}
        onPrimary={handleDownload}
        dismissLabel={tBoards('mobile.offline.nudge.notNow')}
        onDismiss={() => nudge.dismiss('once')}
      />
    );
  }

  // Already asked for (armed or mid-download): say when the strip arrives
  // rather than "no similar climbs", which would read as the real answer.
  if (board && enabledScopeKeys.includes(offlineBoardKeyForBoard(board))) {
    return <SimilarClimbsEmpty message={t('mobile.similarClimbs.waitingForDownload', { name: board.name })} />;
  }

  return <SimilarClimbsEmpty message={t('mobile.similarClimbs.empty')} />;
});

const styles = StyleSheet.create({
  scroller: {
    gap: spacing[3],
    paddingVertical: spacing[1],
  },
  card: {
    width: CARD_WIDTH,
    gap: spacing[1],
  },
  cardPressed: {
    opacity: 0.6,
  },
  cardDimmed: {
    opacity: 0.45,
  },
  skeletonCard: {
    height: spacing[16],
    borderRadius: borderRadius.md,
    backgroundColor: `${iosSystemColors.systemGray}14`,
  },
  name: {
    marginTop: spacing[1],
  },
  gradeChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing[2],
    paddingVertical: 1,
    borderRadius: borderRadius.full,
  },
  byline: {
    width: '100%',
  },
  loading: {
    gap: spacing[2],
  },
  emptyContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
});
