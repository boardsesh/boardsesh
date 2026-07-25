import type { BoardName, HoldState, LitUpHoldsMap } from '@boardsesh/shared-schema';

export type HoldCode = number;
export type HoldColor = string;
export type HoldRenderStyle = 'circle' | 'above-marker';

export type HoldStateInfo = {
  /**
   * The LED colour. This is the ONLY field the Bluetooth encoders read (see
   * packages/shared/ble-protocol/src/aurora.ts) — it is what the physical wall
   * lights up, and climbers have strong expectations about it. Never retune it
   * for on-screen legibility; tune `displayColor` / `displayColorDark` instead.
   */
  name: HoldState;
  color: HoldColor;
  /** Screen-tuned colour used by every renderer. Falls back to `color`. */
  displayColor?: HoldColor;
  /**
   * Screen-tuned colour used by every renderer in dark mode only. Falls back to
   * `displayColor`, then `color`. Exists because a marker can need a different
   * value against a dark field than against a light one — see the MoonBoard
   * hand marker, which has to clear both the dark play field and the lightened
   * black hold art (issue #3885).
   */
  displayColorDark?: HoldColor;
  renderStyle?: HoldRenderStyle;
};

/** Colour scheme a hold marker is being rendered into. */
export type HoldColorScheme = 'light' | 'dark';

/**
 * The colour a renderer should draw a hold marker in. Never returns the raw LED
 * `color` when a screen-tuned value exists — the LED value is only correct for
 * driving hardware over BLE (issue #2202).
 */
export function getHoldDisplayColor(
  // Structural rather than `HoldStateInfo` so the shared render-config builder,
  // whose HoldStateRecord has an optional `name`, can call it too.
  stateInfo: { color: HoldColor; displayColor?: HoldColor; displayColorDark?: HoldColor },
  colorScheme: HoldColorScheme = 'light',
): HoldColor {
  if (colorScheme === 'dark' && stateInfo.displayColorDark) return stateInfo.displayColorDark;
  return stateInfo.displayColor ?? stateInfo.color;
}

