// JOIN_SESSION promise cache with connection-epoch invalidation.
//
// Backends bind sessionId into per-connection state (`ConnectionContext`)
// only after JOIN_SESSION returns. Queue mutations gate on this — without
// it, an ADD_QUEUE_ITEM can race ahead of JOIN_SESSION on a freshly opened
// socket and trip the server's `requireSession(ctx)` guard.
//
// To avoid firing JOIN_SESSION more than once per (sessionId, connection):
// we cache the in-flight promise keyed by (sessionId, epoch). When the
// socket closes the caller bumps the epoch — any cached entry becomes stale
// by key, so a mutation racing between `closed` and `connected` will fire
// its own join on the new connection instead of awaiting a stale-resolved
// promise from the dead socket.
//
// Extracted from
// `packages/mobile/src/providers/queue-provider.tsx`. Web's equivalent in
// `persistent-session/hooks/use-session-lifecycle.ts` follows a different
// reconnect-orchestration pattern; adopting this tracker there is a
// follow-up (see Workstream A appendix in the plan).

export type JoinSessionTrackerOptions = {
  /** Resolve the board path for a given sessionId at join time. Returns null
   *  to signal "can't join yet" (no board config stored, board not yet
   *  selected). The tracker throws when null so the caller's catch can
   *  surface a toast. */
  getBoardPath: (sessionId: string) => Promise<string | null>;
  /** Fire the JOIN_SESSION mutation. Resolves when the server acks. */
  execute: (vars: { sessionId: string; boardPath: string }) => Promise<unknown>;
};

export type JoinSessionTracker = {
  /** Idempotent join. Awaits the existing promise if (sessionId, current
   *  epoch) matches the cache; otherwise fires a fresh JOIN_SESSION and
   *  caches it. */
  ensureJoined(sessionId: string): Promise<void>;
  /** Bump the epoch and clear the cache. Call from the socket's `closed`
   *  handler — a fresh connection means a fresh per-connection
   *  ConnectionContext on the backend, so re-issuing JOIN_SESSION on the
   *  new socket is mandatory. */
  bumpEpoch(): void;
  /** Clear the cache without bumping the epoch — e.g., when sessionId
   *  changes to null. */
  reset(): void;
};

export function createJoinSessionTracker(options: JoinSessionTrackerOptions): JoinSessionTracker {
  let epoch = 0;
  let cached: { sessionId: string; epoch: number; promise: Promise<void> } | null = null;

  return {
    bumpEpoch() {
      epoch += 1;
      cached = null;
    },
    reset() {
      cached = null;
    },
    async ensureJoined(sessionId) {
      const currentEpoch = epoch;
      const current = cached;
      if (current !== null && current.sessionId === sessionId && current.epoch === currentEpoch) {
        await current.promise;
        return;
      }

      // Build and cache the join promise *synchronously* so concurrent
      // callers entering before the first one resumes from getBoardPath
      // find the cache populated and await the same promise. Mobile's
      // original inline code awaited getBoardPath before caching — fine in
      // practice (mutations don't fire back-to-back on the same tick) but
      // racy by construction.
      const promise = (async () => {
        const boardPath = await options.getBoardPath(sessionId);
        if (boardPath === null) {
          throw new Error('Board path unavailable — cannot join session');
        }
        await options.execute({ sessionId, boardPath });
      })();

      const entry = { sessionId, epoch: currentEpoch, promise };
      cached = entry;
      try {
        await promise;
      } catch (err) {
        // Clear only if THIS entry is still cached — a concurrent bumpEpoch
        // may have already nulled it.
        if (cached === entry) {
          cached = null;
        }
        throw err;
      }
    },
  };
}
