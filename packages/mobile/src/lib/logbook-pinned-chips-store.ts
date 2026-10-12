import { createPinnedChipsStore } from './pinned-chips-store';
import {
  LOGBOOK_DEFAULT_PINNED_CHIPS,
  LOGBOOK_PINNABLE_CHIP_CATALOG,
  type LogbookPinnableChipKind,
} from './logbook-pinnable-chips';

/** The preference-store key for the Logbook's pins. Never shared with another surface. */
export const LOGBOOK_PINNED_CHIPS_STORAGE_KEY = 'pinnedLogbookChips';

/**
 * Which Logbook capsules the climber has pinned. Device-global like the climbs
 * pins: a layout choice, so the same row shows on your own logbook and on
 * anyone else's. Unknown kinds in a stored payload drop out (the factory's
 * default normalize), so the catalog can grow without a migration.
 */
export const logbookPinnedChipsStore = createPinnedChipsStore<LogbookPinnableChipKind>({
  storageKey: LOGBOOK_PINNED_CHIPS_STORAGE_KEY,
  catalog: LOGBOOK_PINNABLE_CHIP_CATALOG,
  defaults: LOGBOOK_DEFAULT_PINNED_CHIPS,
});

export const useLogbookPinnedChips = logbookPinnedChipsStore.usePinnedChips;