// Canonical mapping of board-specific hold role codes to their state and LED colors.
// Each board product has its own set of role codes.
export const HOLD_STATE_MAP: Record<BoardName, Record<HoldCode, HoldStateInfo>> = {
  kilter: {
    // Product 1 – Kilter Board Original
    12: { name: 'STARTING', color: '#00FF00' },
    13: { name: 'HAND', color: '#00FFFF' },
    14: { name: 'FINISH', color: '#FF00FF' },
    15: { name: 'FOOT', color: '#FFAA00' },
    // Product 2 – JUUL
    20: { name: 'STARTING', color: '#00FF00' },
    21: { name: 'HAND', color: '#00FFFF' },
    22: { name: 'FINISH', color: '#FF00FF' },
    23: { name: 'FOOT', color: '#FFA500' },
    // Product 3 – Demo Board
    24: { name: 'STARTING', color: '#00FF00' },
    25: { name: 'HAND', color: '#00FFFF' },
    26: { name: 'FINISH', color: '#FF00FF' },
    27: { name: 'FOOT', color: '#FFA500' },
    // Product 4 – BKB Board
    28: { name: 'STARTING', color: '#00FF00' },
    29: { name: 'HAND', color: '#00FFFF' },
    30: { name: 'FINISH', color: '#FF00FF' },
    31: { name: 'FOOT', color: '#FFA500' },
    // Product 5 – Spire
    32: { name: 'STARTING', color: '#00FF00' },
    33: { name: 'HAND', color: '#00FFFF' },
    34: { name: 'FINISH', color: '#FF00FF' },
    35: { name: 'FOOT', color: '#FFA500' },
    // Product 6 – Tycho (color mode, no start/finish semantics)
    36: { name: 'HAND', color: '#00FFFF' },
    37: { name: 'HAND', color: '#FF00FF' },
    38: { name: 'HAND', color: '#FFFF00' },
    39: { name: 'HAND', color: '#00FF00' },
    40: { name: 'HAND', color: '#FF0000' },
    41: { name: 'HAND', color: '#0000FF' },
    // Product 7 – Kilter Board Homewall
    42: { name: 'STARTING', color: '#00FF00' },
    43: { name: 'HAND', color: '#00FFFF' },
    44: { name: 'FINISH', color: '#FF00FF' },
    45: { name: 'FOOT', color: '#FFAA00' },
  },
  tension: {
    1: { name: 'STARTING', displayColor: '#00DD00', color: '#00FF00' },
    2: { name: 'HAND', displayColor: '#4444FF', color: '#0000FF' },
    3: { name: 'FINISH', displayColor: '#FF0000', color: '#FF0000' },
    4: { name: 'FOOT', displayColor: '#FF00FF', color: '#FF00FF' },
    5: { name: 'STARTING', displayColor: '#00DD00', color: '#00FF00' },
    6: { name: 'HAND', displayColor: '#4444FF', color: '#0000FF' },
    7: { name: 'FINISH', displayColor: '#FF0000', color: '#FF0000' },
    8: { name: 'FOOT', displayColor: '#FF00FF', color: '#FF00FF' },
  },
  // MoonBoard hold states (no foot holds in standard climbs)
  // Values 42-44 are used by saved MoonBoard climbs.
  // Values 45-48 are additional live-BLE preview roles emitted by the ESP32 dev firmware.
  moonboard: {
    42: { name: 'STARTING', color: '#00FF00', displayColor: '#44FF44' },
    // displayColorDark: #4444FF is only 3.05:1 against the dark play field, and
    // once the black MoonBoard hold art is lightened for dark mode (see
    // scripts/generate-dark-board-art.ts) a hand ring crossing one of those
    // holds loses its luminance separation entirely. #6E7DFF is 5.24:1 against
    // the field and stays 1.66:1 clear of the lightened art. The LED colour
    // (#0000FF) is untouched.
    43: { name: 'HAND', color: '#0000FF', displayColor: '#4444FF', displayColorDark: '#6E7DFF' },
    44: { name: 'FINISH', color: '#FF0000', displayColor: '#FF3333' },
    45: { name: 'FOOT', color: '#00FFFF', displayColor: '#66F0FF' },
    46: { name: 'AUX', color: '#FFE066', displayColor: '#FFE066', renderStyle: 'above-marker' },
    47: { name: 'HAND', color: '#8B5CF6', displayColor: '#C084FC' },
    48: { name: 'HAND', color: '#FF4FA3', displayColor: '#FF7DBB' },
  },
  // New Aurora boards use the same 1/2/3/4 role codes as Tension-style layouts.
  decoy: {
    1: { name: 'STARTING', displayColor: '#00DD00', color: '#00FF00' },
    2: { name: 'HAND', displayColor: '#0000FF', color: '#0000FF' },
    3: { name: 'FINISH', displayColor: '#FF0000', color: '#FF0000' },
    4: { name: 'FOOT', displayColor: '#FF00FF', color: '#FF00FF' },
  },
  touchstone: {
    1: { name: 'STARTING', displayColor: '#00DD00', color: '#00FF00' },
    2: { name: 'HAND', displayColor: '#4444FF', color: '#0000FF' },
    3: { name: 'FINISH', displayColor: '#FF0000', color: '#FF0000' },
    4: { name: 'FOOT', displayColor: '#FF00FF', color: '#FF00FF' },
  },
  grasshopper: {
    1: { name: 'STARTING', displayColor: '#00DD00', color: '#00FF00' },
    2: { name: 'HAND', displayColor: '#4455FF', color: '#0000FF' },
    3: { name: 'FINISH', displayColor: '#FF0000', color: '#FF0000' },
    4: { name: 'FOOT', displayColor: '#FF00FF', color: '#FF00FF' },
  },
  soill: {
    1: { name: 'STARTING', displayColor: '#00DD00', color: '#00FF00' },
    2: { name: 'HAND', displayColor: '#4444FF', color: '#0000FF' },
    3: { name: 'FINISH', displayColor: '#FF0000', color: '#FF0000' },
    4: { name: 'FOOT', displayColor: '#FF00FF', color: '#FF00FF' },
  },
};

