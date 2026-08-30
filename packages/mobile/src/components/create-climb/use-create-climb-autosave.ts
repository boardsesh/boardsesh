// The create-climb editor's on-device autosave: a debounced write of the current
// working copy into one slot, plus the two flushes that keep the "a backgrounded
// app doesn't lose work-in-progress" promise honest.
//
// Extracted from the screen controller so the controller keeps the parts that
// need its other state (which slot, what the payload is, when a server save
// re-attaches a row) and this file owns only the timing. It has no GraphQL
// knowledge and never decides WHICH slot to write — the caller passes the key.
//
// `holdsJson` / `framesJson` deliberately stay in the controller: the BLE preview
// effect closes over `holdsJson` and lists it in its deps, and that effect must
// stay byte-identical (moving it would put this change in Bluetooth review
// scope). The caller passes the finished payload in.

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { clearDraft, saveDraft, type CreateClimbDraft } from '../../lib/create-climb-draft-store';

export const AUTOSAVE_DEBOUNCE_MS = 500;

type PendingAutosaveOperation = { type: 'none' } | { type: 'save'; key: string } | { type: 'clear'; key: string };

type UseCreateClimbAutosaveArgs = {
  /** Which storage slot this authoring session owns. */
  slotKey: string;
  /** The payload to persist. A fresh object each render; see `draftSignature`. */
  draft: CreateClimbDraft;
  /**
   * Cheap value-identity for `draft`. The effect keys on this rather than the
   * object, so an unrelated re-render can't restart the debounce (and so we
   * don't re-serialize the whole payload every render just to compare it).
   */
  draftSignature: string;
  /** False when the editor is empty — the slot is dropped instead of written. */
  hasContent: boolean;
  /**
   * Gate: stays false until the mount-time restore has been applied. Writing
   * before that persists the empty/server copy OVER the stored one and destroys
   * exactly the work the restore exists to recover.
   */
  restoredRef: RefObject<boolean>;
  /** Changes when mount-time restore finishes so pre-restore edits can arm. */
  restoreEpoch: number;
};

/**
 * Persists the working copy into `slotKey`, debounced, and flushes immediately on
 * unmount and on backgrounding.
 */
export function useCreateClimbAutosave({
  slotKey,
  draft,
  draftSignature,
  hasContent,
  restoredRef,
  restoreEpoch,
}: UseCreateClimbAutosaveArgs): {
  flush: () => void;
  discard: () => Promise<void>;
  persist: (draft: CreateClimbDraft) => Promise<void>;
} {
  // The most recent payload, kept current by the debounced effect so a flush can
  // persist it synchronously without waiting for the (suspended-when-backgrounded)
  // debounce timer. Empty editors carry an explicit `clear` operation: treating
  // them as merely "not dirty" made an unmount/background flush drop the clear
  // and leave the previous working copy behind.
  const pendingOperationRef = useRef<PendingAutosaveOperation>({ type: 'none' });
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const storageOperationRef = useRef<Promise<void> | null>(null);
  // Read through refs so the effect can key on the SIGNATURE alone.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const enqueueStorageOperation = useCallback((operation: () => Promise<void>): Promise<void> => {
    const previousOperation = storageOperationRef.current;
    const nextOperation = previousOperation ? previousOperation.catch(() => undefined).then(operation) : operation();
    storageOperationRef.current = nextOperation;
    void nextOperation.then(
      () => {
        if (storageOperationRef.current === nextOperation) storageOperationRef.current = null;
      },
      () => {
        if (storageOperationRef.current === nextOperation) storageOperationRef.current = null;
      },
    );
    return nextOperation;
  }, []);

  const executePendingOperation = useCallback(() => {
    const pendingOperation = pendingOperationRef.current;
    pendingOperationRef.current = { type: 'none' };
    if (pendingOperation.type === 'save') {
      const pendingDraft = draftRef.current;
      void enqueueStorageOperation(() => saveDraft(pendingOperation.key, pendingDraft));
    } else if (pendingOperation.type === 'clear') {
      void enqueueStorageOperation(() => clearDraft(pendingOperation.key));
    }
  }, [enqueueStorageOperation]);

  useEffect(() => {
    if (!restoredRef.current) return;
    pendingOperationRef.current = hasContent ? { type: 'save', key: slotKey } : { type: 'clear', key: slotKey };
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      executePendingOperation();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    };
    // `draftSignature` stands in for the payload contents; `draftRef` carries the
    // object itself. `restoreEpoch` re-runs this once when the ref gate opens,
    // preserving edits made while an asynchronous restore was still pending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotKey, draftSignature, hasContent, restoreEpoch, executePendingOperation]);

  // JS timers are suspended when the app is backgrounded, and the effect
  // cleanup's clearTimeout drops the pending edit when the drawer closes inside
  // the debounce window — so persist the latest payload immediately on both.
  // `restoredRef` is a ref object, stable for the hook's lifetime.
  const flush = useCallback(() => {
    if (!restoredRef.current) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = null;
    executePendingOperation();
  }, [restoredRef, executePendingOperation]);

  const cancelPending = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = null;
    pendingOperationRef.current = { type: 'none' };
  }, []);

  // Deliberate abandonment is different from the form naturally becoming
  // empty. Clear immediately and retire the pending operation before the caller
  // navigates/unmounts, so the cleanup flush cannot recreate the slot from the
  // last non-empty render.
  const discard = useCallback(() => {
    cancelPending();
    const clearOperation = enqueueStorageOperation(() => clearDraft(slotKey));
    return clearOperation.catch(async (error: unknown) => {
      // A failed deliberate clear must not turn off the durability guarantee.
      // Re-persist the latest working copy before reporting failure so cancelling
      // the confirmation and then dismissing cannot lose a never-written edit.
      if (hasContent) {
        await enqueueStorageOperation(() => saveDraft(slotKey, draftRef.current));
      }
      throw error;
    });
  }, [cancelPending, enqueueStorageOperation, hasContent, slotKey]);

  // Explicit Save must be ordered after any autosave already writing, then win
  // with the server-row link and saved payload baseline. Cancelling a timer alone
  // cannot stop a storage write that has already started.
  const persist = useCallback(
    (nextDraft: CreateClimbDraft) => {
      cancelPending();
      return enqueueStorageOperation(() => saveDraft(slotKey, nextDraft));
    },
    [cancelPending, enqueueStorageOperation, slotKey],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background' || state === 'inactive') flush();
    });
    return () => {
      subscription.remove();
      flush();
    };
  }, [flush]);

  return { flush, discard, persist };
}
