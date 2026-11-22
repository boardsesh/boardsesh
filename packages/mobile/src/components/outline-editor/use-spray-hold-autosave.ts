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
  /** Internal session teardown: drain once, then refuse late writes. */
  retire?: () => Promise<void>;
  /** Retain ownership while the host publishes the saved draft. */
  runCommit?: <Result>(operation: () => Promise<Result>) => Promise<Result>;
  /** Editing is disabled; leaving can keep the untouched recovery record as-is. */
  recoveryPending?: boolean;
};
export const HOLD_AUTOSAVE_DELAY_MS = 500;
/** Starts a checkpoint during continuous editing; storage completion may take longer. */
export const HOLD_AUTOSAVE_MAX_WAIT_MS = 2000;

type Args = {
  identity: SprayHoldDraftIdentity | null;
  baseline: string | null;
  present: SprayEditorPresent;
  dirty: boolean;
  paused: boolean;
  onRestore: (present: SprayEditorPresent) => void;
  /** Instance-local source for same-tick completions before React has rendered. */
  readLatestPresent?: () => { present: SprayEditorPresent; dirty: boolean };
};

function samePresent(first: SprayEditorPresent | null, second: SprayEditorPresent): boolean {
  return (
    first === second ||
    (first !== null &&
      first.holds === second.holds &&
      first.removedIds === second.removedIds &&
      first.selectedId === second.selectedId &&
      first.nextLocalId === second.nextLocalId)
  );
}

