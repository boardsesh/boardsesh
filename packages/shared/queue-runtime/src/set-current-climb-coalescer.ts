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

export type SetCurrentClimbCoalescerOptions<TContext = void> = {
  /** Send a single SET_CURRENT_CLIMB mutation with the given args. The
   *  `context` argument is whatever `getContext()` returned at enqueue time
   *  (default `undefined`). Use it to snapshot mutable state — session id,
   *  WS connection epoch — so a delayed drain dispatches against the same
   *  context the enqueue happened in, not whatever's current. */
  sendArgs: (args: SetCurrentClimbArgs, context: TContext) => Promise<void>;
  /** Fire-and-forget ADD_QUEUE_ITEM for a superseded request whose
   *  shouldAddToQueue flag was true. Receives the context captured when
   *  the now-superseded args were enqueued (not the current context) — so
   *  a session that flipped between enqueue and supersede doesn't get a
   *  stray queue-add. If omitted, superseded queue-adds are silently
   *  dropped (matches the no-coalescing baseline mobile had before). */
  sendSupersededQueueAdd?: (item: ClimbQueueItem, context: TContext) => Promise<void>;
  /** Snapshot caller state at enqueue time. Whatever this returns is
   *  captured into the pending entry and threaded through to sendArgs /
   *  sendSupersededQueueAdd. Defaults to `() => undefined`. */
  getContext?: () => TContext;
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

export function createSetCurrentClimbCoalescer<TContext = void>(
  options: SetCurrentClimbCoalescerOptions<TContext>,
): SetCurrentClimbCoalescer {
  type Pending = { args: SetCurrentClimbArgs; context: TContext };
  const state: { inFlight: boolean; pending: Pending | null } = {
    inFlight: false,
    pending: null,
  };

  const getContext = options.getContext ?? ((() => undefined) as () => TContext);
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
      const context = getContext();
      if (state.inFlight) {
        // We're dropping the previously-pending setCurrentClimb in favour of
        // `args`. If that earlier pending call carried a queue-add, fire it
        // off so the climb still lands in the queue even though its
        // setCurrentClimb gets superseded. Use the SUPERSEDED entry's
        // captured context — not the current one — so a session swap
        // between enqueue and supersede doesn't fire the queue-add against
        // the new session.
        if (
          state.pending !== null &&
          state.pending.args.shouldAddToQueue &&
          state.pending.args.item !== null &&
          options.sendSupersededQueueAdd !== undefined
        ) {
          options.sendSupersededQueueAdd(state.pending.args.item, state.pending.context).catch(onSupersededQueueAddError);
        }
        state.pending = { args, context };
        return;
      }

      state.inFlight = true;
      try {
        await options.sendArgs(args, context);
      } finally {
        while (state.pending !== null) {
          const next = state.pending;
          state.pending = null;
          try {
            await options.sendArgs(next.args, next.context);
          } catch (error) {
            onDrainError(error);
          }
        }
        state.inFlight = false;
      }
    },
  };
}
