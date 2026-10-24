// Tick lists (a logbook, a session's ticks, Record's in-session history, a
// session card's hardest send) play from their own list (issue #6665). A tick
// carries its own board and angle, which is what the tapped climb is drawn on.

import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { openClimbInPlayDrawer } from '../open-climb-in-play-drawer';
import { tickToClimb, type TickLike } from '../tick-to-climb';
import { renderBoardToPlaylistConfig } from './board-details-for-playlist';
import {
  useBoardListActivation,
  type BoardListOpen,
  type BoardListRow,
  type UseBoardListActivationOptions,
} from './use-board-list-activation';

// Rows keep their identity across pages, so each is read once.
const describedTicks = new WeakMap<TickLike, BoardListRow>();

/** The climb a tick plays, drawn on the board and at the angle it was climbed at. */
export function describeTickRow(tick: TickLike): BoardListRow {
  const described = describedTicks.get(tick);
  if (described) return described;
  const config = renderBoardToPlaylistConfig(tick.boardType, tick.layoutId, tick.renderBoard);
  const row: BoardListRow = {
    climb: tickToClimb(tick),
    board: config
      ? {
          boardName: config.boardName,
          layoutId: config.layoutId,
          sizeId: config.sizeId,
          setIds: config.setIds.join(','),
          angle: tick.angle,
        }
      : null,
  };
  describedTicks.set(tick, row);
  return row;
}

export type UseTickListActivationOptions<Tick extends TickLike> = Omit<
  UseBoardListActivationOptions<Tick>,
  'describeRow' | 'openFallback'
>;

/** A tap on a tick row: the climb opens, playing from this list of ticks. */
export function useTickListActivation<Tick extends TickLike>(
  options: UseTickListActivationOptions<Tick>,
): BoardListOpen<Tick> {
  const { openPlayDrawer } = useDrawerHost();
  const router = useRouter();
  // A tick with no frames, or on a board we can't name, opens through the
  // climb route, which loads the climb by uuid, as it always has.
  const openFallback = useCallback(
    (tick: Tick, { preview }: { preview: boolean }) =>
      openClimbInPlayDrawer({ kind: 'tick', tick }, { openPlayDrawer, router }, { preview }),
    [openPlayDrawer, router],
  );
  return useBoardListActivation<Tick>({ ...options, describeRow: describeTickRow, openFallback });
}
