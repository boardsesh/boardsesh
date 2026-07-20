import { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { BoardRouteHandoff } from '../../../../../../src/components/BoardRouteRedirect';
import { buildBoardListTarget } from '../../../../../../src/lib/routing/board-route-target';

type BoardListRouteParams = {
  board_name?: string;
  layout_id?: string;
  size_id?: string;
  set_ids?: string;
  angle?: string;
};

/**
 * `/kilter/original/12x12-square/screw_bolt/40/list` — the canonical climb-list
 * URL, shared with the Next app. Adopts the URL's board and lands on the Climbs
 * tab, which is where the list actually lives.
 */
export default function BoardListRoute() {
  const { board_name, layout_id, size_id, set_ids, angle } = useLocalSearchParams<BoardListRouteParams>();

  const target = useMemo(
    () =>
      buildBoardListTarget({
        boardName: board_name,
        layoutId: layout_id,
        sizeId: size_id,
        setIds: set_ids,
        angle,
      }),
    [board_name, layout_id, size_id, set_ids, angle],
  );

  return <BoardRouteHandoff target={target} />;
}
