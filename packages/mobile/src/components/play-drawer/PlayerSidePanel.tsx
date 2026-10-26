import { memo, useMemo, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { SegmentedControl } from '../SegmentedControl';
import type { SegmentOption } from '../SegmentedControl.types';
import type { QueueItemRowBoard } from '../QueueItemRow';
import { SwitchBoardFooter } from '../board-presence/SwitchBoardFooter';
import { QueueListBody } from './QueueListBody';
import { LogbookSection } from './LogbookSection';
import { BetaVideosSection } from './BetaVideosSection';
import { PLAYER_SIDE_PANEL_WIDTH } from './play-drawer-layout';
import type { PlayerSidePanelClimb } from './play-drawer-types';
import { useQueueData } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { formatActiveBoardLabel } from '../../lib/boards/active-board-label';
import { spacing } from '../../theme/tokens';

export type PlayerSidePanelSegment = 'upNext' | 'logbook' | 'beta';

type QueueRowHandlers = {
  onClimbPress: (item: ClimbQueueItem) => void;
  onOpenActions: (item: ClimbQueueItem) => void;
  onSuggestionPress: (climb: Climb, source: PlaylistSuggestionSource) => void;
  onTickHistory: (item: ClimbQueueItem) => void;
};

type PlayerSidePanelProps = QueueRowHandlers & {
  displayed: PlayerSidePanelClimb | null;
  segment: PlayerSidePanelSegment;
  onSegmentChange: (segment: PlayerSidePanelSegment) => void;
  /** The queue's rows render against the stored active board; null before one resolves. */
  queueBoard: QueueItemRowBoard | null;
  onSwitchBoard: () => void;
};

/**
 * The landscape iPad player's right-hand panel: Up next, Logbook and Beta behind
 * one segmented control, and Switch board at its foot (where Music keeps
 * AirPlay). Only the chosen segment is mounted, so the queue list and the beta
 * fetch run while they are on screen and not behind another segment.
 */
export const PlayerSidePanel = memo(function PlayerSidePanel({
  displayed,
  segment,
  onSegmentChange,
  queueBoard,
  onSwitchBoard,
  onClimbPress,
  onOpenActions,
  onSuggestionPress,
  onTickHistory,
}: PlayerSidePanelProps) {
  const { t } = useTranslation('session');
  const insets = useSafeAreaInsets();
  const { systemColors } = useTheme();
  const { data: activeBoard } = useActiveBoard();
  const boardLabel = useMemo(() => formatActiveBoardLabel(activeBoard), [activeBoard]);

  const segmentOptions = useMemo<SegmentOption<PlayerSidePanelSegment>[]>(
    () => [
      { key: 'upNext', label: t('playView.sidePanel.upNext') },
      { key: 'logbook', label: t('playView.sidePanel.logbook') },
      { key: 'beta', label: t('playView.sidePanel.beta') },
    ],
    [t],
  );

  let content: ReactNode = null;
  if (segment === 'upNext') {
    content = queueBoard ? (
      <PanelQueue
        board={queueBoard}
        onClimbPress={onClimbPress}
        onOpenActions={onOpenActions}
        onSuggestionPress={onSuggestionPress}
        onTickHistory={onTickHistory}
      />
    ) : null;
  } else if (displayed) {
    content = (
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
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
    );
  }

  return (
    <View
      testID="player-side-panel"
      style={[styles.panel, { borderLeftColor: systemColors.separator, paddingTop: insets.top + spacing[2] }]}
    >
      <View style={styles.segments}>
        <SegmentedControl
          options={segmentOptions}
          selectedKey={segment}
          onSelect={onSegmentChange}
          accessibilityLabel={t('playView.sidePanel.segmentsAria')}
        />
      </View>
      <View style={styles.content}>{content}</View>
      <SwitchBoardFooter boardLabel={boardLabel} onPress={onSwitchBoard} bottomPadding={insets.bottom + spacing[3]} />
    </View>
  );
});

/**
 * Up next, live: the panel is on screen whenever it is mounted, so it reads the
 * queue as it changes instead of the sheet's frozen snapshot.
 */
function PanelQueue({
  board,
  onClimbPress,
  onOpenActions,
  onSuggestionPress,
  onTickHistory,
}: QueueRowHandlers & { board: QueueItemRowBoard }) {
  const { queue, currentClimbQueueItem, historyCount } = useQueueData();
  return (
    <QueueListBody
      board={board}
      queue={queue}
      currentClimbQueueItem={currentClimbQueueItem}
      historyCount={historyCount}
      active
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
  scrollContent: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
});
