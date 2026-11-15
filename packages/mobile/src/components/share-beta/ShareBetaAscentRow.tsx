import { memo } from 'react';
import { useBoardseshGradesActive } from '../../hooks/use-display-grade';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { renderBoardToPlaylistConfig } from '../../lib/playlists/board-details-for-playlist';
import { ClimbListThumbnail } from '../ClimbListThumbnail';
import { ShareBetaAscentRowView, type ShareBetaAscentRowViewProps } from './ShareBetaAscentRowView';
export const ShareBetaAscentRow = memo(function ShareBetaAscentRow(
  props: Omit<
    ShareBetaAscentRowViewProps,
    'thumbnail' | 'relativeTime' | 'boardseshActive' | 'formatGrade' | 'formatGradeByDifficultyId'
  >,
) {
  const { ascent } = props;
  const { formatGrade, formatGradeByDifficultyId } = useGradeFormat();
  const boardseshActive = useBoardseshGradesActive();
  const config = ascent.frames
    ? renderBoardToPlaylistConfig(ascent.boardType, ascent.layoutId, ascent.renderBoard)
    : null;
  return (
    <ShareBetaAscentRowView
      {...props}
      boardseshActive={boardseshActive}
      formatGrade={formatGrade}
      formatGradeByDifficultyId={formatGradeByDifficultyId}
      relativeTime={formatRelativeTime(ascent.climbedAt)}
      thumbnail={
        config && ascent.frames ? (
          <ClimbListThumbnail
            frames={ascent.frames}
            boardName={config.boardName}
            layoutId={config.layoutId}
            sizeId={config.sizeId}
            setIds={config.setIds.join(',')}
            mirrored={ascent.isMirror}
            size={{ width: 60, height: 76 }}
          />
        ) : undefined
      }
    />
  );
});
