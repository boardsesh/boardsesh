import { useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';
import { addErrorBreadcrumb } from './error-reporting';
import {
  isSameSectionOrder,
  sanitiseSectionOrder,
  withSectionMoved,
  withUnknownSectionsKept,
  type SectionLayoutSpec,
  type SectionMoveDirection,
} from './section-layout';

/**
 * The sections below the fold: each has a switch and a place in the climber's
 * order. Active holds (#6290) leads the default order but starts switched off,
 * so the drawer opens as it always has; switched on, it is the peek at the fold.
 */
export const BELOW_FOLD_SECTION_IDS = [
  'activeHolds',
  'logbook',
  'climberLogs',
  'setterNotes',
  'betaVideos',
  'boardseshGrade',
  'community',
  'similarClimbs',
] as const;
/** Every section with a switch. All of them sit below the fold and take part in the order. */
export const PLAY_DRAWER_SECTION_IDS = BELOW_FOLD_SECTION_IDS;
export type BelowFoldSectionId = (typeof BELOW_FOLD_SECTION_IDS)[number];
export type PlayDrawerSectionId = (typeof PLAY_DRAWER_SECTION_IDS)[number];
export type PlayDrawerSectionsVisibility = Readonly<Record<PlayDrawerSectionId, boolean>>;

export const DEFAULT_PLAY_DRAWER_SECTIONS: PlayDrawerSectionsVisibility = Object.freeze({
  // Off, so the drawer looks as it always has until the climber asks for it.
  // A record saved before it existed has no key for it and reads as off.
  activeHolds: false,
  logbook: true,
  climberLogs: true,
  setterNotes: true,
  betaVideos: true,
  boardseshGrade: true,
  community: true,
  similarClimbs: true,
});
export const DEFAULT_PLAY_DRAWER_SECTION_ORDER: readonly BelowFoldSectionId[] = BELOW_FOLD_SECTION_IDS;
export const BELOW_FOLD_SECTION_LAYOUT: SectionLayoutSpec<BelowFoldSectionId> = {
  ids: BELOW_FOLD_SECTION_IDS,
  defaults: { order: DEFAULT_PLAY_DRAWER_SECTION_ORDER, visible: DEFAULT_PLAY_DRAWER_SECTIONS },
};

// One AsyncStorage record: `{ version: 1, sections, order? }`. `order` came after
// `sections` under the same version, so a bundle from before it still reads the
// switches. Such a bundle writes the record without `order`, which puts that
// climber's order back to the default; their switches survive. `order` is left
// out while it matches the default, so a later release's default order still
// reaches climbers who never moved anything. Fields, switches and ordered ids
// this bundle does not know are written back as they were read (an unknown id
// straight after the id it followed), so a newer bundle's additions survive an
// OTA rollback and this one's writes.
const STORAGE_KEY = 'playDrawerSections';
type Snapshot = {
  sections: PlayDrawerSectionsVisibility;
  order: readonly BelowFoldSectionId[];
  ready: boolean;
};
const SERVER_SNAPSHOT: Snapshot = {
  sections: DEFAULT_PLAY_DRAWER_SECTIONS,
  order: DEFAULT_PLAY_DRAWER_SECTION_ORDER,
  ready: false,
};
let snapshot = SERVER_SNAPSHOT;
let loadedSuccessfully = false;
let loadPromise: Promise<void> | null = null;
let writeQueue = Promise.resolve();
const listeners = new Set<() => void>();
// A read retry can fill untouched fields without replacing choices made since launch.
const changedSections = new Set<PlayDrawerSectionId>();
let changedOrder = false;
let lastReadRecord: Record<string, unknown> = {};

function publish({ sections, order }: Pick<Snapshot, 'sections' | 'order'>, ready: boolean): void {
  snapshot = { sections, order, ready };
  for (const listener of listeners) listener();
}

function storedRecord(stored: unknown): Record<string, unknown> | null {
  if (typeof stored !== 'object' || stored === null || !('version' in stored) || stored.version !== 1) return null;
  return stored as Record<string, unknown>;
}

function storedSectionsMap(record: Record<string, unknown> | null): Record<string, unknown> {
  const stored = record?.sections;
  return typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
}

function storedSections(record: Record<string, unknown> | null): PlayDrawerSectionsVisibility {
  const sections = { ...DEFAULT_PLAY_DRAWER_SECTIONS };
  const storedVisibility = storedSectionsMap(record);
  for (const sectionId of PLAY_DRAWER_SECTION_IDS) {
    const enabled = storedVisibility[sectionId];
    if (typeof enabled === 'boolean') sections[sectionId] = enabled;
  }
  return sections;
}

export function ensurePlayDrawerSectionsLoaded(): Promise<void> {
  if (loadedSuccessfully) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = getPreference<unknown>(STORAGE_KEY)
    .then((stored) => {
      const record = storedRecord(stored);
      const sections = { ...storedSections(record) };
      for (const sectionId of changedSections) sections[sectionId] = snapshot.sections[sectionId];
      const order = changedOrder ? snapshot.order : sanitiseSectionOrder(BELOW_FOLD_SECTION_LAYOUT, record?.order);
      lastReadRecord = record ?? {};
      loadedSuccessfully = true;
      publish({ sections, order }, true);
    })
    .catch(() => {
      // iOS can lock storage before first unlock during a background launch.
      // Defaults remain usable; another mount retries without reporting an error.
      publish(snapshot, true);
    })
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
}

/**
 * The switches to store: those this bundle does not know, as they were read,
 * and only the known ones that differ from their default. Like the order, a
 * switch left at its default is not written, so a later release's new default
 * (Active holds switched on, say) still reaches a climber who only changed
 * another switch.
 */
function sectionsToWrite(): Record<string, unknown> {
  const knownSectionIds: readonly string[] = PLAY_DRAWER_SECTION_IDS;
  const sections: Record<string, unknown> = {};
  for (const [sectionId, enabled] of Object.entries(storedSectionsMap(lastReadRecord))) {
    if (!knownSectionIds.includes(sectionId)) sections[sectionId] = enabled;
  }
  for (const sectionId of PLAY_DRAWER_SECTION_IDS) {
    const enabled = snapshot.sections[sectionId];
    if (enabled !== DEFAULT_PLAY_DRAWER_SECTIONS[sectionId]) sections[sectionId] = enabled;
  }
  return sections;
}

function recordToWrite(): Record<string, unknown> {
  const otherFields = { ...lastReadRecord };
  delete otherFields.order;
  const order = withUnknownSectionsKept(BELOW_FOLD_SECTION_LAYOUT, snapshot.order, lastReadRecord.order);
  return {
    ...otherFields,
    version: 1,
    sections: sectionsToWrite(),
    ...(isSameSectionOrder(order, DEFAULT_PLAY_DRAWER_SECTION_ORDER) ? {} : { order }),
  };
}

function persist(): void {
  // Wait for an existing read to merge untouched fields, then serialize writes.
  const pendingRead = loadPromise;
  writeQueue = writeQueue
    .then(async () => {
      await pendingRead;
      await setPreference(STORAGE_KEY, recordToWrite());
    })
    .catch(() => {
      addErrorBreadcrumb({
        category: 'preferences',
        message: 'Climb drawer preferences could not be saved',
        level: 'warning',
      });
    });
}

function loadBeforeWriting(): void {
  if (!loadedSuccessfully && !loadPromise) void ensurePlayDrawerSectionsLoaded();
}

export function setPlayDrawerSection(sectionId: PlayDrawerSectionId, enabled: boolean): void {
  loadBeforeWriting();
  changedSections.add(sectionId);
  publish({ order: snapshot.order, sections: { ...snapshot.sections, [sectionId]: enabled } }, snapshot.ready);
  persist();
}

/** Switches every section, or only `sectionIds` (the ones a screen lists), on or off. */
export function setAllPlayDrawerSections(
  enabled: boolean,
  sectionIds: readonly PlayDrawerSectionId[] = PLAY_DRAWER_SECTION_IDS,
): void {
  loadBeforeWriting();
  const sections = { ...snapshot.sections };
  for (const sectionId of sectionIds) {
    changedSections.add(sectionId);
    sections[sectionId] = enabled;
  }
  publish({ order: snapshot.order, sections }, snapshot.ready);
  persist();
}

/** Moves a below-the-fold section one place past its neighbour, hidden or not. False when it cannot move. */
export function movePlayDrawerSection(sectionId: BelowFoldSectionId, direction: SectionMoveDirection): boolean {
  const { order } = withSectionMoved(
    BELOW_FOLD_SECTION_LAYOUT,
    { order: snapshot.order, visible: snapshot.sections },
    sectionId,
    direction,
  );
  if (order === snapshot.order) return false;
  loadBeforeWriting();
  changedOrder = true;
  publish({ order, sections: snapshot.sections }, snapshot.ready);
  persist();
  return true;
}

export function restorePlayDrawerSectionDefaults(): void {
  loadBeforeWriting();
  for (const sectionId of PLAY_DRAWER_SECTION_IDS) changedSections.add(sectionId);
  changedOrder = true;
  publish({ sections: DEFAULT_PLAY_DRAWER_SECTIONS, order: DEFAULT_PLAY_DRAWER_SECTION_ORDER }, snapshot.ready);
  persist();
}

/** True while the switches and the order match a fresh install. */
export function isDefaultPlayDrawerLayout({ sections, order }: Pick<Snapshot, 'sections' | 'order'>): boolean {
  return (
    PLAY_DRAWER_SECTION_IDS.every((sectionId) => sections[sectionId] === DEFAULT_PLAY_DRAWER_SECTIONS[sectionId]) &&
    isSameSectionOrder(order, DEFAULT_PLAY_DRAWER_SECTION_ORDER)
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function getSnapshot(): Snapshot {
  return snapshot;
}
function getServerSnapshot(): Snapshot {
  return SERVER_SNAPSHOT;
}

export function usePlayDrawerSectionsPreference(): Snapshot & {
  setSection: typeof setPlayDrawerSection;
  setAll: typeof setAllPlayDrawerSections;
  move: typeof movePlayDrawerSection;
  restoreDefaults: typeof restorePlayDrawerSectionDefaults;
} {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    void ensurePlayDrawerSectionsLoaded();
  }, []);
  return {
    ...current,
    setSection: setPlayDrawerSection,
    setAll: setAllPlayDrawerSections,
    move: movePlayDrawerSection,
    restoreDefaults: restorePlayDrawerSectionDefaults,
  };
}
