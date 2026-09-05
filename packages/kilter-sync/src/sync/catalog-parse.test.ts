import { describe, expect, it } from 'vitest';

import { decodeGripsClimbConcat } from './catalog-parse';
import { fingerprintFromHolds } from './fingerprint';
import fixture from './__fixtures__/grips-multiframe.json';

// hole_id → placement_id, the board_placements bridge. Real Kilter values are
// in the thousands; small numbers here keep the expectations readable.
const REMAP = new Map<number, number>([
  [10, 100],
  [20, 200],
  [30, 300],
  [40, 400],
]);

/** Decode or fail loudly — keeps the happy-path tests free of null checks. */
function decodeOk(concat: string, remap: Map<number, number>, frameCount: number) {
  const result = decodeGripsClimbConcat(concat, remap, frameCount);
  if (!result.ok) throw new Error(`expected a successful decode, got ${result.reason}`);
  return result;
}

type FixtureClimb = (typeof fixture.climbs)[number];

function fixtureClimb(climbUuid: string): FixtureClimb {
  const climb = fixture.climbs.find((entry) => entry.climbUuid === climbUuid);
  if (!climb) throw new Error(`fixture is missing climb ${climbUuid}`);
  return climb;
}

function fixtureRemap(climb: FixtureClimb): Map<number, number> {
  return new Map(
    Object.entries(climb.holeToPlacement).map(([holeId, placementId]) => [Number(holeId), Number(placementId)]),
  );
}

/**
 * The frames string the legacy Aurora catalog stored for this climb, with role
 * codes shifted onto the product-1 codes Grips emits (see the fixture's
 * `_provenance.auroraRoleCodeShift`). This is the oracle: it was produced by a
 * different backend years before this parser existed, so an assertion against
 * it cannot pass by restating our own decode.
 */
function auroraOracle(climb: FixtureClimb): string {
  if (climb.auroraRoleCodeShift === 0) return climb.auroraFrames;
  return climb.auroraFrames.replace(/r(\d+)/g, (_, code: string) => `r${Number(code) - climb.auroraRoleCodeShift}`);
}

void describe('decodeGripsClimbConcat — single frame', () => {
  it('remaps hole ids to placement ids and rewrites h{}p{} → p{}r{}', () => {
    // codes: 12=start, 13=middle, 14=finish, 15=foot (kilter HOLD_STATE_MAP)
    expect(decodeOk('h10p12h20p13h30p14h40p15', REMAP, 1).frames).toBe('p100r12p200r13p300r14p400r15');
  });

  it('preserves the incoming hold order, so existing single-frame output is unchanged', () => {
    expect(decodeOk('h30p14h10p12h20p13', REMAP, 1).frames).toBe('p300r14p100r12p200r13');
  });

  it('reports the offending hole when it has no placement on this layout', () => {
    expect(decodeGripsClimbConcat('h10p12h99p13', REMAP, 1)).toEqual({
      ok: false,
      reason: 'unplaceable_hole',
      holeId: 99,
    });
  });

  it('rejects an unparseable concat rather than dropping holds', () => {
    expect(decodeGripsClimbConcat('h10p12garbage', REMAP, 1)).toEqual({
      ok: false,
      reason: 'unparsable_concat',
      offset: 6,
    });
  });

  it('rejects a comma-separated concat instead of guessing at it', () => {
    // Not one of 100,513 captured concats contains a comma. If Grips ever
    // starts emitting one we want it in the skip backlog, not silently decoded
    // under an assumption we never verified.
    expect(decodeGripsClimbConcat('h10p12,h20p13', REMAP, 2).ok).toBe(false);
  });

  it('decodes a real single-frame climb to the exact string the Aurora catalog holds', () => {
    const climb = fixtureClimb('1C5BA6A510224AB98BA80B6812F08060');
    expect(decodeOk(climb.climbConcat, fixtureRemap(climb), climb.frameCount).frames).toBe(auroraOracle(climb));
  });
});

