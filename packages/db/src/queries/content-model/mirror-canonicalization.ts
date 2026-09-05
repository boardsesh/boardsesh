import type { TrainingHold } from '../hold-features/training-matrix';

/**
 * Put a route's hold features into the same horizontal orientation as its
 * route-level physical signature. This is applied only after deciding whether
 * the whole route, not each hold independently, chose the mirrored signature.
 */
export function canonicalizeMirrorFeatures(
  holds: readonly TrainingHold[],
  options: { usesFingerprint: boolean; mirrored: boolean },
): TrainingHold[] {
  return holds.map((sourceHold) => {
    const hold: TrainingHold = { ...sourceHold, ...(sourceHold.morph ? { morph: [...sourceHold.morph] } : {}) };
    hold.modelHoldId = options.usesFingerprint
      ? hold.pid
      : options.mirrored
        ? (hold.mirroredHoleId ?? hold.holeId ?? hold.pid)
        : (hold.holeId ?? hold.pid);
    if (!options.mirrored) return hold;

    if (hold.nx !== null) hold.nx = 1 - hold.nx;
    if (hold.pull !== null) hold.pull = (360 - hold.pull) % 360;
    if (hold.morph && hold.morph.length > 7) {
      // Horizontal reflection maps θ → π−θ, so sin(2θ) changes sign while
      // cos(2θ) and scalar shape/texture summaries do not.
      hold.morph[7] = -hold.morph[7];
    }
    const originalHoleId = hold.holeId;
    hold.holeId = hold.mirroredHoleId ?? originalHoleId;
    hold.mirroredHoleId = originalHoleId ?? hold.mirroredHoleId;
    return hold;
  });
}