// The canonical role code used when *writing* frame strings for each board.
// Boards with multiple products (e.g., Kilter Products 1-7) share the same
// state names but use different numeric codes per product. This map picks a
// single canonical code per state that matches what the Aurora API and BLE
// protocol expect. These cannot be derived from HOLD_STATE_MAP automatically
// because "which product is canonical" varies by board.
export const STATE_TO_PRIMARY_CODE: Record<BoardName, Partial<Record<HoldState, HoldCode>>> = {
  // Product 7 – Kilter Board Homewall (current canonical product)
  kilter: { STARTING: 42, HAND: 43, FINISH: 44, FOOT: 45 },
  // Product 1 – Tension (canonical)
  tension: { STARTING: 1, HAND: 2, FINISH: 3, FOOT: 4 },
  // MoonBoard (codes 42-44 are the saved-climb codes; 45-48 are BLE preview only)
  moonboard: { STARTING: 42, HAND: 43, FINISH: 44 },
  decoy: { STARTING: 1, HAND: 2, FINISH: 3, FOOT: 4 },
  touchstone: { STARTING: 1, HAND: 2, FINISH: 3, FOOT: 4 },
  grasshopper: { STARTING: 1, HAND: 2, FINISH: 3, FOOT: 4 },
  soill: { STARTING: 1, HAND: 2, FINISH: 3, FOOT: 4 },
};

export type BoardRenderDefaults = {
  /**
   * Multiplies the Rust/native renderer's base hold-outline stroke width
   * (clamped 0.5–2.0 by the renderer itself — see
   * packages/board-renderer/core/src/renderer.rs). Boards whose physical
   * photo is darker/busier than Kilter's benefit from a heavier default
   * outline so lit holds stay legible against the board art (issue #2202).
   * Absent boards render at the renderer's own default of 1.0 (unchanged).
   */
  strokeWidthMultiplier?: number;
};

// Per-board default render tuning, layered on top of HOLD_STATE_MAP's
// per-hold colors. 1.35 (35% thicker default outline) is a starting point
// pending a visual pass — tune here, no renderer changes required.
export const BOARD_RENDER_DEFAULTS: Partial<Record<BoardName, BoardRenderDefaults>> = {
  grasshopper: { strokeWidthMultiplier: 1.35 },
};

export function getBoardStrokeWidthMultiplier(board: BoardName): number {
  return BOARD_RENDER_DEFAULTS[board]?.strokeWidthMultiplier ?? 1.0;
}

// Warned hold states to avoid log spam
const warnedHoldStates = new Set<string>();

/**
 * Split a comma-separated frames string into one delta per index.
 *
 * The Aurora frames format encodes multi-frame routes as a sequence of
 * delta frames separated by commas. Each delta contains:
 *   `p<hold>r<role>` — set a hold to a role
 *   `x<hold>` — turn a hold off (removed from the accumulated lit state)
 *
 * Aurora prefixes every frame after the first with a literal `"`
 * character (e.g. `p1r43,"x1p2r43,"x2p3r43`); strip it so consumers see a
 * clean delta. Frames are NOT self-contained snapshots — call
 * `accumulateFramesToMaps` to fold the deltas into per-frame lit-state
 * snapshots suitable for rendering or BLE.
 *
 * Returns an empty array for the empty string. Strips empty segments so
 * trailing commas don't produce phantom frames.
 */
export function splitFramesString(frames: string): string[] {
  if (!frames) return [];
  return frames
    .split(',')
    .map((segment) => (segment.startsWith('"') ? segment.slice(1) : segment))
    .filter((segment) => segment.length > 0);
}

/**
 * Tokenise a single frame-delta into `{ sets, offs }`. Order within the
 * frame is preserved so a `p1r43x1` sequence (set then off) behaves
 * predictably: the off wins.
 */
function tokeniseFrameDelta(
  frame: string,
): Array<{ kind: 'set'; holdId: number; roleCode: number } | { kind: 'off'; holdId: number }> {
  const tokens: Array<{ kind: 'set'; holdId: number; roleCode: number } | { kind: 'off'; holdId: number }> = [];
  // Matches either `p<digits>r<digits>` or `x<digits>` greedily across the frame.
  const re = /p(\d+)r(\d+)|x(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(frame)) !== null) {
    if (match[1] !== undefined && match[2] !== undefined) {
      tokens.push({ kind: 'set', holdId: Number(match[1]), roleCode: Number(match[2]) });
    } else if (match[3] !== undefined) {
      tokens.push({ kind: 'off', holdId: Number(match[3]) });
    }
  }
  return tokens;
}

/**
 * Fold a multi-frame Aurora route into per-frame accumulated snapshots.
 *
 * Each output map at index N is the cumulative lit-state after applying
 * deltas 0..N — holds stay lit across frames unless explicitly turned
 * off via an `x<holdId>` token. The first map (index 0) starts from an
 * empty board and applies frame 0's sets. For single-frame climbs this
 * is equivalent to `convertLitUpHoldsStringToMap(frames, board)[0]`.
 */