void describe('decodeGripsClimbConcat — animated multi-frame (issue #3523)', () => {
  it('decodes a real 15-frame climb to the exact string the Aurora catalog holds', () => {
    // Deleting the s/e handling makes this an `unparsable_concat`.
    const climb = fixtureClimb('DA658EAACBE54AC89DB4060ED07BAF6C');
    const result = decodeOk(climb.climbConcat, fixtureRemap(climb), climb.frameCount);
    expect(result.frames).toBe(auroraOracle(climb));
    expect(result.frames.split(',')).toHaveLength(climb.frameCount);
  });

  it('keeps a hold lit when it is re-lit on the very frame it would go out', () => {
    // h1549p13s14e14 then h1549p14s15: hole 1549 goes out at the end of frame
    // 14 and comes straight back in the finish role on frame 15. Emitting the
    // clear alongside the light would be noise the Aurora catalog omits.
    const climb = fixtureClimb('DA658EAACBE54AC89DB4060ED07BAF6C');
    const frames = decodeOk(climb.climbConcat, fixtureRemap(climb), climb.frameCount).frames.split(',');
    const relitPlacement = climb.holeToPlacement['1549'];
    expect(frames[14]).toBe(`"p${relitPlacement}r14`);
    expect(frames[14]).not.toContain(`x${relitPlacement}`);
  });

  it('orders each frame’s tokens by placement id, interleaving clears and lights', () => {
    // Removing the sort leaves tokens in concat order and this diverges.
    const climb = fixtureClimb('8351B8C4C27C4DF5A8FD3ED483F67E4B');
    const result = decodeOk(climb.climbConcat, fixtureRemap(climb), climb.frameCount);
    expect(result.frames).toBe(auroraOracle(climb));
    for (const frame of result.frames.split(',')) {
      const placementIds = [...frame.matchAll(/[px](\d+)/g)].map((match) => Number(match[1]));
      expect(placementIds).toEqual([...placementIds].sort((left, right) => left - right));
    }
  });

  it('treats an absent s as frame 1 and an absent e as the final frame', () => {
    // Every hold is lit for the whole climb, so frames 2..6 are empty deltas.
    // Today's parser accepts this concat and emits ONE frame, contradicting
    // the wire's frameCount — this locks the six-frame shape in.
    const climb = fixtureClimb('2F64CA9CDDA2499AB74B97C15CE12E28');
    const result = decodeOk(climb.climbConcat, fixtureRemap(climb), climb.frameCount);
    expect(result.frames).toBe(auroraOracle(climb));
    expect(result.frames.split(',').slice(1)).toEqual(['"', '"', '"', '"', '"']);
  });

  it('lights a hold from its s frame through to the end when e is absent', () => {
    const climb = fixtureClimb('0EE81E7C144E4A6D902764FA7870101D');
    const result = decodeOk(climb.climbConcat, fixtureRemap(climb), climb.frameCount);
    expect(result.frames).toBe(auroraOracle(climb));
    expect(result.frames).not.toContain('x');
  });

  it('decodes an animated climb on a second layout and product (Homewall)', () => {
    const climb = fixtureClimb('145F91BFEE3D4AD78E21219D03F84393');
    expect(decodeOk(climb.climbConcat, fixtureRemap(climb), climb.frameCount).frames).toBe(auroraOracle(climb));
  });

  it('clears a hold on the frame AFTER its last lit one (e is inclusive)', () => {
    // h10p12e1 is lit on frame 1 only, so the clear lands on frame 2. Reading
    // e as exclusive would shift every clear one frame earlier.
    expect(decodeOk('h10p12e1h20p13', REMAP, 3).frames).toBe('p100r12p200r13,"x100,"');
  });

  it('never emits a clear for a hold that stays lit to the last frame', () => {
    // An explicit e equal to frameCount is the same as omitting e — which is
    // why the encoder never writes it, and why it must not produce a clear.
    expect(decodeOk('h10p12h20p13e2', REMAP, 2).frames).toBe('p100r12p200r13,"');
    expect(decodeOk('h10p12h20p13e2', REMAP, 2).frames).toBe(decodeOk('h10p12h20p13', REMAP, 2).frames);
  });

  it('rejects an s or e beyond frameCount instead of inventing frames', () => {
    expect(decodeGripsClimbConcat('h10p12s7', REMAP, 3)).toEqual({ ok: false, reason: 'frame_out_of_range', frame: 7 });
    expect(decodeGripsClimbConcat('h10p12e9', REMAP, 3)).toEqual({ ok: false, reason: 'frame_out_of_range', frame: 9 });
    expect(decodeGripsClimbConcat('h10p12s3e2', REMAP, 3)).toEqual({
      ok: false,
      reason: 'frame_out_of_range',
      frame: 2,
    });
  });
});

