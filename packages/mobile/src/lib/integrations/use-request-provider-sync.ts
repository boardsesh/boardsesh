import { useCallback, useInsertionEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { useToast } from '../../providers/toast-provider';
import type { ToastGuard } from '../../components/Toast';
import { hapticLight } from '../haptics';
import { createHttpOperation } from '../graphql/http-operation';
import { getHttpClient } from '../graphql/client';
import { subscribeHttpOperationScope } from '../graphql/use-auth-token';
import {
  REQUEST_PROVIDER_SYNC,
  type RequestProviderSyncMutationResponse,
  type RequestProviderSyncMutationVariables,
} from '../graphql/operations';
import { AURORA_CREDENTIALS_QUERY_KEY } from './board-account-query-keys';
import type { OriginalCredentialsRead } from './use-board-account-reads';

type Options = Readonly<{
  reader: OriginalCredentialsRead;
  errorMessage(error: unknown): string;
  isWarning(error: unknown): boolean;
}>;
type Pending = Readonly<{ id: object; boardType: AuroraBoardName; assertCurrent(): void }>;
type Action = Readonly<{ type: 'add'; entry: Pending }> | Readonly<{ type: 'remove'; id: object }>;
function current(assertCurrent: () => void): boolean {
  try {
    assertCurrent();
    return true;
  } catch {
    return false;
  }
}
function pendingReducer(previous: readonly Pending[], action: Action): readonly Pending[] {
  if (action.type === 'remove') return previous.filter((entry) => entry.id !== action.id);
  if (!current(action.entry.assertCurrent)) return previous;
  const next = [...previous, action.entry];
  return current(action.entry.assertCurrent) ? next : previous;
}
function requestNative(boardType: AuroraBoardName) {
  return getHttpClient().request<RequestProviderSyncMutationResponse, RequestProviderSyncMutationVariables>(
    REQUEST_PROVIDER_SYNC,
    { boardType },
  );
}

type RetainedAction = Readonly<{ id: object; retire(deferNotification?: boolean): void }>;

/** Queueing is one SDK cause; later admitted status GETs and the completion
 * watcher remain independent causes. No queued job is invented in local state. */
export function useRequestProviderSync(options: Options) {
  const { reader } = options;
  const queryClient = useQueryClient();
  const { showToast, showGuardedToast } = useToast();
  const lifetime = useRef({ mounted: true, epoch: {} });
  const active = useRef(new Map<AuroraBoardName, RetainedAction>());
  const retained = useRef(new Set<RetainedAction>());
  const [pending, dispatch] = useReducer(pendingReducer, []);
  const nativeInFlight = useRef(new Set<AuroraBoardName>());
  const [nativePending, setNativePending] = useState<ReadonlySet<AuroraBoardName>>(() => new Set());
  const nativeMutation = useMutation({
    mutationFn: requestNative,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: AURORA_CREDENTIALS_QUERY_KEY });
    },
    onError: (error) => {
      showToast(options.errorMessage(error), options.isWarning(error) ? 'warning' : 'error');
    },
    onSettled: (_result, _error, boardType) => {
      nativeInFlight.current.delete(boardType);
      setNativePending(new Set(nativeInFlight.current));
    },
  });
  useInsertionEffect(() => {
    lifetime.current.mounted = true;
    return () => {
      lifetime.current.mounted = false;
      lifetime.current.epoch = {};
      // Retire pure intent during actual deletion, not Suspense layout hiding.
      // React notifications run afterward, outside insertion cleanup.
      for (const action of retained.current) action.retire(true);
    };
  }, []);

  const request = useCallback(
    (boardType: AuroraBoardName) => {
      if (reader.view.mode === 'native') {
        if (nativeInFlight.current.has(boardType)) return;
        nativeInFlight.current.add(boardType);
        setNativePending(new Set(nativeInFlight.current));
        nativeMutation.mutate(boardType);
        return;
      }
      const epoch = lifetime.current.epoch;
      const assertIntent = () => {
        if (
          !lifetime.current.mounted ||
          lifetime.current.epoch !== epoch ||
          (reader.view.mode !== 'selected' && reader.view.mode !== 'legacy')
        )
          throw new BrowserBackendConsumerError('superseded');
        reader.assertView();
      };
      if (!current(assertIntent) || active.current.has(boardType)) return;
      const operation = createHttpOperation(reader.view.scope);
      const assertOrigin = () => {
        assertIntent();
        operation.assertView();
        assertIntent();
      };
      if (!current(assertOrigin)) {
        operation.dispose();
        return;
      }
      if (reader.view.scoped) {
        hapticLight();
        if (!current(assertOrigin)) {
          operation.dispose();
          return;
        }
      }
      const id = {};
      let proof: (() => void) | undefined;
      let retired = false;
      let disposed = false;
      let coordinator = true;
      let presentations = 0;
      let timer: ReturnType<typeof setInterval> | undefined;
      let releaseScope: (() => void) | undefined;
      const listeners = new Set<Readonly<{ listener: () => void }>>();
      const assertCurrent = () => {
        if (retired) throw new BrowserBackendConsumerError('superseded');
        assertOrigin();
        proof?.();
        assertIntent();
      };
      const stopWakeups = () => {
        if (timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
        const release = releaseScope;
        releaseScope = undefined;
        release?.();
      };
      let action: RetainedAction;
      const disposeOnce = () => {
        if (disposed) return;
        disposed = true;
        stopWakeups();
        retained.current.delete(action);
        operation.dispose();
      };
      const cleanup = () => {
        if (!coordinator && !presentations) disposeOnce();
      };
      const notify = () => {
        for (const entry of Array.from(listeners)) {
          if (!listeners.has(entry)) continue;
          const listener = entry.listener;
          try {
            listener();
          } catch {
            /* A wake-up is never accepting evidence. */
          }
        }
        if (active.current.get(boardType)?.id === id) active.current.delete(boardType);
        dispatch({ type: 'remove', id });
      };
      const retire = (deferNotification = false) => {
        if (retired) return;
        retired = true;
        disposeOnce();
        if (deferNotification) queueMicrotask(notify);
        else notify();
      };
      action = Object.freeze({ id, retire });
      retained.current.add(action);
      active.current.set(boardType, action);
      releaseScope = subscribeHttpOperationScope(() => {
        if (!current(assertCurrent)) retire();
      });
      if (retired) {
        const release = releaseScope;
        releaseScope = undefined;
        release();
      }
      const settled = (assertProof: () => void) => {
        proof = assertProof;
        assertCurrent();
        // Quiet expiry is a veto-only wake-up. There is no cached true authority,
        // inferred deadline, operation.subscribe or credential acquisition here.
        timer = setInterval(() => {
          if (!current(assertCurrent)) retire();
        }, 100);
      };
      const present = (error: unknown) => {
        assertCurrent();
        const message = options.errorMessage(error);
        assertCurrent();
        const variant = options.isWarning(error) ? 'warning' : 'error';
        assertCurrent();
        let live = true;
        presentations++;
        const guard: ToastGuard = Object.freeze({
          assertCurrent() {
            if (!live) throw new BrowserBackendConsumerError('superseded');
            assertCurrent();
          },
          subscribe(listener) {
            const entry = Object.freeze({ listener });
            listeners.add(entry);
            return () => {
              listeners.delete(entry);
            };
          },
          release() {
            if (!live) return;
            live = false;
            presentations--;
            cleanup();
          },
        });
        try {
          showGuardedToast(message, variant, guard);
        } catch (error) {
          guard.release();
          throw error;
        }
        assertCurrent();
      };
      dispatch({ type: 'add', entry: Object.freeze({ id, boardType, assertCurrent }) });
      void (async () => {
        try {
          assertCurrent();
          // Only the actual SDK await belongs to this error provenance branch.
          try {
            await operation.request<RequestProviderSyncMutationResponse, RequestProviderSyncMutationVariables>(
              REQUEST_PROVIDER_SYNC,
              { boardType },
            );
          } catch (error) {
            try {
              operation.assertErrorDeliveries(error);
              settled(() => operation.assertErrorDeliveries(error));
              present(error);
            } catch {
              /* Unknown/copied/stale errors supply no mutation guidance. */
            }
            return;
          }
          operation.assertDeliveries();
          settled(operation.assertDeliveries);
          assertCurrent();
          await reader.refreshAfterSync(assertCurrent);
          assertCurrent();
        } catch {
          // Consumer/refetch/formatting failures never become SDK error guidance.
        } finally {
          if (active.current.get(boardType)?.id === id) active.current.delete(boardType);
          dispatch({ type: 'remove', id });
          coordinator = false;
          cleanup();
        }
      })();
    },
    [reader, nativeMutation, options, showGuardedToast],
  );

  const retry = useCallback(async () => {
    if (reader.view.mode === 'native') {
      await reader.retry(() => {});
      return;
    }
    const epoch = lifetime.current.epoch;
    const assertOriginal = () => {
      if (!lifetime.current.mounted || lifetime.current.epoch !== epoch)
        throw new BrowserBackendConsumerError('superseded');
      reader.assertView();
    };
    if (!current(assertOriginal)) return;
    if (reader.view.scoped) {
      hapticLight();
      if (!current(assertOriginal)) return;
    }
    try {
      await reader.retry(assertOriginal);
    } catch {
      /* Own query state reports read failures. */
    }
  }, [reader]);
  const boards = useMemo(
    () => new Set(pending.filter((entry) => current(entry.assertCurrent)).map((entry) => entry.boardType)),
    [pending, reader],
  );
  return {
    request,
    retry,
    suppressButtonHaptic: reader.view.scoped,
    isRequesting: (boardType: AuroraBoardName) =>
      reader.view.mode === 'native' ? nativePending.has(boardType) : boards.has(boardType),
  };
}
