import { useSyncExternalStore } from 'react';

// The suspicion (#7017) as its one owner (`CrewHolderSuspicionSync`) last
// published it. A store rather than a context so the owner mounts once, deep
// in the root layout under the auth, query, session and presence providers it
// reads; kept apart from the owner so the bulbs read it without those imports.
let suspectedHolderUserId: string | null = null;
const listeners = new Set<() => void>();

export function publishSuspectedCrewHolder(next: string | null): void {
  if (next === suspectedHolderUserId) return;
  suspectedHolderUserId = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readSuspectedCrewHolder(): string | null {
  return suspectedHolderUserId;
}

/** The suspected crewmate's user id, or `null` (also with no owner mounted). */
export function useSuspectedCrewHolder(): string | null {
  return useSyncExternalStore(subscribe, readSuspectedCrewHolder, readSuspectedCrewHolder);
}
