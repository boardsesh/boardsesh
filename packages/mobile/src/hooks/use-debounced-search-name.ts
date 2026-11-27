import { useCallback, useEffect, useMemo, useRef } from 'react';
import { normalizeSearchName } from '../lib/search-name';

type DebouncedSearchNameOptions = {
  scopeKey: string | null;
  name: string;
  onCommit: (name: string) => void;
  /** Playlist fields clear immediately; Climbs flushes on explicit clear/dismiss. */
  commitEmptyImmediately?: boolean;
  /**
   * `debounce` (default) commits once typing pauses for 300 ms. `throttle` commits
   * the first keystroke at once, then at most once per 300 ms while typing, and
   * always the last text: the list follows the field as the climber types.
   */
  pacing?: 'debounce' | 'throttle';
};

const NAME_COMMIT_INTERVAL_MS = 300;

/** Owns pending text, cancellation and finalization without duplicating committed search state. */
export function useDebouncedSearchName(options: DebouncedSearchNameOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const committedNameRef = useRef(options.name);
  committedNameRef.current = options.name;
  const pendingRef = useRef<{ scopeKey: string | null; name: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When the last commit landed, for `throttle`. Only a scheduled commit counts:
  // a clear or replace is the climber's explicit act, not typing.
  const lastScheduledCommitAtRef = useRef(Number.NEGATIVE_INFINITY);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
  }, []);
  useEffect(() => cancel, [options.scopeKey, cancel]);

  const read = useCallback(() => {
    const pending = pendingRef.current;
    return pending && pending.scopeKey === optionsRef.current.scopeKey ? pending.name : committedNameRef.current;
  }, []);

  const readCommitted = useCallback(() => committedNameRef.current, []);

  /** An external atomic search replacement already commits this name. */
  const replace = useCallback(
    (name: string) => {
      cancel();
      committedNameRef.current = name;
    },
    [cancel],
  );

  const flush = useCallback(() => {
    const pending = pendingRef.current;
    cancel();
    if (pending && pending.scopeKey === optionsRef.current.scopeKey) {
      committedNameRef.current = pending.name;
      optionsRef.current.onCommit(pending.name);
    }
    return committedNameRef.current;
  }, [cancel]);

  const commitScheduled = useCallback(() => {
    lastScheduledCommitAtRef.current = Date.now();
    flush();
  }, [flush]);

  const schedule = useCallback(
    (text: string) => {
      const name = normalizeSearchName(text);
      const { scopeKey, commitEmptyImmediately, pacing = 'debounce' } = optionsRef.current;
      if (pacing === 'throttle') {
        // A commit already waiting picks up this text when it fires.
        const timerWaiting = timerRef.current !== null && pendingRef.current?.scopeKey === scopeKey;
        if (!timerWaiting) cancel();
        pendingRef.current = { scopeKey, name };
        if (name === '' && commitEmptyImmediately) {
          flush();
          return;
        }
        if (timerWaiting) return;
        const sinceLastCommit = Date.now() - lastScheduledCommitAtRef.current;
        if (sinceLastCommit >= NAME_COMMIT_INTERVAL_MS) {
          commitScheduled();
        } else {
          timerRef.current = setTimeout(commitScheduled, NAME_COMMIT_INTERVAL_MS - sinceLastCommit);
        }
        return;
      }
      cancel();
      pendingRef.current = { scopeKey, name };
      if (name === '' && commitEmptyImmediately) {
        flush();
      } else {
        timerRef.current = setTimeout(flush, NAME_COMMIT_INTERVAL_MS);
      }
    },
    [cancel, flush, commitScheduled],
  );

  const clear = useCallback(() => {
    cancel();
    committedNameRef.current = '';
    optionsRef.current.onCommit('');
  }, [cancel]);

  return useMemo(
    () => ({ schedule, cancel, flush, clear, read, readCommitted, replace }),
    [schedule, cancel, flush, clear, read, readCommitted, replace],
  );
}