void describe('decodeGripsClimbConcat — holds and fingerprint', () => {
  it('decodes holds into (placement, state, frame) tuples', () => {
    expect(decodeOk('h10p12h20p13h30p14h40p15', REMAP, 1).holds).toEqual([
      { holdId: 100, holdState: 'STARTING', frameNumber: 0 },
      { holdId: 200, holdState: 'HAND', frameNumber: 0 },
      { holdId: 300, holdState: 'FINISH', frameNumber: 0 },
      { holdId: 400, holdState: 'FOOT', frameNumber: 0 },
    ]);
  });

  it('numbers hold frames from zero and records only the frame a hold lights on', () => {
    // Matches how board_climb_holds already stores multi-frame climbs: one row
    // per hold on the frame it appears, no rows for the frames it stays lit.
    expect(decodeOk('h10p12h20p13s2e2h30p14s3', REMAP, 3).holds).toEqual([
      { holdId: 100, holdState: 'STARTING', frameNumber: 0 },
      { holdId: 200, holdState: 'HAND', frameNumber: 1 },
      { holdId: 300, holdState: 'FINISH', frameNumber: 2 },
    ]);
  });

  it('gives a real animated climb one canonical row per placement', () => {
    const climb = fixtureClimb('DA658EAACBE54AC89DB4060ED07BAF6C');
    const result = decodeOk(climb.climbConcat, fixtureRemap(climb), climb.frameCount);
    const holdIds = result.holds.map((hold) => hold.holdId);
    expect(holdIds).toHaveLength(new Set(holdIds).size);
    expect(result.holds.every((hold) => hold.frameNumber < climb.frameCount)).toBe(true);

    const relitPlacement = climb.holeToPlacement['1549'];
    expect(result.holds.filter((hold) => hold.holdId === relitPlacement)).toEqual([
      { holdId: relitPlacement, holdState: 'HAND', frameNumber: 13 },
    ]);
  });

  it('skips an unknown first role but accepts the same placement when it later has a valid role', () => {
    expect(decodeOk('h10p999e1h10p13s2', REMAP, 2).holds).toEqual([{ holdId: 100, holdState: 'HAND', frameNumber: 1 }]);
  });

  it('fingerprints a re-lit placement from the same canonical row the table stores', () => {
    const decoded = decodeOk('h10p12e1h10p14s2', REMAP, 2);
    expect(decoded.holds).toEqual([{ holdId: 100, holdState: 'STARTING', frameNumber: 0 }]);
    expect(fingerprintFromHolds(decoded.holds)).toBe(
      fingerprintFromHolds([{ holdId: 100, holdState: 'STARTING', frameNumber: 0 }]),
    );
  });

  it('fingerprints identically regardless of hold order (sorted tuples)', () => {
    const first = decodeOk('h10p12h20p13h30p14', REMAP, 1);
    const second = decodeOk('h30p14h10p12h20p13', REMAP, 1);
    expect(first.frames).not.toBe(second.frames); // raw strings differ…
    expect(fingerprintFromHolds(first.holds)).toBe(fingerprintFromHolds(second.holds)); // …fingerprints match
  });

  it('fingerprints differently when the same holds move between frames', () => {
    const together = decodeOk('h10p12h20p13', REMAP, 2);
    const staggered = decodeOk('h10p12h20p13s2', REMAP, 2);
    expect(fingerprintFromHolds(together.holds)).not.toBe(fingerprintFromHolds(staggered.holds));
  });

  it('different holds produce different fingerprints', () => {
    const first = decodeOk('h10p12h20p13', REMAP, 1);
    const second = decodeOk('h10p12h30p13', REMAP, 1);
    expect(fingerprintFromHolds(first.holds)).not.toBe(fingerprintFromHolds(second.holds));
  });
});
