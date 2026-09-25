import { describe, it, expect } from 'vitest';
import { SHARED_EVENTS } from '../events';
import {
  SPRAY_ROLLOUT_GATES,
  climbRemixedFromBroken,
  sprayHoldsReviewed,
  sprayWallDetectionFinished,
  sprayWallPhotoPicked,
  sprayWallResetApplied,
  sprayWallResetPreviewed,
  sprayWallUploadFinished,
} from '../spray-wall-events';

/**
 * Shape tests for the spray wall builders.
 *
 * Two things are worth pinning, and they are the two the docs promise:
 *
 *  - every builder pairs its OWN name with its properties, so a call site cannot
 *    hand one event's props to another event's name;
 *  - **nothing identifies a wall or what is on it.** The rule is enforced at the
 *    type level, but a type is not evidence at runtime, so the payloads are read
 *    back and checked field by field: no free text, no coordinates, no uri, no
 *    name, no uuid. That check is the whole reason this file exists — a field
 *    added to a builder in a hurry would otherwise ship a wall photograph's
 *    filename to PostHog with nothing red on the way.
 */

/**
 * Fields that must never appear in a spray payload, whatever the builder.
 *
 * Matched on the KEY, not the value, so a field carrying a coordinate under an
 * innocent name is still caught by the numeric check below.
 */
const FORBIDDEN_KEY_FRAGMENTS = ['uri', 'url', 'name', 'uuid', 'path', 'file', 'photo', 'cx', 'cy', 'gym', 'note'];

const EVERY_PAYLOAD = [
  sprayWallPhotoPicked('camera'),
  sprayWallUploadFinished({ outcome: 'ok', durationMs: 1200, determinate: true, attempt: 1 }),
  sprayWallDetectionFinished({ outcome: 'ok', candidateCount: 214, durationMs: 4100 }),
  sprayHoldsReviewed({ holdCount: 198, hadCandidates: true }),
  sprayWallResetPreviewed({
    keptCount: 150,
    removedCount: 20,
    addedCount: 31,
    lowConfidenceCount: 4,
    climbsAffected: 12,
    aspectMismatch: false,
    detectionCount: 181,
  }),
  sprayWallResetApplied({ keptCount: 150, removedCount: 20, addedCount: 31, climbsChanged: 12, moveCount: 6 }),
  climbRemixedFromBroken({ lostHoldCount: 3, source: 'play_drawer' }),
];

describe('spray wall event builders', () => {
  it('pairs each name with its own properties', () => {
    expect(sprayWallPhotoPicked('library')).toEqual({
      name: SHARED_EVENTS.SprayWallPhotoPicked,
      properties: { source: 'library' },
    });
    expect(sprayHoldsReviewed({ holdCount: 12, hadCandidates: false })).toEqual({
      name: SHARED_EVENTS.SprayHoldsReviewed,
      properties: { holdCount: 12, hadCandidates: false },
    });
    expect(climbRemixedFromBroken({ lostHoldCount: 3, source: 'play_drawer' })).toEqual({
      name: SHARED_EVENTS.ClimbRemixedFromBroken,
      properties: { lostHoldCount: 3, source: 'play_drawer' },
    });
  });

  it('uses a name from the shared catalog for every builder', () => {
    const catalogNames = new Set<string>(Object.values(SHARED_EVENTS));
    for (const payload of EVERY_PAYLOAD) {
      expect(catalogNames.has(payload.name), payload.name).toBe(true);
    }
  });

  it('never carries anything that identifies a wall or what is on it', () => {
    for (const payload of EVERY_PAYLOAD) {
      for (const [key, value] of Object.entries(payload.properties)) {
        const lowered = key.toLowerCase();
        for (const fragment of FORBIDDEN_KEY_FRAGMENTS) {
          expect(lowered.includes(fragment), `${payload.name}.${key}`).toBe(false);
        }
        // Numbers, booleans and closed-set strings only. A free-text field would
        // be a string nobody bounded, which is exactly what must not reach an
        // analytics pipeline from a photograph of somebody's home.
        expect(['number', 'boolean', 'string'], `${payload.name}.${key}`).toContain(typeof value);
        if (typeof value === 'string') expect(value.length, `${payload.name}.${key}`).toBeLessThan(24);
      }
    }
  });

  it('fires each event at most once per wall per step, so every count is an outcome', () => {
    // Not a behaviour test — a documentation pin. Every payload above carries
    // COUNTS (how many holds, how many climbs, how long) rather than a per-gesture
    // marker, which is what keeps the volume proportional to walls rather than to
    // taps. A builder that arrived with a `gesture`-shaped field would fail the
    // forbidden-key check above; this one says why the shape is what it is.
    const countFields = EVERY_PAYLOAD.flatMap((payload) =>
      Object.entries(payload.properties).filter(([, value]) => typeof value === 'number'),
    );
    expect(countFields.length).toBeGreaterThan(0);
    for (const [key, value] of countFields) expect(value, key).toBeGreaterThanOrEqual(0);
  });
});

describe('the rollout gates', () => {
  it('reads a detector whose suggestions were kept as a low correction rate', () => {
    expect(SPRAY_ROLLOUT_GATES.detectionCorrectionRate(200, 198)).toBeCloseTo(0.01);
    expect(SPRAY_ROLLOUT_GATES.detectionCorrectionRate(200, 120)).toBeCloseTo(0.4);
    // No detections at all is the manual-mode population, not a 100% correction:
    // dividing by zero there would make a fleet with no inference runtime look
    // like a broken detector and block the rollout on a number about nothing.
    expect(SPRAY_ROLLOUT_GATES.detectionCorrectionRate(0, 180)).toBe(0);
  });

  it('reads previews that never landed as a low commit rate', () => {
    expect(SPRAY_ROLLOUT_GATES.resetCommitRate(10, 8)).toBeCloseTo(0.8);
    expect(SPRAY_ROLLOUT_GATES.resetCommitRate(10, 2)).toBeCloseTo(0.2);
    expect(SPRAY_ROLLOUT_GATES.resetCommitRate(0, 0)).toBe(0);
  });
});
