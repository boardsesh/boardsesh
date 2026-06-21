import type { Climb, SimilarClimb } from '@boardsesh/shared-schema';
import { formatQuality, formatSends, type TranslateSends } from '../../lib/format-climb-stats';

// Build a Climb stub from a SimilarClimb for queue activation (mirrors web's buildClimbStub).
export function buildClimbStub(similar: SimilarClimb, boardType: string): Climb {
  return {
    uuid: similar.uuid,
    layoutId: similar.layoutId,
    boardType,
    name: similar.name ?? '',
    setter_username: similar.setterUsername ?? '',
    frames: similar.frames ?? '',
    angle: similar.angle ?? 0,
    description: '',
    ascensionist_count: similar.ascensionistCount ?? 0,
    difficulty: similar.difficultyName ?? '',
    quality_average: similar.qualityAverage == null ? '' : similar.qualityAverage.toFixed(2),
    stars: 0,
    difficulty_error: '',
    benchmark_difficulty: null,
  };
}

// Compose the "setter · ★quality · N sends" byline, skipping null/zero fields.
// Reuses the standardized formatQuality/formatSends helpers; `t` resolves the
// `sends` key in the `climbs` namespace (compacts counts: "1.5k sends").
export function formatByline(similar: SimilarClimb, t: TranslateSends): string {
  const parts: string[] = [];
  if (similar.setterUsername) parts.push(similar.setterUsername);
  if (similar.qualityAverage != null && similar.qualityAverage > 0) {
    parts.push(`${formatQuality(String(similar.qualityAverage))}★`);
  }
  if (similar.ascensionistCount != null && similar.ascensionistCount > 0) {
    parts.push(formatSends(similar.ascensionistCount, t));
  }
  return parts.join(' · ');
}

export type RankedSimilarClimb = {
  climb: SimilarClimb;
  /** Whether the climb fits the viewer's current wall size. */
  compatible: boolean;
};

// Wall-size-compatible climbs first (stable within group), incompatible last — mirrors web.
export function rankBySizeCompatibility(climbs: SimilarClimb[], sizeId: number): RankedSimilarClimb[] {
  const compatible: RankedSimilarClimb[] = [];
  const incompatible: RankedSimilarClimb[] = [];
  for (const climb of climbs) {
    if (climb.compatibleSizeIds.includes(sizeId)) {
      compatible.push({ climb, compatible: true });
    } else {
      incompatible.push({ climb, compatible: false });
    }
  }
  return [...compatible, ...incompatible];
}
