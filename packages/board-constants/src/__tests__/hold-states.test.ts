import { describe, it, expect } from 'vite-plus/test';
import {
  HOLD_STATE_MAP,
  STATE_TO_PRIMARY_CODE,
  BOARD_RENDER_DEFAULTS,
  getBoardStrokeWidthMultiplier,
  getHoldDisplayColor,
  convertLitUpHoldsStringToMap,
  parseFramesSegments,
  accumulateFramesToMaps,
  accumulatedMapsToFrameStrings,
  encodeMapsToFramesString,
  flattenFramesToUnion,
  isSentinelHoldState,
  toFlatFrames,
} from '../hold-states';
import type { BoardName } from '@boardsesh/shared-schema';
import oracle from './__fixtures__/aurora-frames-oracle.json';

describe('HOLD_STATE_MAP', () => {
  const boards: BoardName[] = ['kilter', 'tension', 'moonboard', 'decoy', 'touchstone', 'grasshopper', 'soill'];

  it('has entries for every supported board', () => {
    for (const board of boards) {
      expect(HOLD_STATE_MAP[board]).toBeDefined();
      expect(Object.keys(HOLD_STATE_MAP[board]).length).toBeGreaterThan(0);
    }
  });

  it('every entry has a valid name and color', () => {
    const validStates = new Set(['OFF', 'STARTING', 'FINISH', 'HAND', 'FOOT', 'ANY', 'NOT', 'AUX']);
    for (const board of boards) {
      for (const [_code, info] of Object.entries(HOLD_STATE_MAP[board])) {
        expect(validStates).toContain(info.name);
        expect(info.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
        if (info.displayColor) {
          expect(info.displayColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
        }
      }
    }
  });
});

describe('getBoardStrokeWidthMultiplier', () => {
  it('boosts Grasshopper (issue #2202 — darker/busier board photo)', () => {
    expect(getBoardStrokeWidthMultiplier('grasshopper')).toBe(1.35);
  });

  it('defaults every other board to 1.0 (unchanged rendering)', () => {
    const boards: BoardName[] = ['kilter', 'tension', 'moonboard', 'decoy', 'touchstone', 'soill'];
    for (const board of boards) {
      expect(getBoardStrokeWidthMultiplier(board)).toBe(1.0);
    }
  });

  it('only Grasshopper has a render-defaults override, so other boards stay data-driven-empty', () => {
    expect(Object.keys(BOARD_RENDER_DEFAULTS)).toEqual(['grasshopper']);
  });
});

describe('getHoldDisplayColor', () => {
  const AURA_HAND_CYAN = '#4DF5FD';
  const RETIRED_AURA_BLUE = '#6980FF';

  /**
   * Every HAND that Aura repaints, with the Classic colour it must NOT disturb.
   *
   * One Aura colour on every board is the promise, so this is one table rather
   * than a per-board story: any board drifting off the shared cyan, or any board
   * whose Classic value moves because Aura's did, fails here.
   */
  const auraHands: [BoardName, number, string][] = [
    ['kilter', 13, '#00FFFF'],
    ['kilter', 21, '#00FFFF'],
    ['kilter', 25, '#00FFFF'],
    ['kilter', 29, '#00FFFF'],
    ['kilter', 33, '#00FFFF'],
    ['kilter', 43, '#00FFFF'],
    ['tension', 2, '#4444FF'],
    ['tension', 6, '#4444FF'],
    ['touchstone', 2, '#4444FF'],
    ['soill', 2, '#4444FF'],
    ['woods', 2, '#4444FF'],
    ['decoy', 2, '#0000FF'],
    ['moonboard', 43, '#4444FF'],
    ['grasshopper', 2, '#4455FF'],
  ];

  for (const [board, code, classicColor] of auraHands) {
    it(`${board} code ${code} draws the one Aura HAND cyan`, () => {
      const info = HOLD_STATE_MAP[board][code];
      expect(info.name).toBe('HAND');
      expect(getHoldDisplayColor(info, 'aura')).toBe(AURA_HAND_CYAN);
      expect(getHoldDisplayColor(info, 'aura')).not.toBe(RETIRED_AURA_BLUE);
    });

    it(`${board} code ${code} keeps its own colour in Classic`, () => {
      // The whole point of `boardseshDisplayColor` being a separate field:
      // Classic is what the original apps drew, and it must not move because
      // Aura did. Cached classic overlays and the hold-filter swatches read it.
      expect(getHoldDisplayColor(HOLD_STATE_MAP[board][code], 'classic')).toBe(classicColor);
    });
  }

  it('never lets the Aura cyan reach the wire', () => {
    // `packages/shared/ble-protocol/src/aurora.ts` transmits `color` to the
    // wall, so an Aura screen colour leaking into that field would change which
    // colour a physical board lights. Kilter's HAND wire value is its own
    // constant for exactly this reason; the two were briefly one constant, which
    // made retuning the palette a silent BLE change.
    for (const [board, states] of Object.entries(HOLD_STATE_MAP)) {
      for (const [code, info] of Object.entries(states)) {
        expect(info.color, `${board} code ${code} wire colour`).not.toBe(AURA_HAND_CYAN);
      }
    }
    expect(HOLD_STATE_MAP.kilter[13].color).toBe('#00FFFF');
  });

  it('retires the Aura blue completely', () => {
    for (const [board, states] of Object.entries(HOLD_STATE_MAP)) {
      for (const [code, info] of Object.entries(states)) {
        expect(info.boardseshDisplayColor, `${board} code ${code}`).not.toBe(RETIRED_AURA_BLUE);
      }
    }
  });

  it('leaves Kilter’s Tycho colour-mode codes out of it', () => {
    // 36-41 are a colour-mode palette where HAND comes in six colours; 36 being
    // cyan is that palette's business, and it must not follow the HAND colour.
    for (const code of [36, 37, 38, 39, 40, 41]) {
      const info = HOLD_STATE_MAP.kilter[code];
      expect(info.boardseshDisplayColor, `kilter code ${code}`).toBeUndefined();
      expect(getHoldDisplayColor(info, 'aura')).toBe(getHoldDisplayColor(info, 'classic'));
    }
  });

  it('falls back to displayColor then color when no Boardsesh override exists', () => {
    // Kilter's Tycho colour-mode codes carry no displayColor and no Aura
    // override, so `color` is the last resort for them.
    expect(getHoldDisplayColor(HOLD_STATE_MAP.kilter[38], 'aura')).toBe('#FFFF00');
    // Tension's FINISH has a displayColor and no override: both modes use it.
    expect(getHoldDisplayColor(HOLD_STATE_MAP.tension[3], 'aura')).toBe('#FF0000');
  });

  it('gives every Aura-repainted HAND an override, and nothing else', () => {
    // The list IS the promise: one Aura HAND colour on every board, and no role
    // other than HAND repainted. A new board arriving without its HAND here is
    // a board that silently keeps its Classic blue in Aura.
    const overridden: string[] = [];
    for (const [board, states] of Object.entries(HOLD_STATE_MAP)) {
      for (const [code, info] of Object.entries(states)) {
        if (info.boardseshDisplayColor) {
          expect(info.name, `${board} code ${code}`).toBe('HAND');
          overridden.push(`${board}:${code}`);
        }
      }
    }
    expect(overridden.sort()).toEqual(
      [
        'decoy:2',
        'grasshopper:2',
        'kilter:13',
        'kilter:21',
        'kilter:25',
        'kilter:29',
        'kilter:33',
        'kilter:43',
        'moonboard:43',
        'soill:2',
        'tension:2',
        'tension:6',
        'touchstone:2',
        'woods:2',
      ].sort(),
    );
  });
});

describe('STATE_TO_PRIMARY_CODE', () => {
  it('kilter uses Product 7 (Homewall) codes', () => {
    expect(STATE_TO_PRIMARY_CODE.kilter).toEqual({
      STARTING: 42,
      HAND: 43,
      FINISH: 44,
      FOOT: 45,
    });
  });

  it('tension uses Product 1 codes', () => {
    expect(STATE_TO_PRIMARY_CODE.tension).toEqual({
      STARTING: 1,
      HAND: 2,
      FINISH: 3,
      FOOT: 4,
    });
  });

  it('moonboard uses saved-climb codes (42-44), not BLE preview codes', () => {
    expect(STATE_TO_PRIMARY_CODE.moonboard).toEqual({
      STARTING: 42,
      HAND: 43,
      FINISH: 44,
    });
  });

  it('all primary codes exist in HOLD_STATE_MAP for their board', () => {
    for (const [boardName, stateMap] of Object.entries(STATE_TO_PRIMARY_CODE)) {
      for (const [state, code] of Object.entries(stateMap)) {
        const info = HOLD_STATE_MAP[boardName as BoardName][code];
        expect(info, `${boardName} code ${code} should exist in HOLD_STATE_MAP`).toBeDefined();
        expect(info.name, `${boardName} code ${code} should map to ${state}`).toBe(state);
      }
    }
  });
});

describe('convertLitUpHoldsStringToMap', () => {
  it('parses a single-frame string', () => {
    const result = convertLitUpHoldsStringToMap('p100r42p200r43p300r44', 'kilter');
    expect(result[0]).toBeDefined();
    expect(result[0][100]).toEqual({
      state: 'STARTING',
      color: '#00FF00',
      displayColor: '#00FF00',
    });
    expect(result[0][200]).toEqual({ state: 'HAND', color: '#00FFFF', displayColor: '#00FFFF' });
    expect(result[0][300]).toEqual({ state: 'FINISH', color: '#FF00FF', displayColor: '#FF00FF' });
  });

  it('parses multi-frame strings separated by commas', () => {
    const result = convertLitUpHoldsStringToMap('p100r1,p200r2', 'tension');
    expect(Object.keys(result)).toHaveLength(2);
    expect(result[0][100].state).toBe('STARTING');
    expect(result[1][200].state).toBe('HAND');
  });

  it('returns empty map for empty string', () => {
    const result = convertLitUpHoldsStringToMap('', 'kilter');
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('handles unknown state codes gracefully', () => {
    const result = convertLitUpHoldsStringToMap('p100r999', 'kilter');
    expect(result[0][100]).toBeDefined();
    expect(result[0][100].color).toBe('#FFF');
  });

  it('uses displayColor when available', () => {
    const result = convertLitUpHoldsStringToMap('p100r1', 'tension');
    expect(result[0][100]).toEqual({
      state: 'STARTING',
      color: '#00FF00',
      displayColor: '#00DD00',
    });
  });

  it('does not invent a hold_id 0 from an x token or a leading quote (#3948)', () => {
    // The old `split('p')` parser saw `'"x1192'` as its first element,
    // `Number(...)` gave NaN, and the unknown-code branch emitted
    // `[holdId || 0, { state: 'NaN=undefined' }]` — a phantom hold 0 that
    // aurora-sync then wrote straight into board_climb_holds.
    const result = convertLitUpHoldsStringToMap('p1369r13,"x1192p1370r13', 'kilter');
    for (const frame of Object.values(result)) {
      expect(frame[0]).toBeUndefined();
      for (const hold of Object.values(frame)) {
        expect(hold.state).not.toContain('NaN');
      }
    }
    expect(Object.keys(result[1]).sort()).toEqual(['1369', '1370']);
  });

  it('still emits the {holdId}={code} sentinel for an unmapped role code', () => {
    // climb-similarity.ts and backfill-board-climb-holds.ts both filter on
    // the `=`; changing that shape would silently let garbage through.
    const result = convertLitUpHoldsStringToMap('p100r999', 'kilter');
    expect(result[0][100].state).toBe('100=999');
  });
});

describe('parseFramesSegments', () => {
  it('returns an empty array for the empty string', () => {
    expect(parseFramesSegments('')).toEqual([]);
  });

  it('returns a single absolute segment for a single-frame string', () => {
    expect(parseFramesSegments('p100r42p200r43')).toEqual([{ absolute: true, body: 'p100r42p200r43' }]);
  });

  it('marks quoted frames as deltas and unquoted later frames as absolute', () => {
    // The leading `"` is the encoding's own signal for "this frame is a
    // delta on the previous one". A later frame without it restates the
    // whole lit set. Collapsing the two is issue #3947.
    expect(parseFramesSegments('p1r1,"x1p2r1,p3r1')).toEqual([
      { absolute: true, body: 'p1r1' },
      { absolute: false, body: 'x1p2r1' },
      { absolute: true, body: 'p3r1' },
    ]);
  });

  it('keeps a bare-quote hold frame instead of dropping it', () => {
    // `"` on its own is a delta with no changes: hold the current lights
    // for one more pace tick. 956 of these exist in the catalog.
    expect(parseFramesSegments('p1r1,",p2r1')).toEqual([
      { absolute: true, body: 'p1r1' },
      { absolute: false, body: '' },
      { absolute: true, body: 'p2r1' },
    ]);
  });

  it('drops empty unquoted segments from trailing or doubled commas', () => {
    // An empty *unquoted* segment would decode as an absolute snapshot that
    // lights nothing — a one-tick blackout of the whole wall — so it is not
    // a frame. The empty *quoted* segment two tests up is, and stays.
    expect(parseFramesSegments('p100r42,"p200r43,')).toEqual([
      { absolute: true, body: 'p100r42' },
      { absolute: false, body: 'p200r43' },
    ]);
    expect(parseFramesSegments('p100r42,,p200r43')).toEqual([
      { absolute: true, body: 'p100r42' },
      { absolute: true, body: 'p200r43' },
    ]);
  });
});

describe('accumulateFramesToMaps', () => {
  it('returns an empty array for the empty string', () => {
    expect(accumulateFramesToMaps('', 'tension')).toEqual([]);
  });

  it('returns one snapshot for a single-frame climb', () => {
    const result = accumulateFramesToMaps('p100r1p200r2', 'tension');
    expect(result).toHaveLength(1);
    expect(result[0][100].state).toBe('STARTING');
    expect(result[0][200].state).toBe('HAND');
  });

  it('carries lit holds forward across frames', () => {
    // Frame 0 lights hold 100 (STARTING). Frame 1 adds hold 200 (HAND).
    // After frame 1, both holds should still be lit.
    const result = accumulateFramesToMaps('p100r1,"p200r2', 'tension');
    expect(result).toHaveLength(2);
    expect(Object.keys(result[1]).sort()).toEqual(['100', '200']);
    expect(result[1][100].state).toBe('STARTING');
    expect(result[1][200].state).toBe('HAND');
  });

  it('turns a hold OFF via x<id> tokens without removing other lit holds', () => {
    // Frame 0: 100 STARTING + 200 HAND. Frame 1: x100 (off) + p300 HAND.
    const result = accumulateFramesToMaps('p100r1p200r2,"x100p300r2', 'tension');
    expect(result).toHaveLength(2);
    expect(Object.keys(result[0]).sort()).toEqual(['100', '200']);
    expect(Object.keys(result[1]).sort()).toEqual(['200', '300']);
  });

  it('lets a later frame change a hold to a different role', () => {
    // Frame 0 lights 100 STARTING; frame 1 re-sets 100 to HAND.
    const result = accumulateFramesToMaps('p100r1,"p100r2', 'tension');
    expect(result[0][100].state).toBe('STARTING');
    expect(result[1][100].state).toBe('HAND');
  });

  it('handles a set-then-off within the same frame (off wins)', () => {
    const result = accumulateFramesToMaps('p100r1x100', 'tension');
    expect(result).toHaveLength(1);
    expect(result[0][100]).toBeUndefined();
  });

  it('resets on an unquoted later frame — it is a snapshot, not a delta (#3947)', () => {
    // Frame 1 carries no `"`, so it restates the full lit set: holds 100
    // and 200 go dark. Before the fix this returned {100, 200, 300}.
    const result = accumulateFramesToMaps('p100r1p200r2,p300r2', 'tension');
    expect(result).toHaveLength(2);
    expect(Object.keys(result[0]).sort()).toEqual(['100', '200']);
    expect(Object.keys(result[1])).toEqual(['300']);
  });

  it('keeps a bare-quote hold frame as its own repeated snapshot (#3947)', () => {
    // Before the fix the `"`-only segment vanished, so this decoded to two
    // frames and frame 1 was {100, 300} — the animation lost a beat and
    // every later frame index shifted.
    const result = accumulateFramesToMaps('p100r1,",p300r2', 'tension');
    expect(result).toHaveLength(3);
    expect(Object.keys(result[1])).toEqual(['100']);
    expect(result[1]).toEqual(result[0]);
    expect(Object.keys(result[2])).toEqual(['300']);
  });
});

describe('accumulateFramesToMaps against the Kilter Grips oracle', () => {
  // The expected snapshots in this fixture are decoded from Grips'
  // `h{hole}p{role}s{start}e{end}` encoding — explicit inclusive frame
  // ranges, no delta semantics — not from our own reader. See the
  // fixture's `_provenance` block. Four of the five climbs decode wrong
  // on the pre-#3947 reader.
  for (const climb of oracle.climbs) {
    it(`${climb.kind}: ${climb.name} (${climb.climbUuid})`, () => {
      const maps = accumulateFramesToMaps(climb.auroraFrames, 'kilter');
      expect(maps).toHaveLength(climb.framesCount);
      expect(maps).toHaveLength(climb.expectedFrames.length);
      const decoded = maps.map((map) =>
        Object.fromEntries(Object.entries(map).map(([holdId, hold]) => [holdId, hold.state])),
      );
      const expected = climb.expectedFrames.map((frame) =>
        Object.fromEntries(
          Object.entries(frame).map(([placementId, roleCode]) => {
            // A fixture role code outside HOLD_STATE_MAP means the fixture is
            // wrong, not the parser — say so instead of throwing a TypeError
            // from a `.name` on undefined.
            const stateInfo = HOLD_STATE_MAP.kilter[roleCode];
            expect(stateInfo, `oracle fixture role code ${roleCode} is not in HOLD_STATE_MAP.kilter`).toBeDefined();
            return [placementId, stateInfo?.name];
          }),
        ),
      );
      expect(decoded).toEqual(expected);
    });
  }
});

describe('accumulatedMapsToFrameStrings', () => {
  it('emits BLE-friendly snapshots using the board canonical role code', () => {
    const maps = accumulateFramesToMaps('p100r1,"p200r2,"x100p300r3', 'tension');
    const strings = accumulatedMapsToFrameStrings(maps, 'tension');
    // Tension canonical codes: STARTING=1, HAND=2, FINISH=3, FOOT=4.
    expect(strings).toEqual(['p100r1', 'p100r1p200r2', 'p200r2p300r3']);
  });

  it('skips holds whose state has no canonical code on this board', () => {
    // MoonBoard has no FOOT canonical code — a FOOT-state hold should
    // drop out of the BLE string rather than emit `pXrundefined`.
    const maps = [
      {
        100: { state: 'STARTING' as const, color: '#00FF00', displayColor: '#00FF00' },
        200: { state: 'FOOT' as const, color: '#FFAA00', displayColor: '#FFAA00' },
      },
    ];
    const [string0] = accumulatedMapsToFrameStrings(maps, 'moonboard');
    expect(string0).toBe('p100r42');
  });
});

describe('encodeMapsToFramesString', () => {
  it('returns the empty string for an empty maps array', () => {
    expect(encodeMapsToFramesString([], 'tension')).toBe('');
  });

  it('encodes a single frame identically to the legacy flat format', () => {
    const maps = accumulateFramesToMaps('p100r1p200r2', 'tension');
    expect(encodeMapsToFramesString(maps, 'tension')).toBe('p100r1p200r2');
  });

  it('round-trips adds, removes, and role changes across frames', () => {
    const original = 'p100r1p200r2,"x100p300r2,"p300r3';
    const maps = accumulateFramesToMaps(original, 'tension');
    const reEncoded = encodeMapsToFramesString(maps, 'tension');
    expect(accumulateFramesToMaps(reEncoded, 'tension')).toEqual(maps);
  });

  it('encodes two identical consecutive frames as a bare hold frame', () => {
    const maps = [
      { 100: { state: 'STARTING' as const, color: '#00FF00', displayColor: '#00FF00' } },
      { 100: { state: 'STARTING' as const, color: '#00FF00', displayColor: '#00FF00' } },
    ];
    expect(encodeMapsToFramesString(maps, 'tension')).toBe('p100r1,"');
  });

  it('round-trips the Kilter Grips oracle fixtures', () => {
    for (const climb of oracle.climbs) {
      const maps = accumulateFramesToMaps(climb.auroraFrames, 'kilter');
      const reEncoded = encodeMapsToFramesString(maps, 'kilter');
      expect(accumulateFramesToMaps(reEncoded, 'kilter')).toEqual(maps);
    }
  });

  it('drops holds whose state has no canonical code on this board', () => {
    const maps = [
      {
        100: { state: 'STARTING' as const, color: '#00FF00', displayColor: '#00FF00' },
        200: { state: 'FOOT' as const, color: '#FFAA00', displayColor: '#FFAA00' },
      },
    ];
    // MoonBoard has no FOOT canonical code.
    expect(encodeMapsToFramesString(maps, 'moonboard')).toBe('p100r42');
  });

  it('encodes Woods holds with the wire role codes the BLE encoder parses', () => {
    // Woods role codes (spec §6): Foot 1, Hand 2, Finish 3, Start 4. The frames
    // string Boardsesh stores for a Woods climb is fed straight to
    // `getWoodsBluetoothPacket`, so these codes have to survive a round trip.
    const original = 'p0r4p5r2p7r3p9r1';
    const maps = accumulateFramesToMaps(original, 'woods');
    const reEncoded = encodeMapsToFramesString(maps, 'woods');
    expect(reEncoded).toBe(original);
    expect(accumulateFramesToMaps(reEncoded, 'woods')).toEqual(maps);
  });
});

describe('flattenFramesToUnion / toFlatFrames', () => {
  it('returns the frames string untouched when there is only one frame', () => {
    expect(toFlatFrames('p100r1p200r2', 'tension')).toBe('p100r1p200r2');
  });

  it('returns the empty string for null, undefined and empty input', () => {
    expect(toFlatFrames(null, 'tension')).toBe('');
    expect(toFlatFrames(undefined, 'tension')).toBe('');
    expect(toFlatFrames('', 'tension')).toBe('');
  });

  it('keeps a hold an x token cleared — the static render is the whole route', () => {
    // The last frame lights only hold 200; the route as a whole used both.
    expect(toFlatFrames('p100r1p200r2,"x100', 'tension')).toBe('p100r1p200r2');
  });

  it('unions absolute frames instead of showing the last fragment', () => {
    // Frame 1 is unquoted, so on its own it is just hold 300.
    expect(toFlatFrames('p100r1p200r2,p300r3', 'tension')).toBe('p100r1p200r2p300r3');
  });

  it('lets the last frame that sets a hold win its role', () => {
    const union = flattenFramesToUnion(accumulateFramesToMaps('p100r1,"p100r3', 'tension'));
    expect(union[100].state).toBe('FINISH');
  });

  it('returns an empty map for no frames', () => {
    expect(flattenFramesToUnion([])).toEqual({});
  });

  // #4634: the BLE packet builders tokenise with `frames.split('p')` and parse
  // neither the `,"` frame separator nor `x<id>` off-tokens, so anything left in
  // the output would corrupt an LED write.
  it('emits no comma, quote or x token — the invariant the packet builders need', () => {
    const flat = toFlatFrames('p100r42p200r43p300r44,"x100p400r43,"p500r45', 'kilter');
    expect(flat).not.toMatch(/[,"x]/);
  });

  it('collapses a MoonBoard foot/aux-only route to the empty string', () => {
    // STATE_TO_PRIMARY_CODE.moonboard has no FOOT (45) or AUX (46) code, so
    // every hold is dropped on re-emit. Senders must refuse this rather than
    // treat it as a clear-all request.
    expect(toFlatFrames('p1r45p2r46,"p3r45', 'moonboard')).toBe('');
  });

  it('re-emits MoonBoard live-preview hand roles as the canonical hand code', () => {
    // 47 and 48 are both HAND in HOLD_STATE_MAP.moonboard; the raw string's
    // codes are unknown to MOONBOARD_ROLE_MAP and never light today.
    expect(toFlatFrames('p1r47,"p2r48', 'moonboard')).toBe('p1r43p2r43');
  });

  it('recovers the hold sitting on a frame boundary in an additive route', () => {
    // Duplicate-frame authoring produces supersets: frame 1 keeps every hold of
    // frame 0 and adds more, so the encoded delta is `,"` + only the new holds.
    // The raw string's hold 300 is the token immediately before the separator —
    // the one `split('p')` mangles. The union keeps all four.
    expect(toFlatFrames('p100r42p200r43p300r44,"p400r43', 'kilter')).toBe('p100r42p200r43p300r44p400r43');
  });
});

describe('isSentinelHoldState', () => {
  it('flags the {holdId}={code} sentinel an unmapped role code produces', () => {
    const [frame] = accumulateFramesToMaps('p100r999', 'kilter');
    expect(isSentinelHoldState(frame[100].state)).toBe(true);
  });

  it('treats a missing state as a sentinel too', () => {
    expect(isSentinelHoldState('')).toBe(true);
    expect(isSentinelHoldState(null)).toBe(true);
    expect(isSentinelHoldState(undefined)).toBe(true);
  });

  it('passes every real hold state on every board', () => {
    for (const stateMap of Object.values(HOLD_STATE_MAP)) {
      for (const info of Object.values(stateMap)) {
        expect(isSentinelHoldState(info.name), `${info.name} is a real state`).toBe(false);
      }
    }
  });
});
