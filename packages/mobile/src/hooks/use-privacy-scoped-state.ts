import { useCallback, useEffect, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { getCredentialGeneration, subscribeToCredentialChanges } from '../lib/privacy/privacy-cache';

/** Composer instances must never carry typed input into another credential scope. */
export function usePrivacyCredentialScope(): number {
  return useSyncExternalStore(subscribeToCredentialChanges, getCredentialGeneration, getCredentialGeneration);
}

/** Copied view payloads expire immediately; old async callbacks cannot restore them. */
export function usePrivacyScopedState<Content>(
  initial: Content | null | (() => Content | null) = null,
): [Content | null, Dispatch<SetStateAction<Content | null>>] {
  const generation = usePrivacyCredentialScope();
  const [snapshot, setSnapshot] = useState(() => ({
    generation,
    content: typeof initial === 'function' ? (initial as () => Content | null)() : initial,
  }));
  useEffect(() => {
    setSnapshot((previous) => (previous.generation === generation ? previous : { generation, content: null }));
  }, [generation]);
  const setContent = useCallback<Dispatch<SetStateAction<Content | null>>>(
    (update) => {
      if (generation !== getCredentialGeneration()) return;
      setSnapshot((previous) => {
        if (generation !== getCredentialGeneration()) return previous;
        const current = previous.generation === generation ? previous.content : null;
        return {
          generation,
          content:
            typeof update === 'function' ? (update as (content: Content | null) => Content | null)(current) : update,
        };
      });
    },
    [generation],
  );
  return [snapshot.generation === generation ? snapshot.content : null, setContent];
}
