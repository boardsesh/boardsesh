import { useMemo, useRef } from 'react';
import { createQueueMutations, type QueueMutationsActions, type QueueMutationsDeps } from './create-queue-mutations';

/**
 * Renderer-agnostic React hook over `createQueueMutations`. The actions read
 * live platform I/O through `depsRef`, so client reconnects, session changes,
 * and locale-driven rerenders never recreate the coalescer or the callback
 * identities (the factory is built once and rebuilt only if `ensureReady`
 * presence ever changes — see below).
 *
 * Web injects a synchronous client + session getter and omits `ensureReady`
 * (already-joined, throw-on-disconnect). Mobile injects `getWsClient()`, a
 * `sessionIdRef` getter, and an `ensureReady` that runs ensureJoined for an
 * existing session and returns null otherwise (solo stays local,
 * no-op-on-disconnect).
 */
export function useQueueMutations<TItem>(deps: QueueMutationsDeps<TItem>): QueueMutationsActions<TItem> {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  // `ensureReady` presence selects throw-vs-no-op, so it's a structural input to
  // the factory rather than a per-call value. It never toggles in practice (web
  // omits it, mobile always sets it), but keying the memo on its presence means
  // a caller that ever started/stopped providing it rebuilds cleanly instead of
  // silently using the mount-time value. Everything else is read live via the ref.
  const hasEnsureReady = deps.ensureReady != null;

  return useMemo(
    () =>
      createQueueMutations<TItem>({
        getClient: () => depsRef.current.getClient(),
        getSessionId: () => depsRef.current.getSessionId(),
        toQueueItemInput: (item) => depsRef.current.toQueueItemInput(item),
        ensureReady: hasEnsureReady
          ? (capturedSessionId) => depsRef.current.ensureReady!(capturedSessionId)
          : undefined,
        onBestEffortError: (action, error) => depsRef.current.onBestEffortError?.(action, error),
        onRateLimited: (event) => depsRef.current.onRateLimited?.(event),
      }),
    [hasEnsureReady],
  );
}
