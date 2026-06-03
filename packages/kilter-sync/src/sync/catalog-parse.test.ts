import { describe, expect, it } from 'vitest';

import { gripsClimbConcatToFrames, framesToHolds, fingerprintFrames } from './catalog-parse';

// hole_id → placement_id, the board_placements bridge. Real Kilter values are
// in the thousands; small numbers here keep the expectations readable.
const REMAP = new Map<number, number>([
  [10, 100],
  [20, 200],
  [30, 300],
  [40, 400],
]);

void describe('gripsClimbConcatToFrames', () => {
  it('remaps hole ids to placement ids and rewrites h{}p{} → p{}r{}', () => {
    // codes: 12=start, 13=middle, 14=finish, 15=foot (kilter HOLD_STATE_MAP)
    expect(gripsClimbConcatToFrames('h10p12h20p13h30p14h40p15', REMAP)).toBe('p100r12p200r13p300r14p400r15');
  });

  it('returns null when a hole has no placement on this layout', () => {
    expect(gripsClimbConcatToFrames('h10p12h99p13', REMAP)).toBeNull();
  });

  it('returns null on an unparseable concat rather than dropping holds', () => {
    expect(gripsClimbConcatToFrames('h10p12garbage', REMAP)).toBeNull();
  });

  it('preserves comma-separated multi-frame structure', () => {
    expect(gripsClimbConcatToFrames('h10p12,h20p13', REMAP)).toBe('p100r12,p200r13');
  });
});

void describe('framesToHolds', () => {
  it('decodes placement frames into (holdId, state, frame) tuples', () => {
    const holds = framesToHolds('p100r12p200r13p300r14p400r15');
    expect(holds).toEqual(
      expect.arrayContaining([
        { holdId: 100, holdState: 'STARTING', frameNumber: 0 },
        { holdId: 200, holdState: 'HAND', frameNumber: 0 },
        { holdId: 300, holdState: 'FINISH', frameNumber: 0 },
        { holdId: 400, holdState: 'FOOT', frameNumber: 0 },
      ]),
    );
    expect(holds).toHaveLength(4);
  });
});

void describe('fingerprintFrames (dedup key)', () => {
  it('is identical regardless of hold order (sorted tuples)', () => {
    const a = gripsClimbConcatToFrames('h10p12h20p13h30p14', REMAP)!;
    const b = gripsClimbConcatToFrames('h30p14h10p12h20p13', REMAP)!;
    expect(a).not.toBe(b); // raw strings differ…
    expect(fingerprintFrames(a)).toBe(fingerprintFrames(b)); // …but fingerprints match
  });

  it('worked example: two duplicate climbs share one fingerprint', () => {
    // Climb A "Sloper Squeeze" and climb B "Squeeze the Slopers" — different
    // UUIDs, identical holds → must collapse to one canonical (the doc's example).
    const aFrames = gripsClimbConcatToFrames('h10p12h20p13h30p14', REMAP)!;
    const bFrames = gripsClimbConcatToFrames('h20p13h30p14h10p12', REMAP)!;
    expect(fingerprintFrames(aFrames)).toBe(fingerprintFrames(bFrames));
  });

  it('different holds produce different fingerprints', () => {
    const a = gripsClimbConcatToFrames('h10p12h20p13', REMAP)!;
    const b = gripsClimbConcatToFrames('h10p12h30p13', REMAP)!;
    expect(fingerprintFrames(a)).not.toBe(fingerprintFrames(b));
  });
});
