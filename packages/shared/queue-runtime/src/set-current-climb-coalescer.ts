// SET_CURRENT_CLIMB coalescer.
//
// Rapid swipes through the queue can fire setCurrentClimb mutations faster
// than the backend can process them. Stacking them up at the client is wasted
// work — only the latest target climb matters. This factory implements
// "serialize-and-supersede": at most one mutation in flight, the most recent
// pending args win.
//
// A dropped SET_CURRENT_CLIMB costs two things, not one. The pointer move
// self-heals (the next activation or any peer broadcast re-establishes it), but
// a `shouldAddToQueue:true` payload's brand-new queue slot does not — the
// reducer already inserted it locally and no later activation retroactively
// adds it, so the climb would sit in this climber's queue and nobody else's.
// So both ways a pending activation can lose its setCurrentClimb fire the
// content half on its own via `sendDeferredQueueAdd`:
//   1. superseded while pending (a newer activation replaced it), and
//   2. drained and then rejected (rate limit, socket blip) — #3936.
//
// Extracted from web's
// `packages/web/app/components/persistent-session/hooks/use-queue-mutations.ts`
// so mobile picks up the same semantics. Pure TS — no React, no GraphQL
// client coupling. Callers wire `sendArgs` / `sendDeferredQueueAdd` to
// their platform-specific transport.

import type { ClimbQueueItem, CurrentClimbPlacement } from '@boardsesh/queue';

// `TItem` is the queue-item type the caller deals in. It defaults to the shared
// `ClimbQueueItem`, so existing callers (and the queue-runtime tests) need no
// type args; web/mobile pass their own item type so the coalescer carries it
// end-to-end without unsound casts at the call site.
export type SetCurrentClimbArgs<TItem = ClimbQueueItem> = {
  item: TItem | null;
  shouldAddToQueue?: boolean;
  correlationId?: string;
  /**
   * F3 now-slot mode: how the server puts the climb on the wall. A request
   * that carries it never fires a deferred queue-add: the climb goes on the
   * wall at the Now slot and is History once you move on, so a superseded or
   * lost open loses nothing worth keeping (the peek never reached the wall),
   * and re-sending it as an add would put every fast swipe's middle peek into
   * the crew's Up next.
   */
  placement?: CurrentClimbPlacement;
};

export type SetCurrentClimbCoalescerOptions<TContext = void, TItem = ClimbQueueItem> = {
  /** Send a single SET_CURRENT_CLIMB mutation with the given args. The
   *  `context` argument is whatever `getContext()` returned at enqueue time
   *  (default `undefined`). Use it to snapshot mutable state — session id,
   *  WS connection epoch — so a delayed drain dispatches against the same
   *  context the enqueue happened in, not whatever's current. */
  sendArgs: (args: SetCurrentClimbArgs<TItem>, context: TContext) => Promise<void>;
  /** Fire-and-forget ADD_QUEUE_ITEM for a pending request whose
   *  shouldAddToQueue flag was true but whose SET_CURRENT_CLIMB never
   *  landed — either because a newer activation superseded it, or because
   *  it drained and then rejected. Receives the context captured when those
   *  args were enqueued (not the current context) — so a session that
   *  flipped in between doesn't get a stray queue-add. If omitted, deferred
   *  queue-adds are silently dropped (matches the no-coalescing baseline
   *  mobile had before). */
  sendDeferredQueueAdd?: (item: TItem, context: TContext) => Promise<void>;
  /** Snapshot caller state at enqueue time. Whatever this returns is
   *  captured into the pending entry and threaded through to sendArgs /
   *  sendDeferredQueueAdd. Defaults to `() => undefined`. */
  getContext?: () => TContext;
  /** Errors during the drain loop are swallowed — this is the sink. It also
   *  receives the drained call's args: its caller's promise resolved the moment
   *  it superseded an earlier call, so this is the only place that learns the
   *  move never landed (and which move, by its `correlationId`). Return `true`
   *  when the sink re-sends a lost `shouldAddToQueue` slot itself (mobile holds
   *  it back while it waits to re-send the move); the coalescer then skips its
   *  own deferred queue-add. A sink that throws claims nothing. */
  onDrainError?: (error: unknown, args: SetCurrentClimbArgs<TItem>) => boolean | void;
  /** Sink for errors when the fire-and-forget deferred ADD_QUEUE_ITEM
   *  rejects (or throws synchronously). */
  onDeferredQueueAddError?: (error: unknown) => void;
};

export type SetCurrentClimbCoalescer<TItem = ClimbQueueItem> = {
  /** Enqueue a setCurrentClimb call. The returned promise resolves once this
   *  request *and* all coalesced followups have been drained (when called as
   *  the first-in-flight) or immediately (when superseding an earlier call). */
  enqueue(args: SetCurrentClimbArgs<TItem>): Promise<void>;
};

export function createSetCurrentClimbCoalescer<TContext = void, TItem = ClimbQueueItem>(
  options: SetCurrentClimbCoalescerOptions<TContext, TItem>,
): SetCurrentClimbCoalescer<TItem> {
  type Pending = { args: SetCurrentClimbArgs<TItem>; context: TContext };
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
  const onDeferredQueueAddError =
    options.onDeferredQueueAddError ??
    ((err) => {
      console.error('Failed to add deferred queue item:', err);
    });

  // Both loss paths (superseded-while-pending, drained-then-rejected) funnel
  // here so they behave identically. Fire-and-forget by contract: a rate-limited
  // ADD can sit in the transport's back-off for seconds, and awaiting it inside
  // the drain loop would hold `inFlight` true, parking later activations as
  // pending and manufacturing more supersedes.
  function fireDeferredQueueAdd(lost: Pending): void {
    const { item, shouldAddToQueue, placement } = lost.args;
    if (!shouldAddToQueue || placement !== undefined || item === null || options.sendDeferredQueueAdd === undefined) {
      return;
    }
    try {
      options.sendDeferredQueueAdd(item, lost.context).catch(onDeferredQueueAddError);
    } catch (error) {
      // The option type promises a Promise, but nothing stops a non-async
      // implementation throwing synchronously. From the drain loop's `catch`
      // that throw escapes the enclosing `finally`, so `inFlight` would stay
      // true forever and every later activation would park as pending and never
      // be sent. Route it to the same sink as a rejection.
      onDeferredQueueAddError(error);
    }
  }

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
        if (state.pending !== null) fireDeferredQueueAdd(state.pending);
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
            // This drained activation's SET_CURRENT_CLIMB never landed, so its
            // queue slot exists on this device and nowhere else. Recover the
            // content half exactly like the superseded branch does (#3936),
            // unless the sink takes that over. A throw out of the sink would
            // escape the enclosing `finally` and leave `inFlight` true for good,
            // parking every later activation as pending and never sending it,
            // so contain it; a sink that throws claims nothing and the recovery
            // still runs.
            let sinkClaimedQueueAdd = false;
            try {
              sinkClaimedQueueAdd = onDrainError(error, next.args) === true;
            } catch (sinkError) {
              console.error('setCurrentClimb drain-error sink threw:', sinkError);
            }
            if (!sinkClaimedQueueAdd) fireDeferredQueueAdd(next);
          }
        }
        state.inFlight = false;
      }
    },
  };
}
