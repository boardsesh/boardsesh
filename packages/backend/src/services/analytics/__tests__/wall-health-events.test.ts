import { describe, expect, it } from 'vitest';
import type { SprayWallHealthMetrics } from '@boardsesh/db/jobs';
import {
  buildSprayWallHealthProperties,
  SPRAY_WALL_HEALTH_EVENT,
  sprayWallHealthDistinctId,
} from '../wall-health-events';

/**
 * The reporting contract for the weekly roll-up (issue #6062), pinned at the
 * boundary where aggregates become a PostHog payload.
 *
 * The rules this file owns are exactly two: the no-cohort bag (an empty fleet
 * ships ONLY `wallsLive: 0`, so the dashboard never reads absence as zero
 * activity), and the personless shape (every value a plain number, the week
 * an ISO Monday, nothing that names a wall, a gym or a climber). The metric
 * DEFINITIONS live with the queries in `@boardsesh/db/jobs` — this is the
 * last stop before the wire.
 */

const FULL_METRICS: SprayWallHealthMetrics = {
  wallsLive: 7,
  wallsCreated: 2,
  wallsGym: 3,
  wallsPublic: 4,
  wallsActive: 5,
  wallsSecondClimber: 2,
  climbsLive: 41,
  climbsCreated: 9,
  climbsDegraded: 3,
  litEvents: 18,
  litWalls: 4,
  litClimbs: 12,
  ticksLogged: 25,
  ticksSends: 19,
  ticksClimbers: 6,
  ticksNonOwner: 8,
  resetsPublished: 1,
  reportsFiled: 2,
  holdsAlive: 460,
};

const EMPTY_FLEET: SprayWallHealthMetrics = {
  ...FULL_METRICS,
  wallsLive: 0,
  wallsCreated: 0,
  wallsGym: 0,
  wallsPublic: 0,
  wallsActive: 0,
  wallsSecondClimber: 0,
  climbsLive: 0,
  climbsCreated: 0,
  climbsDegraded: 0,
  litEvents: 0,
  litWalls: 0,
  litClimbs: 0,
  ticksLogged: 0,
  ticksSends: 0,
  ticksClimbers: 0,
  ticksNonOwner: 0,
  resetsPublished: 0,
  reportsFiled: 0,
  holdsAlive: 0,
};

describe('Spray Wall Health Weekly payload', () => {
  it('carries the event name the backend union expects', () => {
    expect(SPRAY_WALL_HEALTH_EVENT).toBe('Spray Wall Health Weekly');
  });

  it('ships every metric plus the measured week for a live fleet', () => {
    const properties = buildSprayWallHealthProperties('2026-09-28', FULL_METRICS);
    expect(properties).toEqual({ weekStart: '2026-09-28', ...FULL_METRICS });
  });

  it('ships only the cohort marker when there are no live walls', () => {
    // Absence IS the measurement: activity metrics over an empty set would
    // read as "walls nobody climbs", which is a different claim entirely.
    expect(buildSprayWallHealthProperties('2026-09-28', EMPTY_FLEET)).toEqual({
      weekStart: '2026-09-28',
      wallsLive: 0,
    });
  });

  it('never carries anything that names a wall, a gym or a climber', () => {
    // `wallsGym` is a COUNT of walls that sit in gyms, so the gym word is
    // allowed as a cohort label; what must never appear is anything that
    // could carry an identifier — a board, a photo, a key, a person.
    const forbidden = ['photo', 'uuid', 'name', 'email', 'user', 'key', 'board', 'note'];
    for (const properties of [
      buildSprayWallHealthProperties('2026-09-28', FULL_METRICS),
      buildSprayWallHealthProperties('2026-09-28', EMPTY_FLEET),
    ]) {
      for (const [key, value] of Object.entries(properties)) {
        for (const fragment of forbidden) {
          expect(key.toLowerCase().includes(fragment), key).toBe(false);
        }
        expect(['number', 'string']).toContain(typeof value);
      }
    }
  });

  it('keys the actor by week, so a backfill re-emits without rewriting', () => {
    expect(sprayWallHealthDistinctId('2026-09-28')).toBe('spray-wall-health:2026-09-28');
    expect(sprayWallHealthDistinctId('2026-09-21')).not.toBe(sprayWallHealthDistinctId('2026-09-28'));
  });
});
