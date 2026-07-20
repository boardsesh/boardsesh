import { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { BoardRouteHandoff } from '../../../../../../../src/components/BoardRouteRedirect';
import { buildBoardClimbTarget } from '../../../../../../../src/lib/routing/board-route-target';

type BoardClimbRouteParams = {
  board_name?: string;
  layout_id?: string;
  size_id?: string;
  set_ids?: string;
  angle?: string;
  climb_segment?: string;
};

/**
 * `/kilter/original/12x12-square/screw_bolt/40/play/<uuid>` — the same
 * destination as `/view/…`; the play drawer is what opens either way. Kept as
 * its own route so a link shared from the web app's play view still resolves.
 */
export default function BoardClimbPlayRoute() {
  const { board_name, layout_id, size_id, set_ids, angle, climb_segment } =
    useLocalSearchParams<BoardClimbRouteParams>();

  const target = useMemo(
    () =>
      buildBoardClimbTarget(
        { boardName: board_name, layoutId: layout_id, sizeId: size_id, setIds: set_ids, angle },
        'play',
        climb_segment,
      ),
    [board_name, layout_id, size_id, set_ids, angle, climb_segment],
  );

  return <BoardRouteHandoff target={target} />;
}
