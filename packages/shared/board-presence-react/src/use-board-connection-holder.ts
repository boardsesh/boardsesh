import { useEffect, useRef, useState } from 'react';
import type { BoardConnectionHolder } from '@boardsesh/shared-schema';
import type { BoardPresenceClient } from './types';
import { isBoardReadDenied } from './use-board-presence';

export type BoardConnectionHolderClient = Pick<
  BoardPresenceClient,
  'subscribeNowPlaying' | 'fetchConnection' | 'onReconnect'
>;

export type BoardConnectionHolderOptions = {
  boardId: number | null;
  boardUuid?: string | null;
  client: BoardConnectionHolderClient | null;
  enabled?: boolean;
  /** Platform lifecycle signals that invalidate ownership before reconnect. */
  subscribeInvalidation?: (invalidate: () => void) => () => void;
};

export type BoardConnectionHolderState = {
  holder: BoardConnectionHolder | null;
  /** A successful snapshot or newer holder event confirmed this reader cycle. */
  confirmed: boolean;
};

type ReaderScope = Required<Omit<BoardConnectionHolderOptions, 'subscribeInvalidation'>> &
  Pick<BoardConnectionHolderOptions, 'subscribeInvalidation'>;
type HolderSnapshot = BoardConnectionHolderState & { scope: ReaderScope | null };
const UNCONFIRMED: BoardConnectionHolderState = { holder: null, confirmed: false };

/**
 * Live connection ownership for one board, without fetching its history/stats.
 * Cached ownership never authorizes a connection decision after suspension,
 * transport loss or retry. Reads are scoped to their lifecycle and holder-event
 * sequence, so neither a late snapshot nor a late error can undo a newer event.
 */
