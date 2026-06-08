import { memo } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import type { Climb } from '@boardsesh/queue';
import { PlaylistScrollSection } from '../playlist';
import { ClimbCoverCard } from './ClimbCoverCard';

/** Board scoping passed to each cover card so its thumbnail renders correctly. */
export type HomeRowBoard = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

export type HomeClimbRowProps = {
  title: string;
  climbs: Climb[];
  board: HomeRowBoard;
  onPressClimb: (climb: Climb) => void;
  loading?: boolean;
  onEndReached?: () => void;
  isLoadingMore?: boolean;
};

/**
 * Presentational horizontal row of `ClimbCoverCard`s under a section title.
 * Renders nothing once a row has resolved to zero climbs, so empty curated /
 * recommendation rows disappear instead of leaving a bare header.
 */
export const HomeClimbRow = memo(function HomeClimbRow({
  title,
  climbs,
  board,
  onPressClimb,
  loading,
  onEndReached,
  isLoadingMore,
}: HomeClimbRowProps) {
  if (!loading && climbs.length === 0) return null;

  return (
    <PlaylistScrollSection
      title={title}
      loading={loading && climbs.length === 0}
      isLoadingMore={isLoadingMore}
      onEndReached={onEndReached}
    >
      {climbs.map((climb) => (
        <ClimbCoverCard
          key={climb.uuid}
          climb={climb}
          boardName={board.boardName}
          layoutId={board.layoutId}
          sizeId={board.sizeId}
          setIds={board.setIds}
          onPress={() => onPressClimb(climb)}
        />
      ))}
    </PlaylistScrollSection>
  );
});
