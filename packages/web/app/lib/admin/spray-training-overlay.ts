import type {
  SprayTrainingCandidateData,
  SprayTrainingHoldData,
  SprayTrainingStatsData,
} from '@boardsesh/graphql/operations';

/** What a drawn mark stands for. Each kind gets its own colour and stroke. */
export type SprayOverlayKind = 'manual' | 'auto' | 'accepted' | 'confirmed' | 'edited' | 'deleted' | 'notShown';

/** A mark in photo pixels: a ring when the outline is usable, else a circle. */
export type SprayOverlayShape =
  | { geometry: 'polygon'; points: string }
  | { geometry: 'circle'; cx: number; cy: number; r: number };

export type SprayOverlayMark = {
  key: string;
  kind: SprayOverlayKind;
  shape: SprayOverlayShape;
};

type ShapeInput = { cx: number; cy: number; r: number; outline: readonly number[] | null };

/** Fewest numbers that make a ring: three x/y pairs. */
const MIN_OUTLINE_NUMBERS = 6;

/**
 * The outline is a flat, implicitly closed ring in units of the hold's own
 * radius around its centre, so a point is (cx + ox·r, cy + oy·r). A missing,
 * short, odd-length or non-finite outline falls back to the circle.
 */
export function buildHoldShape({ cx, cy, r, outline }: ShapeInput): SprayOverlayShape {
  const usable =
    outline != null &&
    outline.length >= MIN_OUTLINE_NUMBERS &&
    outline.length % 2 === 0 &&
    outline.every((entry) => Number.isFinite(entry));
  if (!usable) return { geometry: 'circle', cx, cy, r };

  const points: string[] = [];
  for (let index = 0; index < outline.length; index += 2) {
    const pointX = cx + outline[index] * r;
    const pointY = cy + outline[index + 1] * r;
    points.push(`${roundTo2(pointX)},${roundTo2(pointY)}`);
  }
  return { geometry: 'polygon', points: points.join(' ') };
}

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function holdKind(hold: Pick<SprayTrainingHoldData, 'source' | 'autoReview'>): SprayOverlayKind {
  if (hold.source === 'MANUAL') return 'manual';
  switch (hold.autoReview) {
    case 'ACCEPTED':
      return 'accepted';
    case 'CONFIRMED':
      return 'confirmed';
    case 'EDITED':
      return 'edited';
    default:
      return 'auto';
  }
}

/**
 * Suggestions the climber saw and removed, or never saw. Kept and edited ones
 * are already saved holds, so drawing them again would double the ring.
 * `UNKNOWN` has no fate to show.
 */
export function candidateKind(
  candidate: Pick<SprayTrainingCandidateData, 'fate'>,
): Extract<SprayOverlayKind, 'deleted' | 'notShown'> | null {
  if (candidate.fate === 'DELETED') return 'deleted';
  if (candidate.fate === 'NOT_SHOWN') return 'notShown';
  return null;
}

export type SprayOverlayInput = {
  holds: readonly SprayTrainingHoldData[];
  candidates: readonly SprayTrainingCandidateData[];
};

/** Every mark the overlay can draw, saved holds first and suggestions after. */
export function buildOverlayMarks({ holds, candidates }: SprayOverlayInput): SprayOverlayMark[] {
  const marks: SprayOverlayMark[] = holds.map((hold) => ({
    key: `hold-${hold.id}`,
    kind: holdKind(hold),
    shape: buildHoldShape(hold),
  }));
  for (const candidate of candidates) {
    const kind = candidateKind(candidate);
    if (kind === null) continue;
    marks.push({ key: `candidate-${candidate.index}`, kind, shape: buildHoldShape(candidate) });
  }
  return marks;
}

/** Whole-number percentage, 0 when there is nothing to divide by. */
export function percentOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

export type SprayTrainingCardStats = {
  holdCount: number;
  editedPercent: number;
  acceptedPercent: number;
  deletedSuggestions: number;
};

/** The four numbers on a queue card. */
export function summariseStats(stats: SprayTrainingStatsData): SprayTrainingCardStats {
  return {
    holdCount: stats.holdCount,
    editedPercent: percentOf(stats.editedHoldCount, stats.holdCount),
    acceptedPercent: percentOf(stats.acceptedHoldCount, stats.holdCount),
    deletedSuggestions: stats.deletedCandidateCount,
  };
}

/** Milliseconds until a presigned photo URL stops working, never negative. */
export function msUntilExpiry(expiresAt: string | null | undefined, now: number): number | null {
  if (!expiresAt) return null;
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return null;
  return Math.max(0, expiry - now);
}
