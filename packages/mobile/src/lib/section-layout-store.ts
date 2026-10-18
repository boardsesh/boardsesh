import { useSyncExternalStore } from 'react';
import { subscribeSettings } from '../settings/hooks';
import {
  isSameSectionLayout,
  sanitiseSectionLayout,
  withAllSectionsVisible,
  withSectionMoved,
  withSectionVisible,
  type SectionLayout,
  type SectionLayoutRecord,
  type SectionLayoutSpec,
  type SectionMoveDirection,
} from './section-layout';

// A section layout kept in the SYNCHRONOUS settings store (MMKV), so the answer
// is known before the first frame: no loading state, and no hidden section
// mounting (and starting its queries) while storage answers.
//
// Each store keeps its own snapshot and listeners instead of going through
// `useSetting`, whose cache hands an object-valued key a new identity on every
// unrelated setting write. Here the layout only changes identity when it
// changes.
//
// A layout equal to the defaults is stored as `null`, so a climber who never
// customised (or restored the defaults) follows a later release's defaults.

export type SectionLayoutStorage = {
  /** The stored record, read synchronously. */
  read: () => unknown;
  write: (record: SectionLayoutRecord | null) => void;
};

export type SectionLayoutStore<Id extends string> = {
  getLayout: () => SectionLayout<Id>;
  subscribe: (listener: () => void) => () => void;
  setVisible: (sectionId: Id, visible: boolean) => void;
  /** Show all (`true`) or Hide all (`false`). */
  setAllVisible: (visible: boolean) => void;
  move: (sectionId: Id, direction: SectionMoveDirection) => void;
  /** Takes a whole layout at once, such as a preset. */
  apply: (layout: SectionLayout<Id>) => void;
  restoreDefaults: () => void;
};

/**
 * One store per settings key, created at module scope:
 *
 * ```ts
 * export const homeSectionsStore = createSectionLayoutStore({
 *   spec: HOME_SECTIONS,
 *   read: () => getSetting('homeSectionsV1'),
 *   write: (record) => setSetting('homeSectionsV1', record),
 * });
 * ```
 */
export function createSectionLayoutStore<Id extends string>({
  spec,
  read,
  write,
}: { spec: SectionLayoutSpec<Id> } & SectionLayoutStorage): SectionLayoutStore<Id> {
  const listeners = new Set<() => void>();

  function readStored(): { record: object | null; serialized: string | null } {
    let stored: unknown = null;
    try {
      stored = read();
    } catch {
      // An unreadable store reads as no record; the defaults stay usable.
    }
    if (typeof stored !== 'object' || stored === null || !('version' in stored) || stored.version !== 1) {
      return { record: null, serialized: null };
    }
    return { record: stored, serialized: JSON.stringify(stored) };
  }
  function layoutOf(record: object | null): SectionLayout<Id> {
    return record === null ? spec.defaults : sanitiseSectionLayout(spec, record);
  }

  const initial = readStored();
  let layout = layoutOf(initial.record);
  // What storage held when this store last looked, kept apart from `layout`: a
  // write that did not stick leaves memory ahead of storage, and that is fine.
  let seenSerialized = initial.serialized;

  function adopt(next: SectionLayout<Id>): void {
    if (isSameSectionLayout(next, layout)) return;
    layout = next;
    for (const listener of listeners) listener();
  }

  /**
   * Takes what changed in storage since the last look, such as a record the
   * first read missed. An unchanged storage leaves memory as it is, also when
   * memory is ahead because a write was lost. A reset of every setting is the
   * climber's choice, so it always wins.
   */
  function syncWithStorage(reset = false): void {
    const { record, serialized } = readStored();
    if (!reset && serialized === seenSerialized) return;
    seenSerialized = serialized;
    adopt(layoutOf(record));
  }

  function mutate(change: (current: SectionLayout<Id>) => SectionLayout<Id>): void {
    syncWithStorage();
    const next = change(layout);
    if (isSameSectionLayout(next, layout)) return;
    adopt(next);
    const record: SectionLayoutRecord | null = isSameSectionLayout(next, spec.defaults)
      ? null
      : { version: 1, order: [...next.order], visible: { ...next.visible } };
    try {
      write(record);
    } catch {
      // The settings store throws when its file cannot be written. The choice
      // stands in memory for this launch.
    }
    seenSerialized = readStored().serialized;
  }

  subscribeSettings((change) => {
    if (change.kind === 'reset') syncWithStorage(true);
  });

  return {
    getLayout: () => layout,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setVisible: (sectionId, visible) => mutate((current) => withSectionVisible(current, sectionId, visible)),
    setAllVisible: (visible) => mutate((current) => withAllSectionsVisible(current, visible)),
    move: (sectionId, direction) => mutate((current) => withSectionMoved(spec, current, sectionId, direction)),
    apply: (preset) => mutate(() => sanitiseSectionLayout(spec, preset)),
    restoreDefaults: () => mutate(() => spec.defaults),
  };
}

export function useSectionLayout<Id extends string>(store: SectionLayoutStore<Id>): SectionLayout<Id> {
  return useSyncExternalStore(store.subscribe, store.getLayout, store.getLayout);
}
