import { memo, useEffect, useMemo, type ReactNode } from 'react';
import type { SharedValue } from 'react-native-reanimated';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { useLogbook, useOptionalBoardActions, type LogbookEntry } from '@boardsesh/board-react';
import type { DisplayGrade } from '../../lib/boardsesh-grade-display';
import { normalizeAscentStatus, pickHighestAscentStatus, type AscentStatusValue } from '../../lib/ascent-status-utils';
import { PlayDrawerHeader } from './PlayDrawerHeader';
import { SwipeableHeader } from './SwipeableHeader';

type PlayDrawerSwipeableHeaderProps = {
  boardName: BoardName;
  angle: number;
  swipeTranslateX: SharedValue<number>;
  viewportWidth: number;
  currentClimb: Climb;
  currentGrade: DisplayGrade | null;
  currentLeading?: ReactNode;
  onLongPressCurrentName: () => void;
  peekClimb: Climb | null;
  peekGrade: DisplayGrade | null;
};

type HeaderContentsProps = PlayDrawerSwipeableHeaderProps & {
  currentAscentStatus?: AscentStatusValue | null;
  peekAscentStatus?: AscentStatusValue | null;
};

function HeaderContents({
  angle,
  swipeTranslateX,
  viewportWidth,
  currentClimb,
  currentGrade,
  currentLeading,
  onLongPressCurrentName,
  peekClimb,
  peekGrade,
  currentAscentStatus,
  peekAscentStatus,
}: HeaderContentsProps) {
  return (
    <SwipeableHeader
      swipeTranslateX={swipeTranslateX}
      viewportWidth={viewportWidth}
      current={
        <PlayDrawerHeader
          climbUuid={currentClimb.uuid}
          angle={angle}
          ascentStatus={currentAscentStatus}
          name={currentClimb.name}
          difficulty={currentGrade?.label ?? currentClimb.difficulty}
          rawDifficulty={currentClimb.difficulty}
          gradeColor={currentGrade?.color}
          qualityAverage={currentClimb.quality_average}
          ascensionistCount={currentClimb.ascensionist_count}
          setterUsername={currentClimb.setter_username}
          benchmarkDifficulty={currentClimb.benchmark_difficulty}
          characteristics={currentClimb.characteristics}
          leading={currentLeading}
          onLongPressName={onLongPressCurrentName}
        />
      }
      peek={
        peekClimb ? (
          <PlayDrawerHeader
            climbUuid={peekClimb.uuid}
            angle={angle}
            ascentStatus={peekAscentStatus}
            name={peekClimb.name}
            difficulty={peekGrade?.label ?? peekClimb.difficulty}
            rawDifficulty={peekClimb.difficulty}
            gradeColor={peekGrade?.color}
            qualityAverage={peekClimb.quality_average}
            ascensionistCount={peekClimb.ascensionist_count}
            setterUsername={peekClimb.setter_username}
            benchmarkDifficulty={peekClimb.benchmark_difficulty}
            characteristics={peekClimb.characteristics}
          />
        ) : null
      }
    />
  );
}

function peekOnlyUuids(currentClimbUuid: string, peekClimbUuid: string | null): string[] {
  return peekClimbUuid && peekClimbUuid !== currentClimbUuid ? [peekClimbUuid] : [];
}

/**
 * Normal path: the drawer board matches the app-root BoardProvider. Its indexed
 * logbook remains the glyph source. This hook requests only the incoming peek;
 * DeferredSections already owns the displayed/current climb request.
 */
function RootBoardHeader({
  getLogbook,
  ...props
}: PlayDrawerSwipeableHeaderProps & { getLogbook: (climbUuids: string[]) => Promise<void> }) {
  const peekClimbUuid = props.peekClimb?.uuid ?? null;
  const requestedPeekUuids = useMemo(
    () => peekOnlyUuids(props.currentClimb.uuid, peekClimbUuid),
    [props.currentClimb.uuid, peekClimbUuid],
  );
  useEffect(() => {
    if (requestedPeekUuids.length > 0) void getLogbook(requestedPeekUuids);
  }, [getLogbook, requestedPeekUuids]);
  return <HeaderContents {...props} />;
}

function buildForeignStatusIndex(
  logbook: readonly LogbookEntry[],
  currentClimbUuid: string,
  peekClimbUuid: string | null,
  angle: number,
): Map<string, AscentStatusValue> {
  const targetClimbUuids = new Set(peekClimbUuid ? [currentClimbUuid, peekClimbUuid] : [currentClimbUuid]);
  const statusIndex = new Map<string, AscentStatusValue>();
  for (const entry of logbook) {
    if (entry.angle !== angle || !targetClimbUuids.has(entry.climb_uuid)) continue;
    const nextStatus = normalizeAscentStatus({
      status: entry.status,
      isAscent: entry.is_ascent,
      tries: entry.tries,
    });
    const existingStatus = statusIndex.get(entry.climb_uuid);
    statusIndex.set(
      entry.climb_uuid,
      existingStatus ? (pickHighestAscentStatus([existingStatus, nextStatus]) ?? nextStatus) : nextStatus,
    );
  }
  return statusIndex;
}

/**
 * Foreign/profile override path: subscribe read-only to that board's accumulated
 * logbook cache and build a tiny current+peek index once per cache/angle change.
 * It requests only the peek; DeferredSections' current request merges into the
 * same board-keyed accumulated cache, avoiding overlapping network work.
 */
function ForeignBoardHeader(props: PlayDrawerSwipeableHeaderProps) {
  const peekClimbUuid = props.peekClimb?.uuid ?? null;
  const requestedPeekUuids = useMemo(
    () => peekOnlyUuids(props.currentClimb.uuid, peekClimbUuid),
    [props.currentClimb.uuid, peekClimbUuid],
  );
  const { logbook } = useLogbook(props.boardName, requestedPeekUuids);
  const statusIndex = useMemo(
    () => buildForeignStatusIndex(logbook, props.currentClimb.uuid, peekClimbUuid, props.angle),
    [logbook, props.currentClimb.uuid, peekClimbUuid, props.angle],
  );
  return (
    <HeaderContents
      {...props}
      currentAscentStatus={statusIndex.get(props.currentClimb.uuid) ?? null}
      peekAscentStatus={peekClimbUuid ? (statusIndex.get(peekClimbUuid) ?? null) : null}
    />
  );
}

/**
 * Swipeable play-drawer title strip. Normal active-board opens reuse the root
 * provider/index; foreign-board previews take the lightweight read-only path.
 */
export const PlayDrawerSwipeableHeader = memo(function PlayDrawerSwipeableHeader(
  props: PlayDrawerSwipeableHeaderProps,
) {
  const rootBoard = useOptionalBoardActions();
  return rootBoard?.boardName === props.boardName ? (
    <RootBoardHeader {...props} getLogbook={rootBoard.getLogbook} />
  ) : (
    <ForeignBoardHeader {...props} />
  );
});
