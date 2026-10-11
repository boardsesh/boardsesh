import type { BoardName } from '@boardsesh/shared-schema';
import type { LogbookEntry } from '@boardsesh/board-react';

export const NO_CLIMB_PROGRESS_ENTRIES: readonly LogbookEntry[] = Object.freeze([]);
export const climbProgressKey = (boardName: BoardName, climbUuid: string, angle: number): string =>
  `${boardName}:${climbUuid}:${angle}`;

/** One index per board batch; rows subscribe only to their own immutable bucket. */
export function createClimbProgressStore(generation: number, currentGeneration: () => number) {
  const buckets = new Map<string, readonly LogbookEntry[]>();
  const listeners = new Map<string, Set<() => void>>();
  const notify = (key: string) => listeners.get(key)?.forEach((listener) => listener());
  const clear = () => {
    const keys = [...buckets.keys()];
    buckets.clear();
    keys.forEach(notify);
  };
  return {
    clear,
    getSnapshot(key: string): readonly LogbookEntry[] {
      return generation === currentGeneration()
        ? (buckets.get(key) ?? NO_CLIMB_PROGRESS_ENTRIES)
        : NO_CLIMB_PROGRESS_ENTRIES;
    },
    subscribe(key: string, listener: () => void) {
      const subscribers = listeners.get(key) ?? new Set<() => void>();
      subscribers.add(listener);
      listeners.set(key, subscribers);
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) listeners.delete(key);
      };
    },
    publish(boardName: BoardName, entries: readonly LogbookEntry[]) {
      if (generation !== currentGeneration()) return;
      const next = new Map<string, LogbookEntry[]>();
      for (const entry of entries) {
        const key = climbProgressKey(boardName, entry.climb_uuid, entry.angle);
        const bucket = next.get(key);
        if (bucket) bucket.push(entry);
        else next.set(key, [entry]);
      }
      const prefix = `${boardName}:`;
      for (const key of buckets.keys()) {
        if (key.startsWith(prefix) && !next.has(key)) {
          buckets.delete(key);
          notify(key);
        }
      }
      for (const [key, bucket] of next) {
        const previous = buckets.get(key);
        if (previous?.length === bucket.length && previous.every((entry, index) => entry === bucket[index])) continue;
        buckets.set(key, Object.freeze(bucket));
        notify(key);
      }
    },
  };
}

export type ClimbProgressStore = ReturnType<typeof createClimbProgressStore>;
