import { useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';
import { addErrorBreadcrumb } from './error-reporting';

export const PLAY_DRAWER_SECTION_IDS = [
  'logbook',
  'climberLogs',
  'setterNotes',
  'betaVideos',
  'boardseshGrade',
  'community',
  'similarClimbs',
] as const;
export type PlayDrawerSectionId = (typeof PLAY_DRAWER_SECTION_IDS)[number];
export type PlayDrawerSectionsVisibility = Readonly<Record<PlayDrawerSectionId, boolean>>;

export const DEFAULT_PLAY_DRAWER_SECTIONS: PlayDrawerSectionsVisibility = Object.freeze({
  logbook: true,
  climberLogs: true,
  setterNotes: true,
  betaVideos: true,
  boardseshGrade: true,
  community: true,
  similarClimbs: true,
});
const STORAGE_KEY = 'playDrawerSections';
type Snapshot = { sections: PlayDrawerSectionsVisibility; ready: boolean };
const SERVER_SNAPSHOT: Snapshot = { sections: DEFAULT_PLAY_DRAWER_SECTIONS, ready: false };
let snapshot = SERVER_SNAPSHOT;
let loadedSuccessfully = false;
let loadPromise: Promise<void> | null = null;
let writeQueue = Promise.resolve();
const listeners = new Set<() => void>();
// A read retry can fill untouched fields without replacing choices made since launch.
const changedSections = new Set<PlayDrawerSectionId>();

function publish(sections: PlayDrawerSectionsVisibility, ready: boolean): void {
  snapshot = { sections, ready };
  for (const listener of listeners) listener();
}

function storedSections(stored: unknown): PlayDrawerSectionsVisibility {
  const sections = { ...DEFAULT_PLAY_DRAWER_SECTIONS };
  if (typeof stored !== 'object' || stored === null || !('version' in stored) || stored.version !== 1) return sections;
  if (!('sections' in stored) || typeof stored.sections !== 'object' || stored.sections === null) return sections;
  const storedVisibility = stored.sections;
  for (const sectionId of PLAY_DRAWER_SECTION_IDS) {
    const enabled = (storedVisibility as Record<string, unknown>)[sectionId];
    if (typeof enabled === 'boolean') sections[sectionId] = enabled;
  }
  return sections;
}

export function ensurePlayDrawerSectionsLoaded(): Promise<void> {
  if (loadedSuccessfully) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = getPreference<unknown>(STORAGE_KEY)
    .then((stored) => {
      const sections = { ...storedSections(stored) };
      for (const sectionId of changedSections) sections[sectionId] = snapshot.sections[sectionId];
      loadedSuccessfully = true;
      publish(sections, true);
    })
    .catch(() => {
      // iOS can lock storage before first unlock during a background launch.
      // Defaults remain usable; another mount retries without reporting an error.
      publish(snapshot.sections, true);
    })
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
}

function persist(): void {
  // Wait for an existing read to merge untouched fields, then serialize writes.
  const pendingRead = loadPromise;
  writeQueue = writeQueue
    .then(async () => {
      await pendingRead;
      await setPreference(STORAGE_KEY, { version: 1, sections: snapshot.sections });
    })
    .catch(() => {
      addErrorBreadcrumb({
        category: 'preferences',
        message: 'Climb drawer preferences could not be saved',
        level: 'warning',
      });
    });
}

export function setPlayDrawerSection(sectionId: PlayDrawerSectionId, enabled: boolean): void {
  if (!loadedSuccessfully && !loadPromise) void ensurePlayDrawerSectionsLoaded();
  changedSections.add(sectionId);
  publish({ ...snapshot.sections, [sectionId]: enabled }, snapshot.ready);
  persist();
}

export function setAllPlayDrawerSections(enabled: boolean): void {
  if (!loadedSuccessfully && !loadPromise) void ensurePlayDrawerSectionsLoaded();
  const sections = { ...snapshot.sections };
  for (const sectionId of PLAY_DRAWER_SECTION_IDS) {
    changedSections.add(sectionId);
    sections[sectionId] = enabled;
  }
  publish(sections, snapshot.ready);
  persist();
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
} {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    void ensurePlayDrawerSectionsLoaded();
  }, []);
  return { ...current, setSection: setPlayDrawerSection, setAll: setAllPlayDrawerSections };
}
