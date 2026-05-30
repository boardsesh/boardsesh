// SET_CURRENT_CLIMB coalescer.
//
// Rapid swipes through the queue can fire setCurrentClimb mutations faster
// than the backend can process them. Stacking them up at the client is wasted
// work — only the latest target climb matters. This factory implements
// "serialize-and-supersede": at most one mutation in flight, the most recent
// pending args win, and any superseded `shouldAddToQueue:true` payload still
// gets its ADD_QUEUE_ITEM sent (so the queue mutation reaches the server even
// when the setCurrentClimb is dropped).
//
// Extracted from web's
// `packages/web/app/components/persistent-session/hooks/use-queue-mutations.ts`
// so mobile picks up the same semantics. Pure TS — no React, no GraphQL
// client coupling. Callers wire `sendArgs` / `sendSupersededQueueAdd` to
// their platform-specific transport.

import type { ClimbQueueItem } from '@boardsesh/queue';

export type SetCurrentClimbArgs = {
  item: ClimbQueueItem | null;
  shouldAddToQueue?: boolean;
  correlationId?: string;
};

export type SetCurrentClimbCoalescerOptions = {
  /** Send a single SET_CURRENT_CLIMB mutation with the given args. */
  sendArgs: (args: SetCurrentClimbArgs) => Promise<void>;
  /** Fire-and-forget ADD_QUEUE_ITEM for a superseded request whose
   *  shouldAddToQueue flag was true. If omitted, superseded queue-adds are
   *  silently dropped (matches the no-coalescing baseline mobile had before). */
  sendSupersededQueueAdd?: (item: ClimbQueueItem) => Promise<void>;
  /** Errors during the drain loop are swallowed — this is the sink. */
  onDrainError?: (error: unknown) => void;
  /** Sink for errors when the fire-and-forget superseded ADD_QUEUE_ITEM
   *  rejects. */
  onSupersededQueueAddError?: (error: unknown) => void;
};

export type SetCurrentClimbCoalescer = {
  /** Enqueue a setCurrentClimb call. The returned promise resolves once this
   *  request *and* all coalesced followups have been drained (when called as
   *  the first-in-flight) or immediately (when superseding an earlier call). */
  enqueue(args: SetCurrentClimbArgs): Promise<void>;
};

export function createSetCurrentClimbCoalescer(
  options: SetCurrentClimbCoalescerOptions,
): SetCurrentClimbCoalescer {
  const state: { inFlight: boolean; pending: SetCurrentClimbArgs | null } = {
    inFlight: false,
    pending: null,
  };

  const onDrainError =
    options.onDrainError ??
    ((err) => {
      console.error('Failed to send coalesced setCurrentClimb mutation:', err);
    });
  const onSupersededQueueAddError =
    options.onSupersededQueueAddError ??
    ((err) => {
      console.error('Failed to add superseded queue item:', err);
    });

  return {
    async enqueue(args) {
      if (state.inFlight) {
        // We're dropping the previously-pending setCurrentClimb in favour of
        // `args`. If that earlier pending call carried a queue-add, fire it
        // off so the climb still lands in the queue even though its
        // setCurrentClimb gets superseded.
        if (
          state.pending !== null &&
          state.pending.shouldAddToQueue &&
          state.pending.item !== null &&
          state.pending.item !== undefined &&
          options.sendSupersededQueueAdd !== undefined
        ) {
          options.sendSupersededQueueAdd(state.pending.item).catch(onSupersededQueueAddError);
        }
        state.pending = args;
        return;
      }

      state.inFlight = true;
      try {
        await options.sendArgs(args);
      } finally {
        while (state.pending !== null) {
          const next = state.pending;
          state.pending = null;
          try {
            await options.sendArgs(next);
          } catch (error) {
            onDrainError(error);
          }
        }
        state.inFlight = false;
      }
    },
  };
}
