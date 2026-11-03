/**
 * MoonBoard link mode (#7220): how many phones a MoonBoard controller box
 * accepts at once.
 *
 * - `relay`: the original box. It takes one phone and stops advertising while
 *   connected, so the first phone keeps the board and every other phone lights
 *   climbs through it over the backend.
 * - `multi`: V3 onwards. Every phone can connect.
 */
export type MoonboardLinkMode = 'relay' | 'multi';

/** Where the effective mode came from; sent as `linkModeSource` in analytics. */
export type MoonboardLinkModeSource = 'person' | 'detected' | 'default';

export const MOONBOARD_LINK_MODES: readonly MoonboardLinkMode[] = ['relay', 'multi'];

/** Undetected boards (Android-only walls, shared system rows) default to Relay mode (owner, 2026-11-03). */
export const DEFAULT_MOONBOARD_LINK_MODE: MoonboardLinkMode = 'relay';

export function isMoonboardLinkMode(value: unknown): value is MoonboardLinkMode {
  return value === 'relay' || value === 'multi';
}

export type MoonboardLinkModeBoard = {
  boardType: string;
  moonboardLinkMode?: string | null;
  moonboardLinkDetected?: string | null;
};

export type ResolvedMoonboardLinkMode = { mode: MoonboardLinkMode; source: MoonboardLinkModeSource };

/**
 * The person's choice, then the detected value, then Relay mode.
 * Returns null for every board that is not a MoonBoard.
 */
export function resolveMoonboardLinkMode(board: MoonboardLinkModeBoard): ResolvedMoonboardLinkMode | null {
  if (board.boardType !== 'moonboard') return null;
  if (isMoonboardLinkMode(board.moonboardLinkMode)) return { mode: board.moonboardLinkMode, source: 'person' };
  if (isMoonboardLinkMode(board.moonboardLinkDetected)) {
    return { mode: board.moonboardLinkDetected, source: 'detected' };
  }
  return { mode: DEFAULT_MOONBOARD_LINK_MODE, source: 'default' };
}

/**
 * Detection from the write characteristic's CoreBluetooth properties bitmask
 * (iOS only; Android reports none).
 *
 * - 0x08 write, or 0x08|0x02 write+read (write-with-response only, the
 *   original box's 23-byte-MTU signature) → relay.
 * - 0x0C write + write-without-response (V3–V5) or 0x04
 *   write-without-response only (FabianRig DIY firmware) → multi.
 *
 * Anything else is unknown and returns null so the board keeps its default.
 */
export function detectMoonboardLinkMode(characteristicProperties: number | null | undefined): MoonboardLinkMode | null {
  if (characteristicProperties == null || !Number.isInteger(characteristicProperties)) return null;
  const WRITE = 0x08;
  const WRITE_WITHOUT_RESPONSE = 0x04;
  const write = (characteristicProperties & WRITE) !== 0;
  const withoutResponse = (characteristicProperties & WRITE_WITHOUT_RESPONSE) !== 0;
  if (write && !withoutResponse) return 'relay';
  if (withoutResponse) return 'multi';
  return null;
}

/**
 * A later detection may only move a board toward Relay mode: a box that once
 * looked single-phone stays single-phone. Returns the value to store, or null
 * when nothing should change.
 */
export function nextDetectedMoonboardLinkMode(
  current: string | null | undefined,
  detected: MoonboardLinkMode,
): MoonboardLinkMode | null {
  if (current === detected) return null;
  if (current === 'relay') return null;
  return detected;
}
