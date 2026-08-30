/**
 * Read the committed hand-drawn outline corrections for one shard.
 *
 * `packages/db/scripts/export-outline-overrides.ts` writes them out of the
 * `hold_outline_overrides` table; this is the other half, the bit
 * `scripts/generate-board-art-geometry.ts` calls at its emission boundary so a
 * corrected hold ships in the shard instead of the tracer's version of it.
 *
 * SELF-CONTAINED on purpose. The tracer is 2,000 lines of image processing and
 * this is a file reader; keeping them apart is what makes the merge auditable —
 * you can read this module and know exactly what a committed override can and
 * cannot do to a shard, without holding the tracer in your head.
 *
 * The one import is `@boardsesh/board-art-geometry/ring`, and it has to be that
 * one: the editor, the backend's write path and this merge all have to agree on
 * what a storable ring is, and three copies of that predicate would disagree the
 * first time one moved.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CENTRE_TOLERANCE_RADII,
  distanceToRing,
  isValidOutlineRing,
  pointInRing,
} from '../packages/shared/board-art-geometry/src/ring';

/**
 * Where the exported files live. Relative like the generator's own board-render
 * imports: the repo's isolated linker leaves workspace packages out of the root
 * `node_modules`, so a bare specifier does not resolve for a script run from the
 * repo root.
 */
export const OVERRIDES_DIR = path.resolve(import.meta.dirname, '../packages/shared/board-art-geometry/overrides');

/** What one config's committed file holds, after validation. */
export type ShardOverrides = {
  /** `placementId` -> corrected silhouette ring, in radius units. */
  outlines: Map<number, number[]>;
  /** `placementId` -> LED base-plate inner boundary, in radius units. */
  ledInner: Map<number, number[]>;
};

/** The JSON shape the exporter writes. `meta` is for human review and is ignored here. */
type OverrideFileShape = {
  outlines?: Record<string, unknown>;
  ledInner?: Record<string, unknown>;
};

/**
 * Every key the exporter writes. Anything else is refused rather than ignored.
 *
 * A typo is the whole reason. `"outline"` or `"ledinner"` parses as perfectly
 * good JSON and reads as an empty override set — the generator would then write
 * a shard with the tracer's version of a hold somebody had corrected, pass every
 * gate, and say nothing. The same silence a stale placement id would buy, from a
 * missing letter.
 */
const ALLOWED_TOP_LEVEL_KEYS = new Set(['$comment', 'outlines', 'ledInner', 'meta']);

/**
 * A placement key, exactly as `Object.keys` on a JSON object gives it.
 *
 * Digits only — not `Number()`, which happily accepts `" 1448 "` and
 * `"1.448e3"` and would collapse three different-looking keys onto one
 * placement, last one winning.
 */
const PLACEMENT_KEY = /^\d+$/;

/**
 * Does this ring plausibly belong to this placement?
 *
 * The same two-part question the backend asks on write — shape, then "is it
 * drawn around THIS hold" — restated here because a file on disk has not been
 * through the backend: it can be hand-edited, and it can outlive the config it
 * was drawn against.
 */
function assertRingCoversCentre(context: string, ring: number[]): void {
  if (pointInRing(ring, 0, 0)) return;
  const distance = distanceToRing(ring, 0, 0);
  if (distance <= CENTRE_TOLERANCE_RADII) return;
  throw new Error(
    `${context}: the ring does not cover its placement centre — it misses by ${distance.toFixed(3)} radii, ` +
      `over the ${CENTRE_TOLERANCE_RADII} allowed. A ring this far off is drawn around a different hold.`,
  );
}

function parseRingMap(
  context: string,
  raw: Record<string, unknown> | undefined,
  knownPlacementIds: ReadonlySet<number>,
): Map<number, number[]> {
  const parsed = new Map<number, number[]>();
  if (raw === undefined) return parsed;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${context}: expected an object of placementId -> ring`);
  }

  for (const [placementText, ring] of Object.entries(raw)) {
    if (!PLACEMENT_KEY.test(placementText)) {
      throw new Error(`${context}: "${placementText}" is not a placement id — expected digits only`);
    }
    const placementId = Number(placementText);
    const entry = `${context} placement ${placementId}`;
    // HARD FAIL, never a silent drop. A stale override is a correction someone
    // made that has stopped being applied, and the only moment anyone would
    // notice is this one — a shard regenerated without it looks perfectly
    // healthy, passes every gate, and quietly ships the tracer's version again.
    if (!knownPlacementIds.has(placementId)) {
      throw new Error(
        `${entry}: no such placement on this config. The override outlived the board data — ` +
          `delete the row and re-run: vp run db:export-outline-overrides`,
      );
    }
    if (!isValidOutlineRing(ring)) {
      throw new Error(`${entry}: not a storable ring (flat, even-length, 3..150 points, every |value| <= 4)`);
    }
    assertRingCoversCentre(entry, ring);
    parsed.set(placementId, ring);
  }
  return parsed;
}

/**
 * The committed corrections for `shardKey`, validated against the placements the
 * shard is being generated from.
 *
 * Returns empty maps when the config has no file, which is the normal case: the
 * overrides directory holds a file only for a config someone has actually
 * corrected.
 *
 * `overridesDir` exists so the tests can point at a fixture tree. The generator
 * never passes it.
 */
export function loadOverridesFor(
  shardKey: string,
  placementIds: Iterable<number>,
  overridesDir: string = OVERRIDES_DIR,
): ShardOverrides {
  const filePath = path.join(overridesDir, `${shardKey}.json`);
  if (!existsSync(filePath)) return { outlines: new Map(), ledInner: new Map() };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `${shardKey}: overrides file is not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Valid JSON is not the same question as "the shape this file is meant to
  // have". A bare array, a string, or `null` all parse, and cast straight to
  // `OverrideFileShape` they load as zero overrides with no complaint.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(
      `${shardKey}: overrides file must be a JSON object, got ${Array.isArray(raw) ? 'array' : typeof raw}`,
    );
  }
  const unknownKeys = Object.keys(raw).filter((key) => !ALLOWED_TOP_LEVEL_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${shardKey}: unknown key(s) ${unknownKeys.map((key) => `"${key}"`).join(', ')} — ` +
        `expected ${[...ALLOWED_TOP_LEVEL_KEYS].map((key) => `"${key}"`).join(', ')}. ` +
        `A misspelt table reads as an empty one, which is a correction silently not applied.`,
    );
  }
  const parsed = raw as OverrideFileShape;

  const known = new Set(placementIds);
  return {
    outlines: parseRingMap(`${shardKey} overrides.outlines`, parsed.outlines, known),
    ledInner: parseRingMap(`${shardKey} overrides.ledInner`, parsed.ledInner, known),
  };
}
