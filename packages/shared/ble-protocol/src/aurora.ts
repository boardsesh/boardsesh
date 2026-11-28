import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import { encodeAuroraClear, encodeAuroraEntries, type AuroraBoardName } from '@boardsesh/aurora-ble-protocol';
export {
  AURORA_BOARDS,
  type AuroraBoardName,
  checksum,
  wrapBytes,
  parseApiLevel,
  parseSerialNumber,
  parseBoardTypeFromDeviceName,
  isKilterBuiltBox,
  encodePositionV3,
  encodeColorV3,
  encodePositionAndColorV3,
  computeV2Scale,
  scaledColorV2,
  encodePositionAndColorV2,
} from '@boardsesh/aurora-ble-protocol';

export type HoldState = 'OFF' | 'STARTING' | 'FINISH' | 'HAND' | 'FOOT' | 'ANY' | 'NOT' | 'AUX';

/** LED placement positions: maps placement ID to LED position index. */
export type LedPlacements = Record<number, number>;

/**
 * Optional per-state hex colour overrides (`#rrggbb` or `rrggbb`). When a
 * frame's role code maps to one of these states, the override replaces the
 * canonical colour from `HOLD_STATE_MAP` for that LED only.
 */
export type LedColorOverrides = Partial<Record<HoldState, string>>;

// The colour encoders parseInt fixed 2-char slices, so only exactly six hex
// digits with an optional LEADING '#' produce valid bytes. Anchored so an
// interior '#' ("ab#cdef") is rejected — this keeps byte-for-byte parity with
// the Swift `sanitizedOverride`, which only strips a leading '#'.
const SIX_DIGIT_HEX_PATTERN = /^#?[0-9a-fA-F]{6}$/;

export type BluetoothPacketResult = {
  packet: Uint8Array;
  /** Placements in frames with no LED position for this board size */
  skippedPositionCount: number;
  /** Placements with an unrecognised role code (no colour) */
  skippedRoleCount: number;
  /** Total placement entries parsed from the frames string */
  totalPlacements: number;
  /**
   * True when every LED in a NON-EMPTY packet was encoded with all three colour
   * channels at zero — a valid packet that darks the whole wall.
   *
   * Only reachable on API v2. `scaledColorV2` is `floor(value * scale) >> 6`, so
   * any scale at or below 0.25 turns a saturated 255 channel into 0. The power
   * ladder walks 1.0 → 0.05 looking for the first rung whose total fits the 18 W
   * budget, and the 0.2 rung's computed power is always 0 — it therefore "fits"
   * for any climb, however dense. A busy climb on a bare-name (v2-defaulting)
   * Kilter box thus encodes a full-length packet of colourless LEDs: the wall
   * goes dark while `write()` resolves and the caller reports a successful send.
   *
   * Detects the all-or-nothing case only. A route that leaves a handful of LEDs
   * lit and zeroes the rest still reports `false` and still writes a near-dark
   * wall — a pre-existing hazard of the same ladder that this narrows but does
   * not close, since "how dark is too dark" is a product call rather than a
   * protocol one.
   *
   * Callers must treat this as a failed send, not a successful one. Always
   * `false` on v3 and for the empty / all-skipped results: v3 has no power
   * budget, so the only way its colour bytes reach zero is a caller-supplied
   * near-black `LedColorOverrides` value — the caller's own choice, not the
   * protocol overruling them.
   */
  allLedsDark: boolean;
  /** LEDs actually written into the packet (skipped placements excluded). */
  ledsWritten: number;
  /**
   * Of those, how many carry a non-zero colour. On v2 the gap between this and
   * `ledsWritten` is the power ladder dimming holds out of existence; it sizes
   * the partially-dark residual `allLedsDark` deliberately does not refuse.
   */
  ledsWithColour: number;
};

/** Compatibility adapter for Boardsesh's persisted frame strings and catalog colors. */
export const getAuroraBluetoothPacket = (
  frames: string,
  placementPositions: LedPlacements,
  boardName: AuroraBoardName,
  apiLevel: number = 3,
  colorOverrides?: LedColorOverrides,
): BluetoothPacketResult => {
  if (frames === '') {
    return {
      packet: encodeAuroraClear(apiLevel),
      skippedPositionCount: 0,
      skippedRoleCount: 0,
      totalPlacements: 0,
      allLedsDark: false,
      ledsWritten: 0,
      ledsWithColour: 0,
    };
  }
  // Pre-collect LED entries for v2 power scaling
  const ledEntries: Array<{ position: number; color: string }> = [];
  let skippedPositionCount = 0;
  let skippedRoleCount = 0;

  frames.split('p').forEach((frame) => {
    if (!frame) return;
    const [placement, role] = frame.split('r');
    const placementId = Number(placement);
    const ledPosition = placementPositions[placementId];

    if (ledPosition === undefined) {
      skippedPositionCount++;
      return;
    }

    const roleCode = Number(role);
    const state = HOLD_STATE_MAP[boardName]?.[roleCode];

    if (!state?.color) {
      skippedRoleCount++;
      return;
    }

    const overrideForState = colorOverrides?.[state.name];
    // Overrides arrive from app config; anything but 6-digit hex (shorthand
    // "#fff", a named color) would parseInt to NaN bytes in the colour
    // encoders and stream garbage to the wall. Fall back to the canonical
    // state colour instead of honouring a malformed override.
    const sanitizedOverride =
      overrideForState && SIX_DIGIT_HEX_PATTERN.test(overrideForState) ? overrideForState : undefined;
    const colorSource = sanitizedOverride ?? state.color;
    const color = colorSource.replace('#', '');
    ledEntries.push({ position: ledPosition, color });
  });

  const totalPlacements = ledEntries.length + skippedPositionCount + skippedRoleCount;

  // If every placement was skipped there's nothing to send — return an empty
  // packet so the caller can handle the full-miss case without an exception.
  if (ledEntries.length === 0) {
    return {
      packet: new Uint8Array(0),
      skippedPositionCount,
      skippedRoleCount,
      totalPlacements,
      allLedsDark: false,
      ledsWritten: 0,
      ledsWithColour: 0,
    };
  }

  const encoded = encodeAuroraEntries(ledEntries, { apiLevel, ledsPerHold: boardName === 'kilter' ? 2 : 1 });
  return {
    ...encoded,
    skippedPositionCount: skippedPositionCount + encoded.skippedPositionCount,
    skippedRoleCount,
    totalPlacements,
  };
};
