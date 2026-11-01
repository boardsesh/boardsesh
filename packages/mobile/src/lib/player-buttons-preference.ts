import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { getSetting, hasSetting, setSetting, subscribeSettings, useSetting } from '../settings/hooks';
import {
  isSameSectionLayout,
  sanitiseSectionLayout,
  unknownSectionVisibility,
  withUnknownSectionsKept,
  type SectionLayoutRecord,
  type SectionLayoutSpec,
  type SectionMoveDirection,
} from './section-layout';
import { createSectionLayoutStore, useSectionLayout } from './section-layout-store';
import {
  DEFAULT_PLAYER_BOARD_CONTROL,
  DEFAULT_PLAYER_BUTTONS,
  DEFAULT_PLAYER_BUTTONS_POSITION,
  DEFAULT_PLAYER_PREVIOUS_NEXT,
  PLAYER_BUTTONS_LAYOUT,
  sanitisePlayerBoardControl,
  sanitisePlayerButtonsPosition,
  sanitisePlayerPreviousNext,
  type PlayerBoardControl,
  type PlayerButtonId,
  type PlayerButtonsLayout,
  type PlayerButtonsPosition,
} from './player-buttons';

// The climber's player buttons, kept in the synchronous settings store (MMKV),
// so the bar is drawn right on its first frame: no jump from today's bar to
// theirs. Device-local, like the sections below the climb.
//
// Three keys: the buttons' order and switches (`playerButtonsV3`, `null` while
// they match the defaults, so a later release's defaults still reach a climber
// who never changed them), the Previous and next switch, and the position.
// `resetAllSettings` clears them. V2's order, switches and board-control choice
// are imported once before the first snapshot; V2 itself is kept for rollback.

// Freeze the old defaults: filling an omitted switch with today's defaults
// would turn a legacy hidden Share or Angle on during migration.
const LEGACY_PLAYER_BUTTONS: PlayerButtonsLayout = {
  order: ['mirror', 'favorite', 'queue', 'share', 'angle'],
  visible: { mirror: true, favorite: true, queue: true, share: false, angle: false },
};
const LEGACY_PLAYER_BUTTONS_LAYOUT: SectionLayoutSpec<PlayerButtonId> = {
  ids: LEGACY_PLAYER_BUTTONS.order,
  defaults: LEGACY_PLAYER_BUTTONS,
};

type PlayerButtonsRecord = (SectionLayoutRecord & { readonly boardControl?: string }) | null;

function legacyPlayerButtonsRecord(): PlayerButtonsRecord {
  const stored: unknown = getSetting('playerButtonsV2');
  if (typeof stored !== 'object' || stored === null || !('version' in stored) || stored.version !== 1) return null;
  const record = stored as { order?: unknown; visible?: unknown; boardControl?: unknown };
  const boardControl = sanitisePlayerBoardControl(record.boardControl);
  const buttons = sanitiseSectionLayout(LEGACY_PLAYER_BUTTONS_LAYOUT, record);
  const order = withUnknownSectionsKept(LEGACY_PLAYER_BUTTONS_LAYOUT, buttons.order, record.order);
  const unknownVisible = unknownSectionVisibility(LEGACY_PLAYER_BUTTONS_LAYOUT, record.visible);
  const keepsUnknown = order.length > buttons.order.length || Object.keys(unknownVisible).length > 0;
  const migrated =
    !keepsUnknown && isSameSectionLayout(buttons, LEGACY_PLAYER_BUTTONS)
      ? null
      : { version: 1 as const, order, visible: { ...unknownVisible, ...buttons.visible } };
  return withBoardControl(migrated, boardControl);
}

// This runs at store initialization, never from a React render or getSnapshot.
// Keep the computed choice for this launch if a disk write fails.
let unwrittenMigration: PlayerButtonsRecord | undefined;
try {
  if (!hasSetting('playerButtonsV3')) {
    unwrittenMigration = legacyPlayerButtonsRecord();
    setSetting('playerButtonsV3', unwrittenMigration);
    unwrittenMigration = undefined;
  }
} catch {
  // The new defaults remain usable if the old store cannot be read either.
}
subscribeSettings((change) => {
  if (change.kind === 'reset' || change.key === 'playerButtonsV3') unwrittenMigration = undefined;
});

function readPlayerButtonsRecord(): unknown {
  return unwrittenMigration === undefined ? getSetting('playerButtonsV3') : unwrittenMigration;
}

/** The stored choice. A record the section store would ignore (another version, not a record) reads as the default. */
function readBoardControl(): PlayerBoardControl {
  try {
    const record = readPlayerButtonsRecord();
    if (typeof record !== 'object' || record === null || !('version' in record) || record.version !== 1) {
      return DEFAULT_PLAYER_BOARD_CONTROL;
    }
    return sanitisePlayerBoardControl('boardControl' in record ? record.boardControl : undefined);
  } catch {
    return DEFAULT_PLAYER_BOARD_CONTROL;
  }
}

// The board control rides the buttons' record (#7000). The section store only
// knows order and switches, so its writes carry the choice across: a layout
// back on its defaults stays a record while the bulb is chosen.
export const playerButtonsStore = createSectionLayoutStore({
  spec: PLAYER_BUTTONS_LAYOUT,
  read: readPlayerButtonsRecord,
  write: (record) => setSetting('playerButtonsV3', withBoardControl(record, readBoardControl())),
});

