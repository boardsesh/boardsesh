import { useMemo, useRef } from 'react';
import { createQueueMutations, type QueueMutationsActions, type QueueMutationsDeps } from './create-queue-mutations';

/**
 * Renderer-agnostic React hook over `createQueueMutations`. The actions read
 * live platform I/O through `depsRef`, so client reconnects, session changes,
 * and locale-driven rerenders never recreate the coalescer or the callback
 * identities (the factory is built once per mount).
 *
 * Web injects a synchronous client + session getter and omits `ensureReady`
 * (already-joined, throw-on-disconnect). Mobile injects `getWsClient()`, a
 * `sessionIdRef` getter, and an `ensureReady` that runs ensureSession +
 * ensureJoined (lazy-create, no-op-on-disconnect).
 */
export function useQueueMutations<TItem>(deps: QueueMutationsDeps<TItem>): QueueMutationsActions<TItem> {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  return useMemo(() => {
    // Capture `ensureReady` PRESENCE at mount — it selects throw-vs-no-op and
    // never toggles for a given platform (web omits it, mobile always sets it).
    const hasEnsureReady = depsRef.current.ensureReady != null;
    return createQueueMutations<TItem>({
      getClient: () => depsRef.current.getClient(),
      getSessionId: () => depsRef.current.getSessionId(),
      toQueueItemInput: (item) => depsRef.current.toQueueItemInput(item),
      ensureReady: hasEnsureReady ? (capturedSessionId) => depsRef.current.ensureReady!(capturedSessionId) : undefined,
      onBestEffortError: (action, error) => depsRef.current.onBestEffortError?.(action, error),
    });
  }, []);
}
