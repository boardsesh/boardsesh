import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import {
  baselineAfterSprayHoldRemovals,
  clearSprayHoldDraft,
  loadSprayHoldDraft,
  saveSprayHoldDraft,
  sprayHoldDraftKey,
  type SprayHoldDraftIdentity,
  type SprayHoldEditorDraft,
} from '../../lib/spray/spray-hold-draft-store';
import type { SprayEditorPresent } from './spray-hold-editor-reducer';

export type SprayHoldDraftStatus = 'loading' | 'idle' | 'saving' | 'saved' | 'failed' | 'changed';
export type SprayHoldPersistence = {
  flush: () => Promise<void>;
  /** Editing is disabled; leaving can keep the untouched recovery record as-is. */
  recoveryPending?: boolean;
};
export const HOLD_AUTOSAVE_DELAY_MS = 500;

type Args = {
  identity: SprayHoldDraftIdentity | null;
  baseline: string | null;
  present: SprayEditorPresent;
  dirty: boolean;
  paused: boolean;
  onRestore: (present: SprayEditorPresent) => void;
};

/** Local recovery never writes the server; the explicit Publish/Next remains its only writer. */
export function useSprayHoldAutosave({ identity, baseline, present, dirty, paused, onRestore }: Args) {
  const key = identity ? sprayHoldDraftKey(identity) : null;
  const [status, setStatus] = useState<SprayHoldDraftStatus>(identity ? 'loading' : 'idle');
  const [ready, setReady] = useState(!identity);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [restoreEpoch, setRestoreEpoch] = useState(0);
  const mountedRef = useRef(true);
  const loadedKeyRef = useRef<string | null>(null);
  const baselineRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const operationsRef = useRef<Promise<void>>(Promise.resolve());
  const latestRef = useRef({ identity, baseline, present, dirty, paused, onRestore });
  latestRef.current = { identity, baseline, present, dirty, paused, onRestore };
  const acknowledgedRef = useRef(false);
  const savedPresentRef = useRef<SprayEditorPresent | null>(null);
  const hasRecoveryRef = useRef(false);

  const publishStatus = useCallback((next: SprayHoldDraftStatus) => {
    if (mountedRef.current) setStatus(next);
  }, []);
  const cancelTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  const enqueue = useCallback((operation: () => Promise<void>) => {
    const next = operationsRef.current.catch(() => undefined).then(operation);
    operationsRef.current = next;
    return next;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!key || baseline === null || loadedKeyRef.current === key) return;
    let cancelled = false;
    setReady(false);
    setStatus('loading');
    const capturedIdentity = identity!;
    void loadSprayHoldDraft(capturedIdentity)
      .then((stored) => {
        if (cancelled) return;
        if (stored && stored.baseline !== latestRef.current.baseline) {
          setStatus('changed');
          return;
        }
        baselineRef.current = baseline;
        loadedKeyRef.current = key;
        acknowledgedRef.current = false;
        if (stored) {
          latestRef.current.onRestore(stored.present);
          savedPresentRef.current = stored.present;
          hasRecoveryRef.current = true;
        }
        setReady(true);
        setStatus(stored ? 'saved' : 'idle');
        setRestoreEpoch((epoch) => epoch + 1);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setStatus(
            error instanceof Error && 'code' in error && error.code === 'INVALID_SPRAY_HOLD_RECOVERY'
              ? 'changed'
              : 'failed',
          );
      });
    return () => {
      cancelled = true;
    };
  }, [key, baseline, retryEpoch]);

  const flushOnce = useCallback(
    async function persistLatest() {
      cancelTimer();
      const current = latestRef.current;
      if (!current.identity) return;
      const currentKey = sprayHoldDraftKey(current.identity);
      if (loadedKeyRef.current !== currentKey || baselineRef.current === null) {
        throw new Error('Hold recovery has not loaded');
      }
      if (!current.dirty && hasRecoveryRef.current && !current.paused) {
        try {
          await enqueue(() => clearSprayHoldDraft(current.identity!));
          hasRecoveryRef.current = false;
          savedPresentRef.current = null;
          publishStatus('idle');
          if (
            latestRef.current.present !== current.present &&
            latestRef.current.identity &&
            sprayHoldDraftKey(latestRef.current.identity) === currentKey
          )
            await persistLatest();
        } catch (error) {
          publishStatus('failed');
          throw error;
        }
        return;
      }
      if (acknowledgedRef.current || current.paused || !current.dirty || savedPresentRef.current === current.present) {
        await operationsRef.current;
        if (
          latestRef.current.present !== current.present &&
          latestRef.current.identity &&
          sprayHoldDraftKey(latestRef.current.identity) === currentKey
        )
          await persistLatest();
        return;
      }
      const snapshot: SprayHoldEditorDraft = {
        ...current.identity,
        schemaVersion: 1,
        baseline: baselineRef.current,
        present: current.present,
      };
      publishStatus('saving');
      hasRecoveryRef.current = true;
      try {
        await enqueue(() => saveSprayHoldDraft(snapshot));
        savedPresentRef.current = snapshot.present;
        publishStatus(latestRef.current.present === snapshot.present ? 'saved' : 'saving');
        if (
          latestRef.current.present !== snapshot.present &&
          latestRef.current.identity &&
          sprayHoldDraftKey(latestRef.current.identity) === currentKey
        )
          await persistLatest();
      } catch (error) {
        publishStatus('failed');
        throw error;
      }
    },
    [cancelTimer, enqueue, publishStatus],
  );

  const drainingRef = useRef<Promise<void> | null>(null);
  const flush = useCallback(() => {
    if (drainingRef.current) return drainingRef.current;
    const operation = flushOnce();
    drainingRef.current = operation;
    const finished = () => {
      if (drainingRef.current === operation) drainingRef.current = null;
    };
    void operation.then(finished, finished);
    return operation;
  }, [flushOnce]);

  useEffect(() => {
    if (!ready || !identity || paused || (!dirty && !hasRecoveryRef.current) || acknowledgedRef.current) return;
    publishStatus('saving');
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flush().catch(() => undefined);
    }, HOLD_AUTOSAVE_DELAY_MS);
    return cancelTimer;
  }, [ready, key, present, dirty, paused, restoreEpoch, flush, cancelTimer, publishStatus]);

  useEffect(() => {
    const flushQuietly = () => {
      void flush().catch(() => undefined);
    };
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'inactive' || state === 'background') flushQuietly();
    });
    const browserDocument = Platform.OS === 'web' && typeof document !== 'undefined' ? document : null;
    const visibilityChanged = () => {
      if (browserDocument?.visibilityState === 'hidden') flushQuietly();
    };
    browserDocument?.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      subscription.remove();
      browserDocument?.removeEventListener('visibilitychange', visibilityChanged);
      flushQuietly();
    };
  }, [flush]);

  const checkpointRemoved = useCallback(
    async (removedIds: readonly number[]) => {
      cancelTimer();
      const current = latestRef.current;
      if (!current.identity || baselineRef.current === null) return;
      const removed = new Set(removedIds);
      const nextBaseline = baselineAfterSprayHoldRemovals(baselineRef.current, removedIds);
      const snapshot: SprayHoldEditorDraft = {
        ...current.identity,
        schemaVersion: 1,
        baseline: nextBaseline,
        present: {
          holds: Object.fromEntries(Object.entries(current.present.holds).filter(([, hold]) => !removed.has(hold.id))),
          removedIds: current.present.removedIds.filter((holdId) => !removed.has(holdId)),
          selectedId:
            current.present.selectedId !== null && removed.has(current.present.selectedId)
              ? null
              : current.present.selectedId,
          nextLocalId: current.present.nextLocalId,
        },
      };
      baselineRef.current = nextBaseline;
      hasRecoveryRef.current = true;
      publishStatus('saving');
      try {
        await enqueue(() => saveSprayHoldDraft(snapshot));
        savedPresentRef.current = snapshot.present;
        publishStatus('saved');
      } catch (error) {
        publishStatus('failed');
        throw error;
      }
    },
    [cancelTimer, enqueue, publishStatus],
  );

  const acknowledge = useCallback(async () => {
    cancelTimer();
    const current = latestRef.current;
    if (!current.identity) return;
    acknowledgedRef.current = true;
    try {
      await enqueue(() => clearSprayHoldDraft(current.identity!));
      hasRecoveryRef.current = false;
      savedPresentRef.current = null;
      publishStatus('idle');
    } catch {
      // The acknowledged server copy is authoritative. A leftover local record
      // is fenced by its baseline on the next read, never automatically replayed.
      publishStatus('failed');
    }
  }, [cancelTimer, enqueue, publishStatus]);

  const discardRecovery = useCallback(async () => {
    cancelTimer();
    const current = latestRef.current;
    if (!current.identity) return;
    await enqueue(() => clearSprayHoldDraft(current.identity!));
    loadedKeyRef.current = null;
    savedPresentRef.current = null;
    setRetryEpoch((epoch) => epoch + 1);
  }, [cancelTimer, enqueue]);

  // A new edit after a successful explicit save starts a fresh recovery record.
  useEffect(() => {
    if (!dirty) {
      acknowledgedRef.current = false;
      if (baseline !== null) baselineRef.current = baseline;
    }
  }, [dirty, baseline]);

  const retry = useCallback(() => {
    if (loadedKeyRef.current !== key) setRetryEpoch((epoch) => epoch + 1);
    else void flush().catch(() => undefined);
  }, [key, flush]);

  return {
    ready: !identity || (ready && loadedKeyRef.current === key),
    status,
    flush,
    acknowledge,
    checkpointRemoved,
    discardRecovery,
    retry,
  };
}