export function accumulateFramesToMaps(frames: string, board: BoardName): LitUpHoldsMap[] {
  const deltas = splitFramesString(frames);
  const result: LitUpHoldsMap[] = [];
  const accumulator: LitUpHoldsMap = {};
  for (const frame of deltas) {
    for (const token of tokeniseFrameDelta(frame)) {
      if (token.kind === 'off') {
        delete accumulator[token.holdId];
        continue;
      }
      const stateInfo = HOLD_STATE_MAP[board]?.[token.roleCode];
      if (!stateInfo) {
        const warnKey = `${board}:${token.roleCode}`;
        if (!warnedHoldStates.has(warnKey)) {
          warnedHoldStates.add(warnKey);
          console.warn(
            `HOLD_STATE_MAP is missing values for ${board} status code: ${token.roleCode} (this warning is only shown once per status code)`,
          );
        }
        accumulator[token.holdId] = {
          state: `${token.holdId}=${token.roleCode}` as HoldState,
          color: '#FFF',
          displayColor: '#FFF',
        };
        continue;
      }
      const { name, color, displayColor } = stateInfo;
      accumulator[token.holdId] = { state: name, color, displayColor: displayColor || color };
    }
    // Snapshot the accumulator — a shallow copy is enough since the inner
    // `LitupHold` objects are never mutated after creation.
    result.push({ ...accumulator });
  }
  return result;
}

/**
 * Build BLE-ready single-frame strings from accumulated lit-state maps.
 * The BLE encoder (`getAuroraBluetoothPacket`) doesn't understand `x`
 * tokens or commas, so we re-emit the snapshot as a flat sequence of
 * `p<id>r<role>` pairs using each board's canonical role code per state.
 */
export function accumulatedMapsToFrameStrings(maps: LitUpHoldsMap[], board: BoardName): string[] {
  const stateToCode = STATE_TO_PRIMARY_CODE[board];
  return maps.map((map) => {
    let out = '';
    for (const [holdIdKey, hold] of Object.entries(map)) {
      const code = stateToCode?.[hold.state];
      if (code === undefined) continue;
      out += `p${holdIdKey}r${code}`;
    }
    return out;
  });
}

/**
 * Convert lit up holds string to a map of frames.
 * Each frame maps hold IDs to their state, color, and display color.
 */
export function convertLitUpHoldsStringToMap(litUpHolds: string, board: BoardName): Record<number, LitUpHoldsMap> {
  return litUpHolds
    .split(',')
    .filter((frame) => frame)
    .reduce(
      (frameMap, frameString, frameIndex) => {
        const frameHoldsMap = Object.fromEntries(
          frameString
            .split('p')
            .filter((hold) => hold)
            .map((holdData) => holdData.split('r').map((str) => Number(str)))
            .map(([holdId, stateCode]) => {
              const stateInfo = HOLD_STATE_MAP[board]?.[stateCode];
              if (!stateInfo) {
                const warnKey = `${board}:${stateCode}`;
                if (!warnedHoldStates.has(warnKey)) {
                  warnedHoldStates.add(warnKey);
                  console.warn(
                    `HOLD_STATE_MAP is missing values for ${board} status code: ${stateCode} (this warning is only shown once per status code)`,
                  );
                }
                return [
                  holdId || 0,
                  {
                    state: `${holdId}=${stateCode}` as HoldState,
                    color: '#FFF',
                    displayColor: '#FFF',
                  },
                ];
              }
              const { name, color, displayColor } = stateInfo;
              return [holdId, { state: name, color, displayColor: displayColor || color }];
            }),
        );
        frameMap[frameIndex] = frameHoldsMap as LitUpHoldsMap;
        return frameMap;
      },
      {} as Record<number, LitUpHoldsMap>,
    );
}

/** Collapse a possibly multi-frame frames string to its final lit snapshot. */
export function toFlatFrames(frames: string | null | undefined, board: BoardName): string {
  if (!frames) return '';
  if (!frames.includes(',') && !frames.includes('x')) return frames;
  const maps = accumulateFramesToMaps(frames, board);
  return accumulatedMapsToFrameStrings(maps, board).at(-1) ?? '';
}
