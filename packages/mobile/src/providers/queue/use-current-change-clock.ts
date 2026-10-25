import { useCallback, useState, type Dispatch } from 'react';
import type { QueueAction } from '@boardsesh/queue';
import { nowMs } from '../../lib/clock';
import { parseClockInstant, type CurrentChangeClock } from '../../lib/ble/stale-current-hold';

export type CurrentChangeClockControls = {
  /** The clock as of this render, always stamped for the current queue-item uuid. */
  clock: CurrentChangeClock;
  /**
   * Set the clock from a source that knows better than "now": a restored
   * snapshot's `lastCurrentChangeAt`, or "now" itself when the climber opens
   * the current climb again (the queue provider's `setCurrentClimb`). Call it in the same tick as the dispatch
   * that makes `queueItemUuid` current, so the render that commits the climb
   * also commits its seeded clock.
   */
  seedCurrentChange: (queueItemUuid: string | null, changedAt: number) => void;
  /**
   * The reducer's dispatch, reseeding the clock from every FullSync on the way
   * through (the older time wins for the same uuid). Stable, like the reducer's own.
   */
  dispatch: Dispatch<QueueAction>;
};

/**
 * The #4979 hold's clock (docs/current-climb-outside-queue.md, section 6): when
 * the current climb last became a different climb.
 *
 * It advances only when the current queue-item uuid differs from the one the
 * clock was stamped for. That covers exactly the actions the design lists (a
 * local or server `DELTA_UPDATE_CURRENT_CLIMB` to another uuid, a removal of the
 * current climb, a `SET_QUEUE` or `CLEAR_QUEUE` that changes it) and none of the
 * ones it excludes: adds, reorders, removals of other entries, mirror flips,
 * `replaceQueueItem`, hydrates and regrades all keep the uuid.
 *
 * Every FullSync reseeds it from the room's `currentChangedAt`: the subscribe
 * FullSync on every (re)connect, the watchdog and sequence-gap resyncs and the
 * HTTP snapshot all reach the reducer as `INITIAL_QUEUE_DATA`. Seeding from the
 * arrival time instead would let the Wi-Fi change on the walk to the wall
 * release a three-day-old hold. For another uuid the room's time wins. For the
 * uuid the clock already holds, the OLDER of the two wins: both times are
 * "this climb was current by then", and the room's can only be younger through
 * a stamp that is not a change (the seed of a room this phone just started
 * from its solo queue, a settle, a Postgres `updated_at` fallback). Taking the
 * younger one would light a held climb on Start session. The one case it reads
 * wrong is a crewmate going away from the climb and back while this phone was
 * offline; that holds a climb they just picked, which costs one Put on the wall.
 * Without the field (legacy documents) the clock keeps its own rule: the same
 * uuid keeps its time, another uuid is "now".
 *
 * The advance happens during render (React's "adjust state while rendering"
 * pattern), not in an effect, so the committed render never pairs a new current
 * climb with the previous climb's clock. The auto-sender, a descendant, runs its
 * effects before its provider's would, so an effect here would always be late.
 */
export function useCurrentChangeClock(
  currentQueueItemUuid: string | null,
  reducerDispatch: Dispatch<QueueAction>,
): CurrentChangeClockControls {
  const [clock, setClock] = useState<CurrentChangeClock>(() => ({
    queueItemUuid: currentQueueItemUuid,
    changedAt: nowMs(),
  }));
  let effectiveClock = clock;
  if (clock.queueItemUuid !== currentQueueItemUuid) {
    effectiveClock = { queueItemUuid: currentQueueItemUuid, changedAt: nowMs() };
    setClock(effectiveClock);
  }
  const seedCurrentChange = useCallback((queueItemUuid: string | null, changedAt: number) => {
    setClock((previous) =>
      previous.queueItemUuid === queueItemUuid && previous.changedAt === changedAt
        ? previous
        : { queueItemUuid, changedAt },
    );
  }, []);
  const dispatch = useCallback<Dispatch<QueueAction>>(
    (action) => {
      if (action.type === 'INITIAL_QUEUE_DATA' && 'currentClimbQueueItem' in action.payload) {
        const serverChangedAt = parseClockInstant(action.payload.currentChangedAt);
        if (serverChangedAt !== null) {
          const serverQueueItemUuid = action.payload.currentClimbQueueItem?.uuid ?? null;
          setClock((previous) => {
            const changedAt =
              previous.queueItemUuid === serverQueueItemUuid
                ? Math.min(previous.changedAt, serverChangedAt)
                : serverChangedAt;
            return previous.queueItemUuid === serverQueueItemUuid && previous.changedAt === changedAt
              ? previous
              : { queueItemUuid: serverQueueItemUuid, changedAt };
          });
        }
      }
      reducerDispatch(action);
    },
    [reducerDispatch],
  );
  return { clock: effectiveClock, seedCurrentChange, dispatch };
}
