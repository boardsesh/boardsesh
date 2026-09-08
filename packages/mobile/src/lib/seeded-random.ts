/**
 * A seeded pseudo-random generator, for the places that must draw the same
 * numbers twice.
 *
 * Pure and dependency-free on purpose: the one caller is screenshot mode, which
 * has to fold away entirely from a shipped build, and pulling a package in for
 * nine lines of arithmetic would put it in the native graph for nothing.
 */

/** Anything that answers like `Math.random`: a float in `[0, 1)`. */
export type RandomSource = () => number;

/**
 * mulberry32 — a 32-bit generator with a 2^32 period, good enough for shuffling
 * a list of climbs and small enough to read.
 *
 * Chosen over an xorshift because it has no bad seeds: every 32-bit value,
 * zero included, produces a usable sequence. Not cryptographic, and nothing
 * here wants it to be.
 *
 * Each call to this function returns a FRESH generator at the start of its
 * sequence, so two callers with the same seed draw the same numbers regardless
 * of what order they run in — which is the property screenshot mode needs, and
 * one a shared module-level generator would not have.
 */
export function mulberry32(seed: number): RandomSource {
  // `>>> 0` keeps the state an unsigned 32-bit integer, so a negative or
  // fractional seed still behaves.
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let drawn = state;
    drawn = Math.imul(drawn ^ (drawn >>> 15), drawn | 1);
    drawn ^= drawn + Math.imul(drawn ^ (drawn >>> 7), drawn | 61);
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4294967296;
  };
}
