import { useCallback, useEffect, useMemo, useRef } from 'react';
import { normalizeSearchName } from '../lib/search-name';

type DebouncedSearchNameOptions = {
  scopeKey: string | null;
  name: string;
  onCommit: (name: string) => void;
  /** Playlist fields clear immediately; Climbs flushes on explicit clear/dismiss. */
  commitEmptyImmediately?: boolean;
};

const NAME_DEBOUNCE_MS = 300;

/** Owns pending text, cancellation and finalization without duplicating committed search state. */
export function useDebouncedSearchName(options: DebouncedSearchNameOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const committedNameRef = useRef(options.name);
  committedNameRef.current = options.name;
  const pendingRef = useRef<{ scopeKey: string | null; name: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const schedule = useCallback(
    (text: string) => {
      cancel();
      const name = normalizeSearchName(text);
      pendingRef.current = { scopeKey: optionsRef.current.scopeKey, name };
      if (name === '' && optionsRef.current.commitEmptyImmediately) {
        flush();
      } else {
        timerRef.current = setTimeout(flush, NAME_DEBOUNCE_MS);
      }
    },
    [cancel, flush],
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
