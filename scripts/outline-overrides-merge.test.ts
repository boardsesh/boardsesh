import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOverridesFor } from './outline-overrides-merge';

/**
 * The merge module's own tests.
 *
 * They live here rather than in `@boardsesh/board-art-geometry` for a boring
 * reason: that package's tsconfig sets `rootDir: ./src`, so a test inside it
 * cannot import a module from `scripts/`. The package-side `overrides.test.ts`
 * checks the committed FILES and the shards they produced; these check the
 * loader that turns one into the other — and above all that it REFUSES rather
 * than shrugs, which is the property the committed files cannot demonstrate
 * while there are none of them.
 */

const SHARD_KEY = 'kilter/8-25';
/** A blunt square ring, one radius on a side, comfortably around the centre. */
const SQUARE = [-1, -1, 1, -1, 1, 1, -1, 1];
const PLACEMENTS = [1448, 4800, 4806];

let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), 'outline-overrides-'));
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function writeOverrides(body: unknown): void {
  const filePath = path.join(fixtureDir, `${SHARD_KEY}.json`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`);
}

function load(): ReturnType<typeof loadOverridesFor> {
  return loadOverridesFor(SHARD_KEY, PLACEMENTS, fixtureDir);
}

describe('loadOverridesFor', () => {
  it('returns empty maps for a config with no committed file', () => {
    const loaded = load();
    expect(loaded.outlines.size).toBe(0);
    expect(loaded.ledInner.size).toBe(0);
  });

  it('reads silhouette and LED-inner rings into separate maps, verbatim', () => {
    writeOverrides({
      $comment: 'anything',
      outlines: { 1448: SQUARE },
      ledInner: { 1448: [-0.4, -0.4, 0.4, -0.4, 0.4, 0.4, -0.4, 0.4] },
      meta: { 1448: { author: 'marco', updatedAt: '2026-08-30T00:00:00.000Z', kinds: ['led_inner', 'silhouette'] } },
    });
    const loaded = load();
    expect(loaded.outlines.get(1448)).toEqual(SQUARE);
    expect(loaded.ledInner.get(1448)).toEqual([-0.4, -0.4, 0.4, -0.4, 0.4, 0.4, -0.4, 0.4]);
  });

  it('ignores meta entirely — it is for the reviewer, not the generator', () => {
    writeOverrides({ outlines: { 4800: SQUARE }, meta: { 9999: { updatedAt: 'nonsense', kinds: [] } } });
    expect([...load().outlines.keys()]).toEqual([4800]);
  });

  // THE MUST-TRIP FIXTURE. A correction whose placement has left the board data
  // has to break the build loudly, because the alternative — dropping it — is
  // invisible: the regenerated shard passes every gate and quietly ships the
  // tracer's version of a hold somebody had already fixed by hand.
  it('hard-fails on an override for a placement the config does not have', () => {
    writeOverrides({ outlines: { 4242: SQUARE } });
    expect(() => load()).toThrow(/placement 4242: no such placement on this config/);
  });

  it('hard-fails on a stale ledInner placement too', () => {
    writeOverrides({ ledInner: { 4242: SQUARE } });
    expect(() => load()).toThrow(/ledInner placement 4242: no such placement/);
  });

  it('hard-fails on a ring that is not a storable ring', () => {
    writeOverrides({ outlines: { 1448: [0, 0, 1] } });
    expect(() => load()).toThrow(/not a storable ring/);
  });

  it('hard-fails on a coordinate outside the four-radii backstop', () => {
    writeOverrides({ outlines: { 1448: [-9, -1, 1, -1, 1, 1, -1, 1] } });
    expect(() => load()).toThrow(/not a storable ring/);
  });

  it('hard-fails on a ring drawn around the neighbouring hold', () => {
    // Two radii away is where the next placement sits — the failure the centre
    // rule exists to catch.
    const shifted = SQUARE.map((value, index) => (index % 2 === 0 ? value + 2 : value));
    writeOverrides({ outlines: { 1448: shifted } });
    expect(() => load()).toThrow(/does not cover its placement centre/);
  });

  it('admits a ring that misses its centre by less than the tolerance', () => {
    // A hook whose bolt sits just under a concave underside: outside its own
    // polygon, but by 0.05 radii, well inside the 0.25 allowance.
    const nudged = SQUARE.map((value, index) => (index % 2 === 1 ? value + 1.05 : value));
    writeOverrides({ outlines: { 1448: nudged } });
    expect(load().outlines.get(1448)).toEqual(nudged);
  });

  it('hard-fails on a file that is not JSON', () => {
    const filePath = path.join(fixtureDir, `${SHARD_KEY}.json`);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '{ not json');
    expect(() => load()).toThrow(/not valid JSON/);
  });

  it('hard-fails on a key that is not a placement id', () => {
    writeOverrides({ outlines: { banana: SQUARE } });
    expect(() => load()).toThrow(/"banana" is not a placement id/);
  });

  // `Number(' 1448 ')` is 1448 and so is `Number('1.448e3')`. Three keys that
  // look like three different placements would collapse onto one, last write
  // winning, with nothing said about it.
  it.each([' 1448 ', '1.448e3', '+1448'])('hard-fails on the near-miss placement key "%s"', (key) => {
    writeOverrides({ outlines: { [key]: SQUARE } });
    expect(() => load()).toThrow(/is not a placement id — expected digits only/);
  });

  // Valid JSON that is not the shape this file has. Cast unchecked, every one of
  // these loads as zero overrides and says nothing.
  it.each([
    ['an array', [1, 2, 3]],
    ['a string', 'overrides'],
    ['a number', 42],
    ['null', null],
  ])('hard-fails on a top-level %s', (_label, body) => {
    const filePath = path.join(fixtureDir, `${SHARD_KEY}.json`);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(body)}\n`);
    expect(() => load()).toThrow(/must be a JSON object/);
  });

  // A misspelt table is the quiet version of a dropped correction: the file
  // parses, the ring is right there in the diff, and the generator merges
  // nothing.
  it.each(['outline', 'ledinner', 'ledInners', 'silhouettes'])('hard-fails on the unknown top-level key %s', (key) => {
    writeOverrides({ $comment: 'x', [key]: { 1448: SQUARE } });
    expect(() => load()).toThrow(new RegExp(`unknown key\\(s\\) "${key}"`));
  });

  it('accepts every key the exporter actually writes', () => {
    writeOverrides({
      $comment: 'generated',
      outlines: { 1448: SQUARE },
      ledInner: { 1448: SQUARE.map((value) => value * 0.4) },
      meta: { 1448: { author: 'marco', updatedAt: '2026-08-30T00:00:00.000Z', kinds: ['silhouette'] } },
    });
    expect(load().outlines.size).toBe(1);
    expect(load().ledInner.size).toBe(1);
  });
});
