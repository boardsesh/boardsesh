import type { BoardName, HoldState, LitUpHoldsMap } from '@boardsesh/shared-schema';

export type HoldCode = number;
export type HoldColor = string;
export type HoldRenderStyle = 'circle' | 'above-marker';

export type HoldStateInfo = {
  name: HoldState;
  color: HoldColor;
  displayColor?: HoldColor;
  /**
   * Screen colour for the Boardsesh render mode only (issue #2202). Set on the
   * dark-blue HAND codes, whose #0000FF / #4444FF / #4455FF sits too close to
   * black to read as a lit hold once the veil darkens the wall around it — the
   * glow needs a colour with lightness of its own to separate from the field.
   * Absent means "Boardsesh draws this role exactly as classic does", which is
   * every other role on every board.
   *
   * Deliberately NOT a `displayColor` change: classic renders — the web SVG
   * surface, every already-cached overlay PNG, the hold-filter swatches — must
   * stay what they are, so the two palettes live side by side and
   * `getHoldDisplayColor` picks between them per render.
   */
  boardseshDisplayColor?: HoldColor;
  renderStyle?: HoldRenderStyle;
};

/** Which of the two hold palettes / drawings a render is asking for. */
export type BoardRenderMode = 'classic' | 'aura';

/**
 * The three fields the colour rule reads.
 *
 * A structural subset rather than the whole `HoldStateInfo` so the shared render
 * pipeline (`@boardsesh/board-render`), whose own hold-state record carries no
 * `name`, can call this instead of re-deriving the rule and drifting from it.
 */
export type HoldDisplayColorInput = Pick<HoldStateInfo, 'color' | 'displayColor' | 'boardseshDisplayColor'>;

/**
 * The screen colour for a hold state under a given render mode.
 *
 * `classic` is the long-standing `displayColor ?? color` rule, unchanged.
 * `boardsesh` prefers `boardseshDisplayColor` and falls back to that same rule,
 * so a role without a Boardsesh-specific colour draws identically in both.
 *
 * `color` is the LED value the Bluetooth encoders send to the wall and is never
 * the right thing to paint on screen where a display colour exists — it is the
 * last resort here only because Kilter's entries carry no `displayColor`.
 */
export function getHoldDisplayColor(info: HoldDisplayColorInput, mode: BoardRenderMode): string {
  if (mode === 'aura' && info.boardseshDisplayColor) return info.boardseshDisplayColor;
  return info.displayColor ?? info.color;
}

/**
 * The one Boardsesh-mode HAND blue (issue #2202). Every dark-blue HAND across
 * the Aurora-style boards resolves to this single hex, so the role reads the
 * same whichever of those walls you are on.
 *
 * MoonBoard is the deliberate exception — see `MOONBOARD_AURA_HAND`. The rule
 * this constant encodes is "lift the HAND off the wall", not "one blue
 * everywhere", and on a wall whose own holds are blue the two goals disagree.
 */
const BOARDSESH_HAND_BLUE = '#6980FF';

/**
 * Kilter's HAND cyan, and MoonBoard's Aura HAND.
 *
 * `BOARDSESH_HAND_BLUE` lifts a dark-blue HAND off a wall of neutral plywood
 * and grey-brown holds, which is every Aurora board. MoonBoard 2024's holds are
 * themselves blue, so there it lands blue-on-blue — the marker and the thing it
 * marks are the same hue, and the glow reads as part of the hold rather than as
 * a mark on it. This cyan is far enough round the wheel, and bright enough, to
 * separate from blue plastic under the veil.
 *
 * One constant shared by every board that needs it rather than a hex repeated
 * per board: a climber who owns a Kilter, a MoonBoard and a Grasshopper should
 * see one HAND colour, and this is the only way the code says so. Kilter's
 * colour-mode products (Tycho, codes 36-41) keep their own literals — 36 being
 * cyan is that palette's business, not this relationship's, and it must not
 * follow this constant if the HAND colour ever moves.
 *
 * Which boards take it is a measured question, not a taste one. The art says:
 * MoonBoard 2024's holds are #2f8bcb and Grasshopper's `flow` set is #058fca —
 * both mid-lightness azure, both a hue the Aura blue sits inside. Grasshopper's
 * other sets are neutral grey (#4d4a4a), so `flow` is what forces its hand.
 * Every remaining board's holds are plywood-neutral and keep the Aura blue.
 */
