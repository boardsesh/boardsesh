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
}: UseCreateClimbAutosaveArgs): { flush: () => void } {
  // The most recent payload, kept current by the debounced effect so a flush can
  // persist it synchronously without waiting for the (suspended-when-backgrounded)
  // debounce timer. `dirty` gates whether there is anything worth flushing.
  const pendingDraftRef = useRef<{ key: string; draft: CreateClimbDraft; dirty: boolean }>({
    key: slotKey,
    draft,
    dirty: false,
  });
  // Read through refs so the effect can key on the SIGNATURE alone.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    if (!restoredRef.current) return;
    pendingDraftRef.current = { key: slotKey, draft: draftRef.current, dirty: hasContent };
    const handle = setTimeout(() => {
      const pending = pendingDraftRef.current;
      pending.dirty = false;
      if (!hasContent) {
        void clearDraft(slotKey);
        return;
      }
      void saveDraft(slotKey, pending.draft);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // `draftSignature` stands in for the payload contents; `draftRef` carries the
    // object itself. `restoredRef` is a ref and never re-triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotKey, draftSignature, hasContent]);

  // JS timers are suspended when the app is backgrounded, and the effect
  // cleanup's clearTimeout drops the pending edit when the drawer closes inside
  // the debounce window — so persist the latest payload immediately on both.
  // `restoredRef` is a ref object, stable for the hook's lifetime.
  const flush = useCallback(() => {
    const pending = pendingDraftRef.current;
    if (!restoredRef.current || !pending.dirty) return;
    pending.dirty = false;
    void saveDraft(pending.key, pending.draft);
  }, [restoredRef]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background' || state === 'inactive') flush();
    });
    return () => {
      subscription.remove();
      flush();
    };
  }, [flush]);

  return { flush };
}
