import type { SessionDetailTick, SessionFeedParticipant } from '@boardsesh/shared-schema';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useBoardseshGradesActive } from '../../hooks/use-display-grade';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { clampDifficultyId, getBoulderGradeById, resolveCrowdDifficultyId } from '../../lib/boardsesh-grade-display';
import { hapticSelection } from '../../lib/haptics';
import { renderBoardToPlaylistConfig } from '../../lib/playlists/board-details-for-playlist';
import { sessionTickToClimb } from '../../lib/session-tick-mapping';
import { tickToClimb } from '../../lib/tick-to-climb';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { ClimbActionsPressable } from '../climb-actions/ClimbActionsPressable';
import { ClimbListItemContent } from '../ClimbListItemContent';
import { PressableAvatar } from '../PressableAvatar';
import { gradeBadgeColor } from '../you/profile-chart-colors';
import { SessionTickRowView, formatAttemptText } from './SessionTickRowView';

type SessionTickRowProps = {
  tick: SessionDetailTick;
  isMultiUser: boolean;
  /** Participant who logged the tick, for the leading avatar in multi-user sessions. */
  participant?: SessionFeedParticipant;
  onPress: (tick: SessionDetailTick) => void;
};

export const SessionTickRow = memo(function SessionTickRow({
  tick,
  isMultiUser,
  participant,
  onPress,
}: SessionTickRowProps) {
  const { t } = useTranslation(['session', 'climbs']);
  const { formatGrade, formatGradeByDifficultyId } = useGradeFormat();
  const boardseshActive = useBoardseshGradesActive();
  const { getClimbActions } = useDrawerHost();

  const attemptText = formatAttemptText(tick, t);
  // The setter moves out of the climb's primary subtitle into the detail line,
  // explicitly labelled, so it's never misread as the person who sent the climb.
  const setterText = tick.setterUsername ? t('detail.setBy', { username: tick.setterUsername }) : null;
  const detailParts = [attemptText, tick.comment ?? null, setterText].filter((part): part is string => !!part);
  const handlePress = useCallback(() => {
    hapticSelection();
    onPress(tick);
  }, [onPress, tick]);

  const menuTarget = useMemo(() => {
    const menuClimb = tickToClimb(tick);
    const config = renderBoardToPlaylistConfig(tick.boardType, tick.layoutId, tick.renderBoard);
    return menuClimb && config
      ? getClimbActions(menuClimb, {
          boardName: config.boardName,
          layoutId: config.layoutId,
          sizeId: config.sizeId,
          setIds: config.setIds.join(','),
          angle: tick.angle,
        })
      : null;
  }, [tick, getClimbActions]);

  const climb = sessionTickToClimb(tick);
  // The layout-default fallback memoises internally (static board metadata), so
  // this per-row call is O(1) after the first lookup for the board.
  const boardConfig = renderBoardToPlaylistConfig(tick.boardType, tick.layoutId, tick.renderBoard);

  // The logger's OWN grade (`tick.difficulty`) wins; only an ungraded tick falls
  // back to the crowd grade — the Boardsesh grade when the app-wide toggle is on
  // and it's trusted, otherwise nothing (session ticks carry no consensus grade).
  const crowdDifficulty = tick.difficulty == null ? resolveCrowdDifficultyId(tick, boardseshActive) : null;
  const effectiveDifficulty = tick.difficulty ?? crowdDifficulty;
  const gradeLabel =
    formatGradeByDifficultyId(effectiveDifficulty, tick.boardType) ??
    formatGrade(tick.difficultyName, tick.boardType) ??
    tick.difficultyName;
  const gradeColorName =
    tick.difficultyName ??
    (crowdDifficulty != null
      ? (getBoulderGradeById(clampDifficultyId(crowdDifficulty), tick.boardType)?.difficulty_name ?? null)
      : null);
  const gradeColor = gradeLabel ? gradeBadgeColor(gradeColorName ?? gradeLabel) : undefined;

  return (
    <SessionTickRowView
      tick={tick}
      isMultiUser={isMultiUser}
      participant={participant}
      onPress={handlePress}
      gradeLabel={gradeLabel}
      gradeColor={gradeColor}
      avatar={
        <PressableAvatar
          userId={participant?.userId}
          uri={participant?.avatarUrl}
          name={participant?.displayName}
          size={28}
        />
      }
      wrapClimbRow={(children, accessibilityLabel, style) => (
        <ClimbActionsPressable
          target={menuTarget}
          onPress={handlePress}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          style={style}
        >
          {children}
        </ClimbActionsPressable>
      )}
      climbContent={
        climb && boardConfig ? (
          <ClimbListItemContent
            climb={climb}
            boardName={boardConfig.boardName}
            layoutId={boardConfig.layoutId}
            sizeId={boardConfig.sizeId}
            setIds={boardConfig.setIds.join(',')}
            angle={tick.angle}
            subtitleDetailParts={detailParts}
            showAscentStatus={false}
            primarySubtitleOverride={isMultiUser ? (participant?.displayName ?? null) : null}
          />
        ) : undefined
      }
    />
  );
});
