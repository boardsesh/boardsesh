import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PACE_MS,
  MAX_PACE_MS,
  MIN_AUTHORED_PACE_MS,
  MIN_PACE_MS,
  clampAuthoredPaceMs,
  resolveStoredPaceMs,
} from '../pace';

// Two readers of the same field that must NOT behave alike. `clampAuthoredPaceMs`
// bounds what the authoring slider can produce; `resolveStoredPaceMs` reads a
// pace that already exists. Collapsing them silently rewrites climbs on edit,
// which is the failure these cases exist to prevent.

describe('clampAuthoredPaceMs', () => {
  it('holds a new pace inside what the control offers', () => {
    expect(clampAuthoredPaceMs(50)).toBe(MIN_AUTHORED_PACE_MS);
    expect(clampAuthoredPaceMs(50_000)).toBe(MAX_PACE_MS);
    expect(clampAuthoredPaceMs(2_000)).toBe(2_000);
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
    // The whole point. Aurora climbs carry whatever pace their setter chose and
    // the server accepts up to 30s, so clamping on the way in would halve a 20s
    // route the next time its owner opened and re-saved it — with nothing on
    // screen to show that anything changed.
    expect(resolveStoredPaceMs(20_000)).toBe(20_000);
    expect(resolveStoredPaceMs(30_000)).toBe(30_000);
    expect(resolveStoredPaceMs(MAX_PACE_MS + 1)).toBe(MAX_PACE_MS + 1);
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
