import { useCallback, useEffect, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import {
  getPrivacyCredentialGeneration,
  getPrivacyRevocationGeneration,
  subscribeToPrivacyRevocations,
} from '../lib/privacy/privacy-cache';

/** Composer instances must never carry typed input into another credential scope. */
export function usePrivacyCredentialScope(): number {
  return useSyncExternalStore(
    subscribeToPrivacyRevocations,
    getPrivacyCredentialGeneration,
    getPrivacyCredentialGeneration,
  );
}

/** Copied view payloads expire immediately; old async callbacks cannot restore them. */
export function usePrivacyScopedState<Content>(
  initial: Content | null | (() => Content | null) = null,
  withdraw?: (content: Content) => Content,
): [Content | null, Dispatch<SetStateAction<Content | null>>] {
  const generation = useSyncExternalStore(
    subscribeToPrivacyRevocations,
    getPrivacyRevocationGeneration,
    getPrivacyRevocationGeneration,
  );
  const [snapshot, setSnapshot] = useState(() => ({
    generation,
    credentialGeneration: getPrivacyCredentialGeneration(),
    content: typeof initial === 'function' ? (initial as () => Content | null)() : initial,
  }));
  const withdrawContent = (previous: typeof snapshot): Content | null =>
    previous.content !== null && previous.credentialGeneration === getPrivacyCredentialGeneration() && withdraw
      ? withdraw(previous.content)
      : null;
  useEffect(() => {
    setSnapshot((previous) =>
      previous.generation === generation
        ? previous
        : { generation, credentialGeneration: getPrivacyCredentialGeneration(), content: withdrawContent(previous) },
    );
  }, [generation, withdraw]);
  const setContent = useCallback<Dispatch<SetStateAction<Content | null>>>(
    (update) => {
      if (generation !== getPrivacyRevocationGeneration()) return;
      setSnapshot((previous) => {
        if (generation !== getPrivacyRevocationGeneration()) return previous;
        const current = previous.generation === generation ? previous.content : null;
        return {
          generation,
          credentialGeneration: getPrivacyCredentialGeneration(),
          content:
            typeof update === 'function' ? (update as (content: Content | null) => Content | null)(current) : update,
        };
      });
    },
    [generation],
  );
  return [snapshot.generation === generation ? snapshot.content : withdrawContent(snapshot), setContent];
}
