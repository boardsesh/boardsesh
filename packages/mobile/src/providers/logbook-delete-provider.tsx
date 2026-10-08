import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { Portal } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { useDeleteTick } from '@boardsesh/board-react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useQueueSessionId } from './queue-provider';
import { useToast } from './toast-provider';
import { UndoSnackbar } from '../components/UndoSnackbar';
import { useBottomChromeMetrics } from '../hooks/use-bottom-chrome-metrics';
import { track } from '../lib/analytics';
import { hapticSuccess } from '../lib/haptics';
import { spacing } from '../theme/tokens';

export const LOGBOOK_DELETE_UNDO_MS = 8000;
type DeleteRequest = {
  originScope: string;
  uuid: string;
  method: 'swipe' | 'a11y';
  viaChooser?: boolean;
  onSuccess?: () => void;
  onSettled?: () => void;
};
type PendingDelete = DeleteRequest & {
  scope: string;
  nonce: number;
  timer: ReturnType<typeof setTimeout>;
  executing: boolean;
};
type DeleteActions = { scheduleDelete: (request: DeleteRequest) => boolean; getDeleteScope: () => string };
const ActionsContext = createContext<DeleteActions | null>(null);
const PendingContext = createContext<ReadonlySet<string>>(new Set());

export function useLogbookDeleteActions() {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error('useLogbookDeleteActions must be used within LogbookDeleteProvider');
  return actions;
}
export function usePendingLogbookDeletes() {
  return useContext(PendingContext);
}

/** Owns the real mutation above routes. Leaving a tab cannot silently abandon a
 * confirmed delete. Undo cancels before DELETE_TICK; we never recreate a deleted
 * Aurora tick. Account/board/session changes retire outstanding offers. */
export function LogbookDeleteProvider({ children }: { children: ReactNode }) {
  const { undoScope } = useQueueSessionId();
  const scopeRef = useRef(undoScope);
  scopeRef.current = undoScope;
  const { t } = useTranslation('you');
  const { t: tCommon } = useTranslation('common');
  const { showToast } = useToast();
  const bottomChrome = useBottomChromeMetrics();
  const deletion = useDeleteTick();
  const transportRef = useRef(deletion.mutateAsync);
  transportRef.current = deletion.mutateAsync;
  const pending = useRef(new Map<string, PendingDelete>());
  const nonce = useRef(0);
  const [hiddenUuids, setHiddenUuids] = useState<ReadonlySet<string>>(new Set());
  const [offer, setOffer] = useState<{ uuid: string; nonce: number } | null>(null);
  const publish = useCallback(() => setHiddenUuids(new Set(pending.current.keys())), []);
  const retire = useCallback(
    (task: PendingDelete) => {
      if (pending.current.get(task.uuid) !== task) return;
      clearTimeout(task.timer);
      pending.current.delete(task.uuid);
      setOffer((current) => (current?.nonce === task.nonce ? null : current));
      publish();
      task.onSettled?.();
    },
    [publish],
  );
  const getDeleteScope = useCallback(() => scopeRef.current, []);
  const scheduleDelete = useCallback(
    (request: DeleteRequest) => {
      if (request.originScope !== scopeRef.current) {
        showToast(tCommon('undoDelete.cancelled'), 'info');
        return false;
      }
      if (pending.current.has(request.uuid)) return false;
      const task: PendingDelete = {
        ...request,
        scope: scopeRef.current,
        nonce: ++nonce.current,
        executing: false,
        timer: setTimeout(() => {
          if (pending.current.get(task.uuid) !== task || task.scope !== scopeRef.current) {
            retire(task);
            return;
          }
          task.executing = true;
          setOffer((current) => (current?.nonce === task.nonce ? null : current));
          void transportRef
            .current(task.uuid)
            .then(
              () => {
                // UI callbacks belong to the originating scope; the provider's mutation
                // cache bookkeeping already ran before this promise settled.
                if (task.scope === scopeRef.current) {
                  track(SHARED_EVENTS.LogbookEntryDeleted, {
                    method: task.method,
                    viaChooser: task.viaChooser ?? false,
                  });
                  hapticSuccess();
                  task.onSuccess?.();
                }
              },
              () => {
                if (task.scope === scopeRef.current) showToast(t('mobile.logbook.deleteError'), 'error');
              },
            )
            .finally(() => retire(task))
            .catch(() => {});
        }, LOGBOOK_DELETE_UNDO_MS),
      };
      pending.current.set(task.uuid, task);
      publish();
      setOffer({ uuid: task.uuid, nonce: task.nonce });
      return true;
    },
    [publish, retire, showToast, t, tCommon],
  );
  const undo = useCallback(() => {
    if (!offer) return;
    const task = pending.current.get(offer.uuid);
    if (task && task.nonce === offer.nonce && !task.executing && task.scope === scopeRef.current) retire(task);
  }, [offer, retire]);
  // Dismissing the visual offer does not shorten the promised Undo period or
  // fire a server request. The provider timer is the only commit authority.
  const dismissOffer = useCallback(() => setOffer(null), []);
  useEffect(() => {
    let cancelled = false;
    for (const task of pending.current.values()) {
      if (task.scope !== undoScope && !task.executing) {
        retire(task);
        cancelled = true;
      }
    }
    if (cancelled) showToast(tCommon('undoDelete.cancelled'), 'info');
  }, [undoScope, retire, showToast, tCommon]);
  useEffect(
    () => () => {
      for (const task of pending.current.values()) clearTimeout(task.timer);
      pending.current.clear();
    },
    [],
  );
  const actions = useMemo(() => ({ scheduleDelete, getDeleteScope }), [scheduleDelete, getDeleteScope]);
  const snackbar = offer ? (
    <UndoSnackbar
      visible
      nonce={offer.nonce}
      message={tCommon('undoDelete.removed')}
      undoLabel={tCommon('undoDelete.undo')}
      onUndo={undo}
      onDismiss={dismissOffer}
      duration={LOGBOOK_DELETE_UNDO_MS}
      bottom={bottomChrome.floatingControlBottom + spacing[2]}
    />
  ) : null;
  return (
    <ActionsContext value={actions}>
      <PendingContext value={hiddenUuids}>
        {children}
        {snackbar ? (
          Platform.OS === 'ios' ? (
            <FullWindowOverlay>
              <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
                {snackbar}
              </View>
            </FullWindowOverlay>
          ) : (
            <Portal>{snackbar}</Portal>
          )
        ) : null}
      </PendingContext>
    </ActionsContext>
  );
}
