import { isValidOutlineRing } from '@boardsesh/board-art-geometry/ring';
import type { SprayDetectionResult } from '@boardsesh/shared-schema';
import type { DetectResult } from './detect';

function usableOutline(outline: unknown): outline is number[] {
  if (!isValidOutlineRing(outline)) return false;
  let twiceArea = 0;
  for (let index = 0; index < outline.length; index += 2) {
    const next = (index + 2) % outline.length;
    twiceArea += outline[index] * outline[next + 1] - outline[next] * outline[index + 1];
  }
  return Math.abs(twiceArea) > 1e-6;
}

/** Refuse bad geometry before it can become a durable, apparently successful job. */
export function detectionProposal(
  result: DetectResult,
  expected: { width: number; height: number },
): SprayDetectionResult {
  if (result.photo.width !== expected.width || result.photo.height !== expected.height)
    throw new Error('PHOTO_DIMENSION_MISMATCH');
  if (result.holds.length > 1500) throw new Error('HOLD_LIMIT_EXCEEDED');
  const candidates = result.holds.map(({ cx, cy, r, score, outline }) => {
    if (
      ![cx, cy, r, score].every(Number.isFinite) ||
      cx < 0 ||
      cy < 0 ||
      cx > expected.width ||
      cy > expected.height ||
      r <= 0 ||
      r > Math.max(expected.width, expected.height) ||
      score < 0 ||
      score > 1
    )
      throw new Error('INVALID_CANDIDATE');
    return { cx, cy, r, confidence: score, outline: usableOutline(outline) ? outline : null };
  });
  return { ...expected, candidates };
}