function withBoardControl(
  record: SectionLayoutRecord | null,
  boardControl: PlayerBoardControl,
): (SectionLayoutRecord & { boardControl?: string }) | null {
  if (boardControl === DEFAULT_PLAYER_BOARD_CONTROL) {
    if (record === null) return null;
    const { order, visible } = record;
    return { version: 1, order, visible };
  }
  const base = record ?? {
    version: 1 as const,
    order: [...DEFAULT_PLAYER_BUTTONS.order],
    visible: { ...DEFAULT_PLAYER_BUTTONS.visible },
  };
  return { version: 1, order: base.order, visible: base.visible, boardControl };
}

/** Choose the wall button or the bulb, keeping the buttons' order and switches. */
export function setPlayerBoardControl(boardControl: PlayerBoardControl): void {
  if (readBoardControl() === boardControl) return;
  let stored: SectionLayoutRecord | null = null;
  try {
    const current = readPlayerButtonsRecord();
    if (typeof current === 'object' && current !== null && 'version' in current && current.version === 1) {
      const layout = current as { order?: unknown; visible?: unknown };
      const buttons = sanitiseSectionLayout(PLAYER_BUTTONS_LAYOUT, current);
      stored = {
        version: 1,
        order: withUnknownSectionsKept(PLAYER_BUTTONS_LAYOUT, buttons.order, layout.order),
        visible: { ...unknownSectionVisibility(PLAYER_BUTTONS_LAYOUT, layout.visible), ...buttons.visible },
      };
    }
  } catch {
    // An unreadable record reads as the defaults.
  }
  // Back on the wall button with the buttons on their defaults: `null` again,
  // so a later release's defaults still reach this climber.
  if (
    boardControl === DEFAULT_PLAYER_BOARD_CONTROL &&
    stored !== null &&
    isSameSectionLayout(sanitiseSectionLayout(PLAYER_BUTTONS_LAYOUT, stored), DEFAULT_PLAYER_BUTTONS) &&
    stored.order.length === DEFAULT_PLAYER_BUTTONS.order.length &&
    Object.keys(unknownSectionVisibility(PLAYER_BUTTONS_LAYOUT, stored.visible)).length === 0
  ) {
    stored = null;
  }
  setSetting('playerButtonsV3', withBoardControl(stored, boardControl));
}

function subscribeBoardControl(listener: () => void): () => void {
  return subscribeSettings(listener);
}

/** The wall button or the bulb. A primitive snapshot, so unrelated writes don't re-render. */
export function usePlayerBoardControl(): PlayerBoardControl {
  return useSyncExternalStore(subscribeBoardControl, readBoardControl, readBoardControl);
}

export type PlayerButtonsPreference = {
  buttons: PlayerButtonsLayout;
  previousNext: boolean;
  position: PlayerButtonsPosition;
  boardControl: PlayerBoardControl;
};

export function isDefaultPlayerButtons({
  buttons,
  previousNext,
  position,
  boardControl,
}: PlayerButtonsPreference): boolean {
  return (
    isSameSectionLayout(buttons, DEFAULT_PLAYER_BUTTONS) &&
    previousNext === DEFAULT_PLAYER_PREVIOUS_NEXT &&
    position === DEFAULT_PLAYER_BUTTONS_POSITION &&
    boardControl === DEFAULT_PLAYER_BOARD_CONTROL
  );
}

/** Restore today's bar below the board, with the wall button and navigation arrows hidden. */
export function restorePlayerButtonDefaults(): void {
  setPlayerBoardControl(DEFAULT_PLAYER_BOARD_CONTROL);
  playerButtonsStore.restoreDefaults();
  // Written only when they differ, so a restore doesn't wake every settings reader twice.
  if (sanitisePlayerPreviousNext(getSetting('playerPreviousNext')) !== DEFAULT_PLAYER_PREVIOUS_NEXT) {
    setSetting('playerPreviousNext', DEFAULT_PLAYER_PREVIOUS_NEXT);
  }
  if (sanitisePlayerButtonsPosition(getSetting('playerButtonsPosition')) !== DEFAULT_PLAYER_BUTTONS_POSITION) {
    setSetting('playerButtonsPosition', DEFAULT_PLAYER_BUTTONS_POSITION);
  }
}

/** What the player draws from. Re-renders only when one of the four changes. */
export function usePlayerButtonsPreference(): PlayerButtonsPreference {
  const buttons = useSectionLayout(playerButtonsStore);
  const boardControl = usePlayerBoardControl();
  const [storedPreviousNext] = useSetting('playerPreviousNext');
  const [storedPosition] = useSetting('playerButtonsPosition');
  const previousNext = sanitisePlayerPreviousNext(storedPreviousNext);
  const position = sanitisePlayerButtonsPosition(storedPosition);
  return useMemo(
    () => ({ buttons, previousNext, position, boardControl }),
    [buttons, previousNext, position, boardControl],
  );
}

/** The preference plus every way to change it, for View options and Settings. */
export function usePlayerButtonsEditor() {
  const preference = usePlayerButtonsPreference();
  const [, writePreviousNext] = useSetting('playerPreviousNext');
  const [, writePosition] = useSetting('playerButtonsPosition');
  const setVisible = useCallback(
    (buttonId: PlayerButtonId, visible: boolean) => playerButtonsStore.setVisible(buttonId, visible),
    [],
  );
  const move = useCallback(
    (buttonId: PlayerButtonId, direction: SectionMoveDirection) => playerButtonsStore.move(buttonId, direction),
    [],
  );
  return {
    ...preference,
    setVisible,
    move,
    setPreviousNext: writePreviousNext,
    setPosition: writePosition,
    setBoardControl: setPlayerBoardControl,
    restoreDefaults: restorePlayerButtonDefaults,
  };
}
