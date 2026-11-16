import { useCallback, useInsertionEffect, useMemo, useReducer, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { useToast } from '../../providers/toast-provider';
import type { ToastGuard, ToastVariant } from '../../components/Toast';
import { BoardAccountError, deleteAuroraCredential, unlinkAuroraCredentialWithReceipt } from '../aurora-credentials';
import { captureRestReadView, createUnlinkRestOperation, useRestView } from '../rest-operation';
import type { RestUnlinkOperation } from '../rest-operation';
import { AURORA_CREDENTIALS_QUERY_KEY, AURORA_UNSYNCED_QUERY_KEY } from './board-account-query-keys';

type Options = Readonly<{
  confirm(boardType: AuroraBoardName): Promise<boolean>;
  successMessage(boardType: AuroraBoardName, partial: boolean): string;
  errorMessage(error: unknown): string;
}>;
type Pending = Readonly<{ id: object; boardType: AuroraBoardName; assertCurrent(): void }>;
type PendingAction = Readonly<{ type: 'add'; entry: Pending }> | Readonly<{ type: 'remove'; id: object }>;
function current(assertCurrent: () => void): boolean {
  try {
    assertCurrent();
    return true;
  } catch {
    return false;
  }
}
function pendingReducer(state: readonly Pending[], action: PendingAction): readonly Pending[] {
  if (action.type === 'remove') return state.filter((entry) => entry.id !== action.id);
  if (!current(action.entry.assertCurrent)) return state;
  const next = [...state, action.entry];
  return current(action.entry.assertCurrent) ? next : state;
}

/** The intent only vetoes; the command's actual physical response supplies every
 * terminal outcome guard. Presentation release and coordinator release differ. */
export function useUnlinkBoardAccount(options: Options) {
  const queryClient = useQueryClient();
  const { showToast, showGuardedToast } = useToast();
  const view = useRestView();
  const lifetime = useRef({ mounted: true, epoch: {} });
  const operations = useRef(new Map<RestUnlinkOperation, () => void>());
  const [pending, dispatchPending] = useReducer(pendingReducer, []);

  // Keep installed native mutation scheduling, default network mode and feedback.
  const nativeMutation = useMutation({
    mutationFn: deleteAuroraCredential,
    onSuccess: async (result, boardType) => {
      showToast(options.successMessage(boardType, !result.success), result.success ? 'success' : 'warning');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: AURORA_CREDENTIALS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: AURORA_UNSYNCED_QUERY_KEY }),
      ]);
    },
    onError: (error) => {
      showToast(options.errorMessage(error), 'error');
    },
  });

  // Insertion cleanup belongs to actual deletion, not Suspense's temporary
  // layout disconnect. Retire intent before any ancestor layout continuation.
  useInsertionEffect(() => {
    lifetime.current.mounted = true;
    return () => {
      lifetime.current.mounted = false;
      lifetime.current.epoch = {};
      for (const retire of operations.current.values()) retire();
      operations.current.clear();
    };
  }, []);

  const unlink = useCallback(
    async (boardType: AuroraBoardName) => {
      // Pin no-I/O original intent before opening the actual asynchronous dialog.
      const original = captureRestReadView();
      if (original.mode === 'native') {
        if (await options.confirm(boardType)) nativeMutation.mutate(boardType);
        return;
      }
      const epoch = lifetime.current.epoch;
      const assertIntent = () => {
        if (
          !lifetime.current.mounted ||
          lifetime.current.epoch !== epoch ||
          !original.ready ||
          !original.isCurrent() ||
          (original.mode !== 'selected' && original.mode !== 'legacy')
        )
          throw new BrowserBackendConsumerError('superseded');
      };
      if (!current(assertIntent)) return;
      const confirmed = await options.confirm(boardType);
      if (!confirmed || !current(assertIntent)) return;

      const operation = createUnlinkRestOperation(original.scope);
      const id = {};
      let coordinator = true;
      let presentations = 0;
      let cleaned = false;
      const retireOnce = () => {
        if (cleaned) return;
        cleaned = true;
        operations.current.delete(operation);
        operation.dispose();
      };
      operations.current.set(operation, retireOnce);
      const cleanup = () => {
        if (coordinator || presentations) return;
        retireOnce();
      };
      const publish = (message: string, variant: ToastVariant, assertOutcome: () => void) => {
        const assertOriginal = () => {
          assertIntent();
          assertOutcome();
          assertIntent();
        };
        assertOriginal();
        let active = true;
        presentations += 1;
        const guard: ToastGuard = Object.freeze({
          assertCurrent() {
            if (!active) throw new BrowserBackendConsumerError('superseded');
            assertOriginal();
          },
          subscribe: operation.subscribe,
          release() {
            if (!active) return;
            active = false;
            presentations -= 1;
            cleanup();
          },
        });
        try {
          showGuardedToast(message, variant, guard);
        } catch (error) {
          guard.release();
          throw error;
        }
        assertOriginal();
      };
      const assertAttempt = () => {
        assertIntent();
        operation.assertAttemptCurrent();
        assertIntent();
      };
      dispatchPending({ type: 'add', entry: Object.freeze({ id, boardType, assertCurrent: assertIntent }) });
      const started: Promise<unknown>[] = [];
      let assertOutcome: (() => void) | undefined;
      try {
        assertAttempt();
        const outcome = await unlinkAuroraCredentialWithReceipt(operation, boardType);
        assertOutcome = outcome.assertCurrent;
        const assertOriginal = () => {
          assertIntent();
          outcome.assertCurrent();
          assertIntent();
        };
        assertOriginal();
        if (!outcome.ok) {
          publish(options.errorMessage(outcome.error), 'error', outcome.assertCurrent);
          return;
        }
        publish(
          options.successMessage(boardType, !outcome.result.success),
          outcome.result.success ? 'success' : 'warning',
          outcome.assertCurrent,
        );
        for (const logical of [AURORA_CREDENTIALS_QUERY_KEY, AURORA_UNSYNCED_QUERY_KEY]) {
          assertOriginal();
          // Attach rejection observation before a reentrant post-enqueue guard.
          const invalidation = Promise.resolve(queryClient.invalidateQueries({ queryKey: original.key(logical) }));
          const observed = invalidation.then(
            (result) => ({ ok: true as const, result }),
            () => ({ ok: false as const }),
          );
          started.push(observed);
          assertOriginal();
        }
        const results = await Promise.all(started);
        assertOriginal();
        if (results.some((result) => !(result as { ok: boolean }).ok))
          publish(options.errorMessage(new BoardAccountError('request_failed')), 'error', outcome.assertCurrent);
      } catch (error) {
        // Every started enqueue settles before coordinator ownership is released.
        await Promise.allSettled(started);
        if (error instanceof BrowserBackendConsumerError || (error instanceof Error && error.name === 'AbortError'))
          return;
        if (!current(assertAttempt) || (assertOutcome && !current(assertOutcome))) return;
        // No physical response means no accepting error receipt: fixed non-data
        // feedback is restricted by the original failed-attempt/intent veto only.
        publish(options.errorMessage(new BoardAccountError('request_failed')), 'error', assertOutcome ?? assertAttempt);
      } finally {
        await Promise.allSettled(started);
        dispatchPending({ type: 'remove', id });
        coordinator = false;
        cleanup();
      }
    },
    [options, nativeMutation, queryClient, showGuardedToast],
  );

  const removing = useMemo(
    () => new Set(pending.filter((entry) => current(entry.assertCurrent)).map((entry) => entry.boardType)),
    [pending, view],
  );
  const isRemoving = useCallback(
    (boardType: AuroraBoardName) =>
      view.mode === 'native'
        ? nativeMutation.isPending && nativeMutation.variables === boardType
        : removing.has(boardType),
    [view.mode, nativeMutation.isPending, nativeMutation.variables, removing],
  );
  return { unlink, isRemoving };
}
