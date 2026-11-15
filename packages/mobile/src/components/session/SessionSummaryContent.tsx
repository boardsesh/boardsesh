import { useCallback, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { formatSessionWhen } from '../../lib/format-session-when';
import { renderBoardToPlaylistConfig } from '../../lib/playlists/board-details-for-playlist';
import { spacing } from '../../theme/tokens';
import { ClimbListThumbnail } from '../ClimbListThumbnail';
import { SaveToAppleHealthButton } from '../integrations/SaveToAppleHealthButton';
import { ShareToStravaButton } from '../integrations/ShareToStravaButton';
import { PostSessionOfflineNudge } from '../offline/PostSessionOfflineNudge';
import { AvatarGroup } from '../you/AvatarGroup';
import { GradeTile } from './session-stat-tiles';
import { SessionRecapCard } from './SessionRecapCard';
import { SessionSummaryView } from './SessionSummaryView';

type SessionSummaryContentProps = Pick<
  ComponentProps<typeof SessionSummaryView>,
  'summary' | 'workout' | 'pendingTicks' | 'offline' | 'initiallyExpandedStageId'
> & { storeReviewWillPrompt: boolean };

/** Production adapter for the recap's persistent and external actions. */
export function SessionSummaryContent({ summary, storeReviewWillPrompt, ...props }: SessionSummaryContentProps) {
  const { t } = useTranslation('session');
  const { formatGrade } = useGradeFormat();
  const hardest = summary.hardestClimb;
  const thumbConfig =
    hardest?.frames && hardest.boardType
      ? renderBoardToPlaylistConfig(hardest.boardType, hardest.layoutId, hardest.renderBoard)
      : null;
  const when = summary.endedAt ?? summary.startedAt ?? null;
  const renderRecap = useCallback(
    (onEditorFocus: () => void) => (
      <SessionRecapCard sessionId={summary.sessionId} notes={summary.notes} editable onEditorFocus={onEditorFocus} />
    ),
    [summary.sessionId, summary.notes],
  );
  return (
    <SessionSummaryView
      {...props}
      summary={summary}
      formatGrade={formatGrade}
      sessionWhen={when ? formatSessionWhen(when, t) : ''}
      avatars={<AvatarGroup participants={summary.participants} size={36} />}
      gradeTile={hardest ? <GradeTile grade={hardest.grade} boardName={hardest.boardType} /> : undefined}
      thumbnail={
        hardest && thumbConfig ? (
          <ClimbListThumbnail
            frames={hardest.frames ?? ''}
            boardName={thumbConfig.boardName}
            layoutId={thumbConfig.layoutId}
            sizeId={thumbConfig.sizeId}
            setIds={thumbConfig.setIds.join(',')}
            mirrored={hardest.isMirror ?? false}
            size={{ width: 64, height: 82 }}
          />
        ) : undefined
      }
      renderRecap={renderRecap}
      offlineNudge={
        <PostSessionOfflineNudge storeReviewWillPrompt={storeReviewWillPrompt} style={styles.offlineNudge} />
      }
      integrationActions={
        <>
          <SaveToAppleHealthButton summary={summary} />
          <ShareToStravaButton sessionId={summary.sessionId} />
        </>
      }
    />
  );
}
const styles = StyleSheet.create({ offlineNudge: { marginBottom: spacing[4] } });
