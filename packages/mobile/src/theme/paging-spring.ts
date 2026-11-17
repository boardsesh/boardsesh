import { springs } from './animations';

/**
 * How close to its target, in points, a {@link pagingSpring} counts as landed:
 * it finishes there and snaps the rest of the way. Under a pixel on a 3×
 * screen, and by then moving at 5–10 pt/s.
 */
export const PAGING_LANDED_DISTANCE = 0.25;

/**
 * The `withSpring` config that settles from `from` to `to`, carrying the
 * release's `velocity` (points per second, signed like the value).
 *
 * Critically damped, with the stiffness raised when the release is fast for the
 * distance left: k = max(400, (v / d)²). At that stiffness the spring cannot
 * pass its target, and it eases out from exactly the speed the finger let go
 * at, so a flick never stops dead against a clamp. Reaches 90% of the distance
 * in 40–75 ms from a flick and about 190 ms from a slow release.
 *
 * A velocity pointing away from the target is dropped, as Reanimated would. The
 * spring finishes once it is within {@link PAGING_LANDED_DISTANCE}: Reanimated's
 * default energy threshold left it creeping on for another 100–200 ms below a
 * pixel, holding up whatever waits for it to land.
 */
export function pagingSpring(
  from: number,
  to: number,
  velocity: number,
): {
  damping: number;
  stiffness: number;
  mass: number;
  velocity: number;
  overshootClamping: true;
  energyThreshold: number;
} {
  'worklet';
  const { mass, stiffness: floor } = springs.paging;
  const distance = Math.abs(to - from);
  const towardTarget = (to - from) * velocity > 0 ? velocity : 0;
  const speed = Math.abs(towardTarget);
  const stiffness = distance > 0 ? Math.max(floor, (speed / distance) ** 2 * mass) : floor;
  // Reanimated measures the end by energy, relative to the energy at the start:
  // done once what is left is no more than a spring stretched the landed distance.
  const startEnergy = 0.5 * stiffness * distance ** 2 + 0.5 * mass * towardTarget ** 2;
  const landedEnergy = 0.5 * stiffness * PAGING_LANDED_DISTANCE ** 2;
  return {
    damping: 2 * Math.sqrt(stiffness * mass),
    stiffness,
    mass,
    velocity: towardTarget,
    overshootClamping: true,
    energyThreshold: startEnergy > landedEnergy ? landedEnergy / startEnergy : 1,
  };
}
