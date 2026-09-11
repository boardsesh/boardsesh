import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PACE_MS,
  MAX_PACE_MS,
  MIN_AUTHORED_PACE_MS,
  MIN_PACE_MS,
  clampAuthoredPaceMs,
  paceSecondsForSpeed,
  resolveStoredPaceMs,
  speedForPaceSeconds,
} from '../pace';

// Two readers of the same field that must NOT behave alike. `clampAuthoredPaceMs`
// bounds what the authoring slider can produce; `resolveStoredPaceMs` reads a
// pace that already exists. Collapsing them silently rewrites climbs on edit,
// which is the failure these cases exist to prevent.

describe('clampAuthoredPaceMs', () => {
  it('holds a new pace inside what the control offers', () => {
    expect(clampAuthoredPaceMs(50)).toBe(MIN_AUTHORED_PACE_MS);
    expect(clampAuthoredPaceMs(120_000)).toBe(MAX_PACE_MS);
    expect(clampAuthoredPaceMs(2_000)).toBe(2_000);
  });

  it('offers the whole range the catalogue actually uses', () => {
    // 359 of 744 synced multi-frame routes are paced slower than 10s a frame,
    // and the slowest sit at exactly 60s. A lower ceiling would leave a climber
    // unable to play half the catalogue at the pace its setter chose, and a
    // setter unable to re-author one without silently speeding it up.
    expect(MAX_PACE_MS).toBeGreaterThanOrEqual(60_000);
    expect(clampAuthoredPaceMs(60_000)).toBe(60_000);
  });

  it('keeps the authored floor clear of the transport floor', () => {
    // MIN_PACE_MS is where the BLE writer physically cannot keep up. Authoring
    // exactly onto a hardware limit leaves a slow GATT link no headroom.
    expect(MIN_AUTHORED_PACE_MS).toBeGreaterThan(MIN_PACE_MS);
  });

  it('falls back to the default rather than propagating a non-number', () => {
    expect(clampAuthoredPaceMs(Number.NaN)).toBe(DEFAULT_PACE_MS);
    expect(clampAuthoredPaceMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PACE_MS);
  });
});

describe('resolveStoredPaceMs', () => {
  it('keeps a stored pace the authoring control could not have produced', () => {
    // The whole point. A climb carries whatever pace its setter chose, so
    // clamping on the way in would speed up a slow route the next time its
    // owner opened and re-saved it — with nothing on screen to show that
    // anything changed. The ceiling is a property of the slider, not the data.
    expect(resolveStoredPaceMs(20_000)).toBe(20_000);
    expect(resolveStoredPaceMs(MAX_PACE_MS)).toBe(MAX_PACE_MS);
    expect(resolveStoredPaceMs(MAX_PACE_MS + 1)).toBe(MAX_PACE_MS + 1);
    expect(resolveStoredPaceMs(120_000)).toBe(120_000);
  });

  it('reads "never authored" as the default', () => {
    // 0 and null both mean unset in the Aurora encoding, not "instant".
    expect(resolveStoredPaceMs(0)).toBe(DEFAULT_PACE_MS);
    expect(resolveStoredPaceMs(null)).toBe(DEFAULT_PACE_MS);
    expect(resolveStoredPaceMs(undefined)).toBe(DEFAULT_PACE_MS);
    expect(resolveStoredPaceMs(-1)).toBe(DEFAULT_PACE_MS);
  });

  it('does not propagate a non-number', () => {
    expect(resolveStoredPaceMs(Number.NaN)).toBe(DEFAULT_PACE_MS);
    expect(resolveStoredPaceMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PACE_MS);
  });

  it('returns whole milliseconds, which is what the column stores', () => {
    expect(resolveStoredPaceMs(1_234.6)).toBe(1_235);
  });
});

// The multiplier is the wire format and the seconds are what a climber sees.
// These two convert between them, and party sync only stays in step because the
// conversion happens on each phone against its OWN copy of the authored pace.

describe('pace unit conversion', () => {
  it('reads a multiplier as the seconds it actually produces', () => {
    // The reason the multiplier had to go: one number, two very different paces.
    expect(paceSecondsForSpeed(750, 0.5)).toBe(1.5);
    expect(paceSecondsForSpeed(12_000, 0.5)).toBe(24);
    expect(paceSecondsForSpeed(750, 1)).toBe(0.75);
  });

  it('round-trips a pace through the multiplier unchanged', () => {
    for (const paceMs of [300, 750, 5_000, 12_000, 60_000]) {
      for (const seconds of [0.3, 0.75, 1, 5, 12, 60]) {
        expect(paceSecondsForSpeed(paceMs, speedForPaceSeconds(paceMs, seconds))).toBeCloseTo(seconds, 10);
      }
    }
  });

  it('leaves playback alone rather than dividing by a junk value', () => {
    // These reach us off the wire (a peer's broadcast) and out of a control mid
    // drag, so neither can be trusted to be a positive finite number.
    expect(speedForPaceSeconds(750, 0)).toBe(1);
    expect(speedForPaceSeconds(750, Number.NaN)).toBe(1);
    expect(speedForPaceSeconds(0, 5)).toBe(1);
    expect(paceSecondsForSpeed(750, 0)).toBe(DEFAULT_PACE_MS / 1000);
    expect(paceSecondsForSpeed(750, Number.NaN)).toBe(DEFAULT_PACE_MS / 1000);
  });
});