const KILTER_HAND_CYAN = '#00FFFF';

// Canonical mapping of board-specific hold role codes to their state and LED colors.
// Each board product has its own set of role codes.
export const HOLD_STATE_MAP: Record<BoardName, Record<HoldCode, HoldStateInfo>> = {
  kilter: {
    // Product 1 – Kilter Board Original
    12: { name: 'STARTING', color: '#00FF00' },
    13: { name: 'HAND', color: KILTER_HAND_CYAN },
    14: { name: 'FINISH', color: '#FF00FF' },
    15: { name: 'FOOT', color: '#FFAA00' },
    // Product 2 – JUUL
    20: { name: 'STARTING', color: '#00FF00' },
    21: { name: 'HAND', color: KILTER_HAND_CYAN },
    22: { name: 'FINISH', color: '#FF00FF' },
    23: { name: 'FOOT', color: '#FFA500' },
    // Product 3 – Demo Board
    24: { name: 'STARTING', color: '#00FF00' },
    25: { name: 'HAND', color: KILTER_HAND_CYAN },
    26: { name: 'FINISH', color: '#FF00FF' },
    27: { name: 'FOOT', color: '#FFA500' },
    // Product 4 – BKB Board
    28: { name: 'STARTING', color: '#00FF00' },
    29: { name: 'HAND', color: KILTER_HAND_CYAN },
    30: { name: 'FINISH', color: '#FF00FF' },
    31: { name: 'FOOT', color: '#FFA500' },
    // Product 5 – Spire
    32: { name: 'STARTING', color: '#00FF00' },
    33: { name: 'HAND', color: KILTER_HAND_CYAN },
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
    43: { name: 'HAND', color: KILTER_HAND_CYAN },
    44: { name: 'FINISH', color: '#FF00FF' },
    45: { name: 'FOOT', color: '#FFAA00' },
  },
  tension: {
    1: { name: 'STARTING', displayColor: '#00DD00', color: '#00FF00' },
    2: { name: 'HAND', displayColor: '#4444FF', boardseshDisplayColor: BOARDSESH_HAND_BLUE, color: '#0000FF' },
    3: { name: 'FINISH', displayColor: '#FF0000', color: '#FF0000' },
    4: { name: 'FOOT', displayColor: '#FF00FF', color: '#FF00FF' },
    5: { name: 'STARTING', displayColor: '#00DD00', color: '#00FF00' },
    6: { name: 'HAND', displayColor: '#4444FF', boardseshDisplayColor: BOARDSESH_HAND_BLUE, color: '#0000FF' },
    7: { name: 'FINISH', displayColor: '#FF0000', color: '#FF0000' },
    8: { name: 'FOOT', displayColor: '#FF00FF', color: '#FF00FF' },
  },
  // MoonBoard hold states (no foot holds in standard climbs)
  // Values 42-44 are used by saved MoonBoard climbs.
  // Values 45-48 are additional live-BLE preview roles emitted by the ESP32 dev firmware.
  moonboard: {
    42: { name: 'STARTING', color: '#00FF00', displayColor: '#44FF44' },
    43: { name: 'HAND', color: '#0000FF', displayColor: '#4444FF', boardseshDisplayColor: KILTER_HAND_CYAN },
    44: { name: 'FINISH', color: '#FF0000', displayColor: '#FF3333' },
    45: { name: 'FOOT', color: '#00FFFF', displayColor: '#66F0FF' },
    46: { name: 'AUX', color: '#FFE066', displayColor: '#FFE066', renderStyle: 'above-marker' },
    47: { name: 'HAND', color: '#8B5CF6', displayColor: '#C084FC' },
    48: { name: 'HAND', color: '#FF4FA3', displayColor: '#FF7DBB' },
  },
  // New Aurora boards use the same 1/2/3/4 role codes as Tension-style layouts.
  decoy: {
    1: { name: 'STARTING', displayColor: '#00DD00', color: '#00FF00' },
    2: { name: 'HAND', displayColor: '#0000FF', boardseshDisplayColor: BOARDSESH_HAND_BLUE, color: '#0000FF' },
    3: { name: 'FINISH', displayColor: '#FF0000', color: '#FF0000' },
    4: { name: 'FOOT', displayColor: '#FF00FF', color: '#FF00FF' },
  },
  touchstone: {
    1: { name: 'STARTING', displayColor: '#00DD00', color: '#00FF00' },
    2: { name: 'HAND', displayColor: '#4444FF', boardseshDisplayColor: BOARDSESH_HAND_BLUE, color: '#0000FF' },
    3: { name: 'FINISH', displayColor: '#FF0000', color: '#FF0000' },
    4: { name: 'FOOT', displayColor: '#FF00FF', color: '#FF00FF' },
  },
  grasshopper: {
    1: { name: 'STARTING', displayColor: '#00DD00', color: '#00FF00' },
    2: { name: 'HAND', displayColor: '#4455FF', boardseshDisplayColor: KILTER_HAND_CYAN, color: '#0000FF' },
    3: { name: 'FINISH', displayColor: '#FF0000', color: '#FF0000' },
    4: { name: 'FOOT', displayColor: '#FF00FF', color: '#FF00FF' },
  },
  soill: {
    1: { name: 'STARTING', displayColor: '#00DD00', color: '#00FF00' },
    2: { name: 'HAND', displayColor: '#4444FF', boardseshDisplayColor: BOARDSESH_HAND_BLUE, color: '#0000FF' },
    3: { name: 'FINISH', displayColor: '#FF0000', color: '#FF0000' },
    4: { name: 'FOOT', displayColor: '#FF00FF', color: '#FF00FF' },
  },
  // Woods Board. The firmware derives each LED's colour from these role codes
  // (the wire format carries no colour); the codes match WOODS_WIRE_ROLE.
  woods: {
    // Magenta foot holds match every Aurora board — the hold-filter swatches read
    // their colour straight out of this map, and colour never goes on the wire.
    1: { name: 'FOOT', displayColor: '#FF00FF', color: '#FF00FF' },
    2: { name: 'HAND', displayColor: '#4444FF', boardseshDisplayColor: BOARDSESH_HAND_BLUE, color: '#0000FF' },
    3: { name: 'FINISH', displayColor: '#FF0000', color: '#FF0000' },
    4: { name: 'STARTING', displayColor: '#00DD00', color: '#00FF00' },
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
  // Woods wire role codes (spec §6): Foot 1, Hand 2, Finish 3, Start 4.
  woods: { STARTING: 4, HAND: 2, FINISH: 3, FOOT: 1 },
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

/** One comma-separated frame of an Aurora `frames` string. */
export type FrameSegment = {
  /**
   * `true` when the segment restates the climb's whole lit set (a snapshot),
   * `false` when it is a delta on the previous frame. Frame 0 is always
   * absolute — it starts from a dark board either way.
   */
  absolute: boolean;
  /** Frame body with the `"` delta marker removed. Empty for a hold frame. */
  body: string;
};

/**
 * Split a comma-separated frames string into typed frame segments.
 *
 * The Aurora frames format encodes multi-frame routes as comma-separated
 * frames. Each frame contains:
 *   `p<hold>r<role>` — set a hold to a role
 *   `x<hold>` — turn a hold off (removed from the accumulated lit state)
 *
 * **The leading `"` is meaningful, not noise.** A frame that starts with a
 * literal `"` is a *delta* on the previous frame; a frame after index 0 that
 * does NOT start with `"` is an *absolute snapshot* that restates the full
 * lit set from scratch. The legacy Aurora catalog contains both kinds —
 * 295 of the 709 multi-frame climbs carry at least one absolute frame — so
 * treating every frame as a delta leaves holds lit that the climb turned off
 * (issue #3947). Our own Kilter Grips importer emits `,"` unconditionally,
 * so climbs ingested through that path are pure delta.
 *
 * A `"`-only segment is a legitimate **hold frame**: a delta with no changes,
 * i.e. "keep the current lights for one more pace tick". It must be kept, or
 * the animation is shortened and every later frame index shifts.
 *
 * Frames are NOT self-contained maps — call `accumulateFramesToMaps` to fold
 * them into per-frame lit-state snapshots suitable for rendering or BLE.
 *
 * Returns an empty array for the empty string, and drops every empty
 * *unquoted* segment — a trailing or a doubled comma — because such a
 * segment would otherwise decode as an absolute snapshot that lights
 * nothing, i.e. a one-tick blackout of the whole wall. An empty *quoted*
 * segment is the hold frame described above and is kept.
 */
export function parseFramesSegments(frames: string): FrameSegment[] {
  if (!frames) return [];
  return frames
    .split(',')
    .map((segment, index) =>
      index > 0 && segment.startsWith('"')
        ? { absolute: false, body: segment.slice(1) }
        : { absolute: true, body: segment },
    )
    .filter((segment) => !segment.absolute || segment.body !== '');
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
 * Fold a multi-frame Aurora route into per-frame lit-state snapshots.
 *
 * Each output map at index N is what the board looks like on frame N:
 * a delta frame carries the previous snapshot forward (holds stay lit
 * unless an `x<holdId>` token turns them off); an absolute frame after
 * index 0 clears the accumulator first, because it restates the full lit
 * set itself. A `"`-only hold frame repeats the previous snapshot and
 * still counts as its own frame.
 *
 * There is one output map per comma-separated frame, so the length always
 * matches the climb's `frames_count`. For single-frame climbs this is
 * equivalent to `convertLitUpHoldsStringToMap(frames, board)[0]`.
 */
export function accumulateFramesToMaps(frames: string, board: BoardName): LitUpHoldsMap[] {
  const segments = parseFramesSegments(frames);
  const result: LitUpHoldsMap[] = [];
  let accumulator: LitUpHoldsMap = {};
  for (const [index, segment] of segments.entries()) {
    // An absolute frame restates the whole lit set, so nothing carries over.
    if (segment.absolute && index > 0) accumulator = {};
    for (const token of tokeniseFrameDelta(segment.body)) {
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
 * Encode per-frame lit-state snapshots into an Aurora `frames` string — the
 * write-side counterpart to `accumulateFramesToMaps`.
 *
 * Frame 0 always encodes absolute (`p<id>r<code>` concatenation, matching a
 * single-frame climb's flat format exactly — so a one-frame route's encoded
 * string is byte-for-byte what it always was). Every later frame is a delta
 * against the previous *decoded* snapshot: a hold present before but absent
 * now emits `x<id>`; a hold that is new or changed state emits `p<id>r<code>`;
 * an unchanged hold emits nothing. Two identical consecutive frames correctly
 * produce a bare `"` — the documented "hold frame" in `parseFramesSegments`
 * that repeats the previous snapshot for one more pace tick.
 *
 * `accumulateFramesToMaps(encodeMapsToFramesString(maps, board), board)`
 * round-trips `maps` (module the `{holdId}={code}` sentinel for role codes
 * `STATE_TO_PRIMARY_CODE` doesn't have a code for, which this function drops
 * the same way `generateFramesString` always has).
 */
export function encodeMapsToFramesString(maps: LitUpHoldsMap[], board: BoardName): string {
  const stateToCode = STATE_TO_PRIMARY_CODE[board];
  const encodeAbsolute = (map: LitUpHoldsMap): string =>
    Object.entries(map)
      .filter(([, hold]) => hold.state !== 'OFF')
      .flatMap(([holdId, hold]) => {
        const code = stateToCode?.[hold.state];
        return code === undefined ? [] : [`p${holdId}r${code}`];
      })
      .join('');

  if (maps.length === 0) return '';

  const segments = [encodeAbsolute(maps[0])];
  for (let index = 1; index < maps.length; index += 1) {
    const previous = maps[index - 1];
    const current = maps[index];
    const tokens: string[] = [];

    for (const holdId of Object.keys(previous)) {
      if (!(Number(holdId) in current)) tokens.push(`x${holdId}`);
    }
    for (const [holdId, hold] of Object.entries(current)) {
      if (hold.state === 'OFF') continue;
      const previousHold = previous[Number(holdId)];
      if (previousHold?.state === hold.state) continue;
      const code = stateToCode?.[hold.state];
      if (code === undefined) continue;
      tokens.push(`p${holdId}r${code}`);
    }

    segments.push(`"${tokens.join('')}`);
  }
  return segments.join(',');
}

/**
 * True when a decoded hold state is the `{holdId}={code}` sentinel that
 * `accumulateFramesToMaps` emits for a role code missing from
 * `HOLD_STATE_MAP`, rather than a real hold state.
 *
 * The predicate lives here, next to the code that produces the sentinel, so
 * the readers that drop those rows (`shared-sync.ts`, `climb-similarity.ts`,
 * `backfill-board-climb-holds.ts`) share one definition instead of each
 * re-deriving "contains an `=`" from the shape.
 */
export function isSentinelHoldState(state: string | null | undefined): boolean {
  return !state || state.includes('=');
}

/**
 * Convert a frames string into a map of frame index → lit-state snapshot.
 * Each frame maps hold IDs to their state, color, and display color.
 *
 * This was a second parser for the same string: it split on `p` and then on
 * `r`, so it understood neither the `x` off-token nor the `"` delta marker.
 * On `"x1192p1370r13` the first element is `'"x1192'`, `Number(...)` gives
 * `NaN`, and the unknown-code branch emitted a phantom `hold_id 0` with the
 * state `NaN=undefined` (issue #3948). It now delegates to
 * `accumulateFramesToMaps` — one grammar, one parser.
 *
 * Single-frame strings (99.9% of the catalog, and every caller that reads
 * index `[0]`, since frame 0 is always absolute) produce identical output.
 * Unknown role codes still get the `{holdId}={code}` sentinel that
 * `climb-similarity.ts` and `backfill-board-climb-holds.ts` filter on.
 */
export function convertLitUpHoldsStringToMap(litUpHolds: string, board: BoardName): Record<number, LitUpHoldsMap> {
  const frameMap: Record<number, LitUpHoldsMap> = {};
  accumulateFramesToMaps(litUpHolds, board).forEach((map, frameIndex) => {
    frameMap[frameIndex] = map;
  });
  return frameMap;
}

/**
 * Collapse every frame of a route into one snapshot: a hold is lit if any
 * frame lights it, and the last frame to set it wins the role.
 *
 * This is what a *static* render of a multi-frame climb should show — a
 * thumbnail, a share card, a kiosk tile, the ESP32's steady LED state.
 * Picking a single frame instead shows a fragment: for an animation no one
 * frame is the climb, and for a route/circuit the last frame has already
 * dropped every hold an earlier `x` token cleared.
 *
 * It is a real visual change for the 709 multi-frame climbs in the catalog
 * (0.11%): 611 of them render busier than they used to, none sparser, and
 * the median goes from 20 lit holds to 42. Nothing else in the catalog moves.
 */
export function flattenFramesToUnion(maps: LitUpHoldsMap[]): LitUpHoldsMap {
  const union: LitUpHoldsMap = {};
  for (const map of maps) Object.assign(union, map);
  return union;
}

/** Collapse a possibly multi-frame frames string to one static snapshot. */
export function toFlatFrames(frames: string | null | undefined, board: BoardName): string {
  if (!frames) return '';
  if (!frames.includes(',') && !frames.includes('x')) return frames;
  const union = flattenFramesToUnion(accumulateFramesToMaps(frames, board));
  return accumulatedMapsToFrameStrings([union], board)[0] ?? '';
}
