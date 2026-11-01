import { forwardRef, memo, useCallback, useImperativeHandle, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { router } from 'expo-router';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { BoardName } from '@boardsesh/shared-schema';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { SegmentedControl } from '../SegmentedControl';
import type { SegmentOption } from '../SegmentedControl.types';
import type { QueueItemRowBoard } from '../QueueItemRow';
import { Text } from '../Text';
import { SwitchBoardFooter } from '../board-presence/SwitchBoardFooter';
import { QueueListBody } from './QueueListBody';
import { LogbookSection } from './LogbookSection';
import { BetaVideosSection } from './BetaVideosSection';
import { PLAYER_SIDE_PANEL_WIDTH } from './play-drawer-layout';
import type { PlayerSidePanelClimb } from './play-drawer-types';
import { useQueueData } from '../../providers/queue-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { formatActiveBoardLabel } from '../../lib/boards/active-board-label';
import { track } from '../../lib/analytics';
import { spacing } from '../../theme/tokens';

export type PlayerSidePanelSegment = 'upNext' | 'logbook' | 'beta';

export type PlayerSidePanelHandle = {
  /** Bring Up next forward: the player's queue button lands here instead of a sheet. */
  showUpNext: () => void;
};

type QueueRowHandlers = {
  onClimbPress: (item: ClimbQueueItem) => void;
  onOpenActions: (item: ClimbQueueItem) => void;
  onSuggestionPress: (climb: Climb, source: PlaylistSuggestionSource) => void;
  onTickHistory: (item: ClimbQueueItem) => void;
};

type PlayerSidePanelProps = QueueRowHandlers & {
  displayed: PlayerSidePanelClimb | null;
  /** The queue's rows render against the stored active board; null before one resolves. */
  queueBoard: QueueItemRowBoard | null;
};

/**
 * The landscape iPad player's right-hand panel: Up next, Logbook and Beta behind
 * one segmented control, and Switch board at its foot (where Music keeps
 * AirPlay). It opens on Up next. The segment lives here, so a tap re-renders the
 * panel and not the player beside it.
 *
 * Up next stays mounted behind the other segments: its edit mode, selection
 * and Undo survive a look at the logbook. Logbook and Beta mount only while
 * chosen, so their reads run for the segment on screen.
 */
export const PlayerSidePanel = memo(
  forwardRef<PlayerSidePanelHandle, PlayerSidePanelProps>(function PlayerSidePanel(
    { displayed, queueBoard, onClimbPress, onOpenActions, onSuggestionPress, onTickHistory },
    ref,
  ) {
    const { t } = useTranslation('session');
    const insets = useSafeAreaInsets();
    const { systemColors } = useTheme();
    const { data: activeBoard } = useActiveBoard();
    const boardLabel = useMemo(() => formatActiveBoardLabel(activeBoard), [activeBoard]);
    const { boardId: boardPresenceBoardId } = useBoardPresenceControls();
    const [segment, setSegment] = useState<PlayerSidePanelSegment>('upNext');

    useImperativeHandle(ref, () => ({ showUpNext: () => setSegment('upNext') }), []);

    // The same tap event as the wall column's footer, then the picker. `/play`
    // as the return closes only the picker, so the climber lands back here.
    const handleSwitchBoard = useCallback(() => {
      track(SHARED_EVENTS.BoardSwapTapped, {
        boardId: boardPresenceBoardId ?? undefined,
        surface: 'player_side_panel',
      });
      router.push({ pathname: '/boards', params: { returnTo: '/play' } });
    }, [boardPresenceBoardId]);

    const segmentOptions = useMemo<SegmentOption<PlayerSidePanelSegment>[]>(
      () => [
        { key: 'upNext', label: t('playView.sidePanel.upNext') },
        { key: 'logbook', label: t('playView.sidePanel.logbook') },
        { key: 'beta', label: t('playView.sidePanel.beta') },
      ],
      [t],
    );

    const showsUpNext = segment === 'upNext';
    return (
      <View
        testID="player-side-panel"
        style={[styles.panel, { borderLeftColor: systemColors.separator, paddingTop: insets.top + spacing[2] }]}
      >
        <View style={styles.segments}>
          <SegmentedControl
            options={segmentOptions}
            selectedKey={segment}
            onSelect={setSegment}
            accessibilityLabel={t('playView.sidePanel.segmentsAria')}
          />
        </View>
        <View style={showsUpNext ? styles.content : styles.hidden}>
          {queueBoard ? (
            <PanelQueue
              board={queueBoard}
              active={showsUpNext}
              onClimbPress={onClimbPress}
              onOpenActions={onOpenActions}
              onSuggestionPress={onSuggestionPress}
              onTickHistory={onTickHistory}
            />
          ) : (
            // No board yet, so no rows to draw: the queue's own empty state.
            <View style={styles.empty}>
              <Text variant="body" color={systemColors.secondaryLabel}>
                {t('mobile.queueSheet.emptyQueue')}
              </Text>
            </View>
          )}
        </View>
        {!showsUpNext && displayed ? (
          <ScrollView
            style={styles.content}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {segment === 'logbook' ? (
              <LogbookSection
                climbUuid={displayed.climb.uuid}
                boardName={displayed.boardName as BoardName}
                layoutId={displayed.layoutId}
                angle={displayed.angle}
                userAscents={displayed.climb.userAscents}
                userAttempts={displayed.climb.userAttempts}
                onOpenFullLogbook={displayed.onOpenFullLogbook}
              />
            ) : (
              <BetaVideosSection climbUuid={displayed.climb.uuid} boardName={displayed.boardName} />
            )}
          </ScrollView>
        ) : null}
        {!showsUpNext && !displayed ? <View style={styles.content} /> : null}
        <SwitchBoardFooter
          boardLabel={boardLabel}
          onPress={handleSwitchBoard}
          bottomPadding={insets.bottom + spacing[3]}
        />
      </View>
    );
  }),
);

/**
 * Up next, live: the panel reads the queue as it changes instead of the sheet's
 * frozen snapshot. `active` is false behind another segment, which pauses the
 * suggestion feed and the scroll to the current climb.
 */
function PanelQueue({
  board,
  active,
  onClimbPress,
  onOpenActions,
  onSuggestionPress,
  onTickHistory,
}: QueueRowHandlers & { board: QueueItemRowBoard; active: boolean }) {
  const { queue, currentClimbQueueItem, historyCount } = useQueueData();
  return (
    <QueueListBody
      board={board}
      queue={queue}
      currentClimbQueueItem={currentClimbQueueItem}
      historyCount={historyCount}
      active={active}
      presentation="panel"
      onClimbPress={onClimbPress}
      onOpenActions={onOpenActions}
      onSuggestionPress={onSuggestionPress}
      onTickHistory={onTickHistory}
    />
  );
}

const styles = StyleSheet.create({
  panel: {
    width: PLAYER_SIDE_PANEL_WIDTH,
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  segments: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  // Bounds the queue's bulk bar and Undo, which sit at the bottom of this area.
  content: {
    flex: 1,
  },
  // Up next behind another segment: kept mounted, out of layout and of reach.
  hidden: {
    display: 'none',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[16],
  },
  scrollContent: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
});