export function useBoardConnectionHolder({
  boardId,
  boardUuid = null,
  client,
  enabled = true,
  subscribeInvalidation,
}: BoardConnectionHolderOptions): BoardConnectionHolderState {
  const scopeRef = useRef<ReaderScope>({ boardId, boardUuid, client, enabled, subscribeInvalidation });
  if (
    scopeRef.current.boardId !== boardId ||
    scopeRef.current.boardUuid !== boardUuid ||
    scopeRef.current.client !== client ||
    scopeRef.current.enabled !== enabled ||
    scopeRef.current.subscribeInvalidation !== subscribeInvalidation
  ) {
    scopeRef.current = { boardId, boardUuid, client, enabled, subscribeInvalidation };
  }
  const scope = scopeRef.current;
  const [snapshot, setSnapshot] = useState<HolderSnapshot>({ scope: null, ...UNCONFIRMED });

  useEffect(() => {
    if (!enabled || boardId === null || client === null) return;
    let active = true;
    let retired = false;
    let generation = 0;
    let highestHolderSeq = -1;
    let holderSnapshotFloor = -1;
    let pendingGapFloor: number | null = null;
    let highestObservedSeq: number | null = null;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribeStream: (() => void) | null = null;
    let unsubscribeInvalidation: (() => void) | null = null;
    let unsubscribeReconnect: (() => void) | null = null;
    const isCurrent = () => active && !retired && scopeRef.current === scope;
    const isCurrentCycle = (cycle: number) => isCurrent() && generation === cycle;
    const clearRetry = () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    };
    const disposeStream = () => {
      const release = unsubscribeStream;
      unsubscribeStream = null;
      release?.();
    };
    const disposeLifecycle = () => {
      const releaseInvalidation = unsubscribeInvalidation;
      const releaseReconnect = unsubscribeReconnect;
      unsubscribeInvalidation = null;
      unsubscribeReconnect = null;
      releaseInvalidation?.();
      releaseReconnect?.();
    };
    const invalidate = () => {
      generation += 1;
      setSnapshot({ scope, ...UNCONFIRMED });
      // Invalidate callbacks before releasing: unsubscribe can call complete.
      disposeStream();
    };
    const scheduleRetry = () => {
      if (!isCurrent() || retryTimer !== null) return;
      const delay = Math.min(1_000 * 2 ** Math.min(retryAttempt, 5), 30_000);
      retryAttempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        startReader();
      }, delay);
    };
    const failCycle = (cycle: number, retry: boolean) => {
      if (!isCurrentCycle(cycle)) return;
      if (!retry) retired = true;
      invalidate();
      if (retry) scheduleRetry();
      else {
        clearRetry();
        disposeLifecycle();
      }
    };
    const startReader = () => {
      if (!isCurrent()) return;
      clearRetry();
      invalidate();
      const cycle = generation;
      const holderSeqAtCycleStart = highestHolderSeq;
      const capabilityArgs: [string] | [] = boardUuid ? [boardUuid] : [];
      let readInFlight = false;
      let readRequested = false;
      let readGeneration = 0;
      const readHolder = () => {
        if (!isCurrentCycle(cycle) || !client.fetchConnection) return;
        if (readInFlight) {
          readRequested = true;
          return;
        }
        readInFlight = true;
        readRequested = false;
        const holderSeqAtStart = highestHolderSeq;
        const observedSeqAtStart = highestObservedSeq;
        const readGenerationAtStart = readGeneration;
        const readStillCurrent = () =>
          isCurrentCycle(cycle) && highestHolderSeq === holderSeqAtStart && readGeneration === readGenerationAtStart;
        const finishRead = () => {
          if (!isCurrentCycle(cycle)) return;
          readInFlight = false;
          if (readRequested) readHolder();
        };
        try {
          void client
            .fetchConnection(boardId, ...capabilityArgs)
            .then(
              (holder) => {
                if (!readStillCurrent()) return;
                retryAttempt = 0;
                // Only general events observed BEFORE this query establish its
                // floor. Events arriving during it never version its answer.
                holderSnapshotFloor = Math.max(holderSnapshotFloor, observedSeqAtStart ?? -1);
                pendingGapFloor = null;
                setSnapshot({ scope, holder, confirmed: true });
              },
              (error: unknown) => {
                // A newer live holder/release supersedes errors as well as results.
                if (readStillCurrent()) failCycle(cycle, !isBoardReadDenied(error));
              },
            )
            .finally(finishRead);
        } catch (error) {
          if (readStillCurrent()) failCycle(cycle, !isBoardReadDenied(error));
          finishRead();
        }
      };
      try {
        const release = client.subscribeNowPlaying(
          boardId,
          (event) => {
            if (!isCurrentCycle(cycle)) return;
            const eventSeq = event.__typename === 'BoardClimbSet' ? event.climb.seq : event.seq;
            const gap = highestObservedSeq !== null && eventSeq > highestObservedSeq + 1;
            highestObservedSeq = Math.max(highestObservedSeq ?? eventSeq, eventSeq);
            if (event.__typename === 'BoardConnectionChanged') {
              if (
                event.seq <= Math.max(highestHolderSeq, holderSnapshotFloor) ||
                (pendingGapFloor !== null && event.seq < pendingGapFloor)
              )
                return;
              highestHolderSeq = event.seq;
              pendingGapFloor = null;
              readRequested = false;
              retryAttempt = 0;
              clearRetry();
              setSnapshot({ scope, holder: event.holder, confirmed: true });
            } else if (gap) {
              // A missing event could have released the holder. Fold bursts
              // into one in-flight read and one follow-up at most; snapshot
              // ordering still uses the watermark from before its own query.
              pendingGapFloor = Math.max(pendingGapFloor ?? eventSeq, eventSeq);
              readGeneration += 1;
              setSnapshot({ scope, ...UNCONFIRMED });
              readHolder();
            }
          },
          (error) => failCycle(cycle, !isBoardReadDenied(error)),
          () => failCycle(cycle, false),
          ...capabilityArgs,
        );
        // A transport may throw, fail or complete synchronously while attaching.
        if (!isCurrentCycle(cycle)) {
          release();
          return;
        }
        unsubscribeStream = release;
      } catch (error) {
        failCycle(cycle, !isBoardReadDenied(error));
        return;
      }
      if (!readInFlight && highestHolderSeq === holderSeqAtCycleStart) readHolder();
    };
    const releaseInvalidation = subscribeInvalidation?.(() => {
      if (!isCurrent()) return;
      invalidate();
      scheduleRetry();
    });
    if (isCurrent()) unsubscribeInvalidation = releaseInvalidation ?? null;
    else releaseInvalidation?.();
    const releaseReconnect = client.onReconnect?.(() => startReader());
    if (isCurrent()) unsubscribeReconnect = releaseReconnect ?? null;
    else releaseReconnect?.();
    startReader();
    return () => {
      active = false;
      generation += 1;
      clearRetry();
      disposeStream();
      disposeLifecycle();
    };
  }, [boardId, boardUuid, client, enabled, scope, subscribeInvalidation]);

  return enabled && snapshot.scope === scope ? snapshot : UNCONFIRMED;
}
