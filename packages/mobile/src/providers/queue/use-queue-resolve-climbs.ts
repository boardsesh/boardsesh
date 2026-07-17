import { useEffect, useRef } from 'react';
import type { ClimbQueueItem, QueueAction } from '@boardsesh/queue';
import type { UserBoard } from '@boardsesh/shared-schema';
import { offlineAwareRequest } from '../../lib/graphql/offline-request';
import { GET_CLIMB, type GetClimbQueryResponse } from '../../lib/graphql/operations';
import { climbToQueueItem, isClimbResolved } from '../../lib/climb-to-queue-item';

type UseQueueResolveClimbsParams = {
  /** The active board (climb-scope + angle source of truth). Undefined until the React Query cache hydrates. */
  activeBoard: UserBoard | null | undefined;
  queue: ClimbQueueItem[];
  dispatch: React.Dispatch<QueueAction>;
};

/**
 * Self-healing climb resolution (#2527): a party peer can broadcast a queue item
 * whose climb arrived partially synced — missing name/frames/grade — or a local
 * snapshot can restore before the climb data hydrates. `ClimbQueueItem.climb` is
 * typed non-null, but the wire boundary is untyped, so such items slip into the
 * queue and render as an "Unknown Climb" placeholder. When the climb still
 * carries a fetchable uuid, re-fetch it (by uuid, at the live board angle) and
 * patch the resolved climb back into the item in place — the same shape as the
 * angle re-grade path (`useQueueRegrade`).
 *
 * Local only: each client resolves its own queue; nothing is sent to peers.
 * Fails gracefully offline — `offlineAwareRequest` returns `{ climb: null }`
 * (or the wrapped HTTP request throws), which is caught and skipped, leaving the
 * placeholder until data is available. Idempotent + loop-safe: a `DELTA_REPLACE`
 * only fires for a result that is itself resolved, so a null/still-thin response
 * never churns state and re-triggers the effect.
 *
 * We scan the queue only. `DELTA_REPLACE_QUEUE_ITEM` updates the current climb
 * when its uuid is in the queue (the common case); a bare current-climb-only item
 * can't be patched this way, but the current climb always arrives fully populated
 * over the wire (schema-enforced `Climb!`), so that edge doesn't occur in
 * practice.
 */
export function useQueueResolveClimbs({ activeBoard, queue, dispatch }: UseQueueResolveClimbsParams): void {
  // climb uuid -> the angle a resolve fetch is currently in flight for. Keyed by
  // angle (not a plain Set) so a fetch already running for a STALE angle doesn't
  // block a fresh fetch when the angle changes again mid-flight.
  const resolveInFlightRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!activeBoard) return undefined;
    const { boardType, layoutId, sizeId, setIds, angle } = activeBoard;

    // Unresolved queue items that still carry a fetchable climb uuid. A uuid-less
    // placeholder is genuinely unresolvable (no key to fetch by) — it stays a
    // transient "Unknown Climb" row and is skipped, never re-broadcast.
    const uuids = new Set<string>();
    for (const item of queue) {
      const climbUuid = item.climb?.uuid;
      if (!climbUuid || isClimbResolved(item.climb)) continue;
      if (resolveInFlightRef.current.get(climbUuid) === angle) continue;
      uuids.add(climbUuid);
    }
    if (uuids.size === 0) return undefined;

    const targetUuids = [...uuids];
    targetUuids.forEach((climbUuid) => resolveInFlightRef.current.set(climbUuid, angle));

    let cancelled = false;
    void (async () => {
      const resolved = await Promise.all(
        targetUuids.map(async (climbUuid) => {
          try {
            const response = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, {
              boardName: boardType,
              layoutId,
              sizeId,
              setIds,
              angle,
              climbUuid,
            });
            const climb = response.climb;
            // Only accept a result that is actually resolved — a null (offline /
            // not-yet-synced) or still-thin climb must NOT be dispatched, or the
            // replaced item would stay unresolved and re-trigger this effect.
            if (!isClimbResolved(climb)) return null;
            return [climbUuid, climb] as const;
          } catch {
            return null;
          } finally {
            // Only clear our own marker — a newer run may have re-targeted this
            // uuid to a different angle and must keep its in-flight claim. Clearing
            // it lets a still-thin item retry on the next queue/board churn.
            if (resolveInFlightRef.current.get(climbUuid) === angle) {
              resolveInFlightRef.current.delete(climbUuid);
            }
          }
        }),
      );
      if (cancelled) return;

      const byUuid = new Map(resolved.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
      if (byUuid.size === 0) return;

      // Patch every occurrence of a resolved climb back into its queue item(s),
      // preserving the queue-slot uuid and item metadata (addedBy / tickedBy).
      // The same climb can appear multiple times (e.g. re-added after a tick).
      for (const item of queue) {
        const climbUuid = item.climb?.uuid;
        if (!climbUuid) continue;
        const climb = byUuid.get(climbUuid);
        if (!climb) continue;
        const resolvedClimb = climbToQueueItem(climb, { uuid: item.uuid, suggested: item.suggested }).climb;
        dispatch({
          type: 'DELTA_REPLACE_QUEUE_ITEM',
          payload: { uuid: item.uuid, item: { ...item, climb: resolvedClimb } },
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [queue, activeBoard, dispatch]);
}