/** Local recovery never writes the server; the explicit Publish/Next remains its only writer. */
export function useSprayHoldAutosave({
  identity,
  baseline,
  present,
  dirty,
  paused,
  onRestore,
  readLatestPresent,
}: Args) {
  const key = identity ? sprayHoldDraftKey(identity) : null;
  const [status, setStatus] = useState<SprayHoldDraftStatus>(identity ? 'loading' : 'idle');
  const [commitActive, setCommitActive] = useState(false);
  const [ready, setReady] = useState(!identity);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [restoreEpoch, setRestoreEpoch] = useState(0);
  const mountedRef = useRef(true);
  const retiredRef = useRef(false);
  const retiringRef = useRef(false);
  const loadedKeyRef = useRef<string | null>(null);
  const baselineRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadlineKeyRef = useRef<string | null>(null);
  const operationsRef = useRef<Promise<void>>(Promise.resolve());
  const latestRef = useRef({ identity, baseline, present, dirty, paused, onRestore, readLatestPresent });
  latestRef.current = { identity, baseline, present, dirty, paused, onRestore, readLatestPresent };
  const readLatest = useCallback(() => {
    const current = latestRef.current;
    const snapshot = current.readLatestPresent?.();
    if (snapshot) latestRef.current = { ...current, ...snapshot };
    return latestRef.current;
  }, []);
  const acknowledgedRef = useRef(false);
  const savedPresentRef = useRef<SprayEditorPresent | null>(null);
  const hasRecoveryRef = useRef(false);
  const commitRef = useRef<Promise<void> | null>(null);
  const retiringCommitRef = useRef(false);

  const publishStatus = useCallback((next: SprayHoldDraftStatus) => {
    if (mountedRef.current) setStatus(next);
  }, []);
  const cancelIdleTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  const cancelDeadline = useCallback(() => {
    if (maxWaitTimerRef.current !== null) clearTimeout(maxWaitTimerRef.current);
    maxWaitTimerRef.current = null;
    deadlineKeyRef.current = null;
  }, []);
  const cancelTimers = useCallback(() => {
    cancelIdleTimer();
    cancelDeadline();
  }, [cancelIdleTimer, cancelDeadline]);
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
      cancelTimers();
      if (commitRef.current || retiringCommitRef.current) {
        await commitRef.current;
        await operationsRef.current;
        return;
      }
      const current = readLatest();
      if (!current.identity || retiredRef.current) return;
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
          const latest = readLatest();
          if (
            !samePresent(latest.present, current.present) &&
            latest.identity &&
            sprayHoldDraftKey(latest.identity) === currentKey
          )
            await persistLatest();
        } catch (error) {
          publishStatus('failed');
          throw error;
        }
        return;
      }
      if (
        acknowledgedRef.current ||
        current.paused ||
        !current.dirty ||
        samePresent(savedPresentRef.current, current.present)
      ) {
        await operationsRef.current;
        if (!current.paused) publishStatus(samePresent(savedPresentRef.current, current.present) ? 'saved' : 'idle');
        const latest = readLatest();
        if (
          !samePresent(latest.present, current.present) &&
          latest.identity &&
          sprayHoldDraftKey(latest.identity) === currentKey
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
        const latest = readLatest();
        publishStatus(samePresent(latest.present, snapshot.present) ? 'saved' : 'saving');
        if (
          !samePresent(latest.present, snapshot.present) &&
          latest.identity &&
          sprayHoldDraftKey(latest.identity) === currentKey
        )
          await persistLatest();
      } catch (error) {
        publishStatus('failed');
        throw error;
      }
    },
    [cancelTimers, enqueue, publishStatus, readLatest],
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

  const runCommit = useCallback(
    <Result>(operation: () => Promise<Result>): Promise<Result> => {
      if (retiringRef.current) return Promise.reject(new Error('Hold editor session is closing'));
      if (commitRef.current) return Promise.reject(new Error('A hold commit is already running'));
      cancelTimers();
      if (mountedRef.current) setCommitActive(true);
      const result = Promise.resolve().then(operation);
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      commitRef.current = settled;
      void settled.then(() => {
        if (commitRef.current === settled) {
          commitRef.current = null;
          if (mountedRef.current) setCommitActive(false);
        }
      });
      return result;
    },
    [cancelTimers],
  );

  const retirementRef = useRef<Promise<void> | null>(null);
  const retire = useCallback(() => {
    if (retirementRef.current) return retirementRef.current;
    retiringRef.current = true;
    cancelTimers();
    retiringCommitRef.current = commitRef.current !== null;
    const retirement = (async () => {
      try {
        const commit = commitRef.current;
        if (commit) await commit;
        // Publish flushed before starting its request. On unmount React cannot
        // reflect an acknowledged removal into latestRef; keep its checkpoint.
        else await flush();
      } finally {
        try {
          await operationsRef.current;
        } finally {
          retiredRef.current = true;
          cancelTimers();
        }
      }
    })();
    retirementRef.current = retirement;
    return retirement;
  }, [flush, cancelTimers]);

  useEffect(() => {
    if (
      !ready ||
      key === null ||
      loadedKeyRef.current !== key ||
      paused ||
      commitActive ||
      retiringRef.current ||
      retiredRef.current ||
      acknowledgedRef.current ||
      (!dirty && !hasRecoveryRef.current) ||
      (dirty && samePresent(savedPresentRef.current, present)) ||
      drainingRef.current !== null
    ) {
      cancelTimers();
      return;
    }
    if (deadlineKeyRef.current !== key || !dirty) cancelDeadline();
    publishStatus('saving');
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flush().catch(() => undefined);
    }, HOLD_AUTOSAVE_DELAY_MS);
    // This deadline belongs to the first unsaved edit, not this render. Only
    // the idle timer restarts when another completed stroke arrives. A flush
    // clears both timers, and its existing writer drains any edits made while
    // storage is slow rather than queuing periodic copies of the same work.
    if (dirty && maxWaitTimerRef.current === null) {
      deadlineKeyRef.current = key;
      maxWaitTimerRef.current = setTimeout(() => {
        maxWaitTimerRef.current = null;
        deadlineKeyRef.current = null;
        void flush().catch(() => undefined);
      }, HOLD_AUTOSAVE_MAX_WAIT_MS);
    }
    return cancelIdleTimer;
  }, [
    ready,
    key,
    present,
    dirty,
    paused,
    commitActive,
    restoreEpoch,
    flush,
    cancelTimers,
    cancelIdleTimer,
    cancelDeadline,
    publishStatus,
  ]);

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
      cancelTimers();
      if (retiringRef.current && !commitRef.current) throw new Error('Hold editor session is closing');
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
    [cancelTimers, enqueue, publishStatus],
  );

  const acknowledge = useCallback(async () => {
    if (retiringRef.current && !commitRef.current) return;
    cancelTimers();
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
  }, [cancelTimers, enqueue, publishStatus]);

  const discardRecovery = useCallback(async () => {
    if (retiringRef.current) throw new Error('Hold editor session is closing');
    cancelTimers();
    const current = latestRef.current;
    if (!current.identity) return;
    await enqueue(() => clearSprayHoldDraft(current.identity!));
    loadedKeyRef.current = null;
    savedPresentRef.current = null;
    setRetryEpoch((epoch) => epoch + 1);
  }, [cancelTimers, enqueue]);

  // A new edit after a successful explicit save starts a fresh recovery record.
  useEffect(() => {
    if (!dirty) {
      acknowledgedRef.current = false;
    }
  }, [dirty]);

  const retry = useCallback(() => {
    if (loadedKeyRef.current !== key) setRetryEpoch((epoch) => epoch + 1);
    else void flush().catch(() => undefined);
  }, [key, flush]);

  return {
    ready: !identity || (ready && loadedKeyRef.current === key),
    status,
    committing: commitActive,
    flush,
    retire,
    runCommit,
    acknowledge,
    checkpointRemoved,
    discardRecovery,
    retry,
  };
}
