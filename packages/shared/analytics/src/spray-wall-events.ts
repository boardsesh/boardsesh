// Spray wall telemetry (epic #5346, SW-17): the add-a-wall funnel, the reset
// funnel, and the remix offer that catches a climb a reset broke.
//
// The contract, one paragraph, mirrors board-render-events.ts:
//
//  * Names live in `SHARED_EVENTS` (events.ts) — SW-09 and SW-13 put them
//    there, and the prose beside each name is still the definition of what the
//    event means. What this file adds is the PROPERTIES, typed, so a call site
//    cannot invent a field or drop one.
//  * Builders return `{ name, properties }` TOGETHER, so a caller cannot pair
//    one event's props with another event's name.
//  * **Outcomes, not gestures.** PostHog is past the 1M-event tier
//    (`docs/posthog-cost-audit`-era rule), so every event here fires once per
//    wall per step — picking the photo, the upload landing, detection settling,
//    the holds being saved, a reset previewed, a reset applied. Nothing fires
//    per tap, per frame, or per hold.
//  * **Nothing identifies the wall or what is on it.** No photo, no URI, no
//    file name, no wall name, no gym, no hold coordinates, no free text. A wall
//    photograph is the inside of somebody's home; the only thing worth counting
//    is how many holds there were and whether the step worked. The types below
//    are the enforcement: every field is a number, a boolean, or a member of a
//    closed string union.
//  * `Board Created` with `boardType: 'spray'` closes the add funnel and is the
//    SAME event every other board type fires — a spray-only variant would hide
//    walls from every board-creation number we already watch, so there is no
//    builder for it here.
//
// Full contract and the rollout gates read off these: `docs/spray-walls.md`
// ("Telemetry" and "Rolling the flag out").

import { SHARED_EVENTS } from './events';

/** A name paired with the exact properties that name expects. */
export type SprayWallPayload<
  TName extends string,
  TProperties extends Record<string, number | boolean | string | undefined>,
> = {
  name: TName;
  properties: TProperties;
};

/** Where the photograph came from. The two feel different on a slow phone. */
export type SprayPhotoSource = 'camera' | 'library';

export type SprayWallPhotoPickedProps = { source: SprayPhotoSource };

export function sprayWallPhotoPicked(
  source: SprayPhotoSource,
): SprayWallPayload<typeof SHARED_EVENTS.SprayWallPhotoPicked, SprayWallPhotoPickedProps> {
  return { name: SHARED_EVENTS.SprayWallPhotoPicked, properties: { source } };
}

export type SprayUploadOutcome = 'ok' | 'failed';

export type SprayWallUploadFinishedProps = {
  outcome: SprayUploadOutcome;
  durationMs: number;
  /**
   * Whether the upload could report bytes, or fell back to an indeterminate
   * bar. The two feel different to a climber on a slow link, and only one of
   * them is fixable.
   */
  determinate: boolean;
  /** 1 for the first try. A retry is a different population; never pool them. */
  attempt: number;
};

export function sprayWallUploadFinished(
  properties: SprayWallUploadFinishedProps,
): SprayWallPayload<typeof SHARED_EVENTS.SprayWallUploadFinished, SprayWallUploadFinishedProps> {
  return { name: SHARED_EVENTS.SprayWallUploadFinished, properties };
}

/**
 * How the on-device detector finished.
 *
 * `unavailable` is the no-model branch — no inference runtime in this binary, or
 * the weights would not download — and it is a SUCCESS for the flow: the climber
 * lands in the editor in manual mode. Read it against `ok` to see what fraction
 * of the fleet is placing every hold by hand.
 */
export type SprayDetectionOutcome = 'ok' | 'unavailable' | 'failed';

export type SprayWallDetectionFinishedProps = {
  outcome: SprayDetectionOutcome;
  /** How many holds the detector proposed. 0 for every non-`ok` outcome. */
  candidateCount: number;
  durationMs: number;
};

export function sprayWallDetectionFinished(
  properties: SprayWallDetectionFinishedProps,
): SprayWallPayload<typeof SHARED_EVENTS.SprayWallDetectionFinished, SprayWallDetectionFinishedProps> {
  return { name: SHARED_EVENTS.SprayWallDetectionFinished, properties };
}

export type SprayHoldsReviewedProps = {
  /** What the review step actually saved — the number the detector is judged on. */
  holdCount: number;
  /**
   * Whether the detector had proposed anything at all. Without it a wall placed
   * entirely by hand and a wall whose every suggestion was accepted are the same
   * row, and the detection-quality gate below would read them as one population.
   */
  hadCandidates: boolean;
};

export function sprayHoldsReviewed(
  properties: SprayHoldsReviewedProps,
): SprayWallPayload<typeof SHARED_EVENTS.SprayHoldsReviewed, SprayHoldsReviewedProps> {
  return { name: SHARED_EVENTS.SprayHoldsReviewed, properties };
}

export type SprayWallResetPreviewedProps = {
  keptCount: number;
  removedCount: number;
  addedCount: number;
  /** Matches the gate let through at low confidence — the ones worth eyeballing. */
  lowConfidenceCount: number;
  /** Climbs whose integrity the reset would move. Never which climbs. */
  climbsAffected: number;
  /** The new photo is a different shape from the wall's frame. */
  aspectMismatch: boolean;
  /** How many holds the new photo's detector found, before matching. */
  detectionCount: number;
};

export function sprayWallResetPreviewed(
  properties: SprayWallResetPreviewedProps,
): SprayWallPayload<typeof SHARED_EVENTS.SprayWallResetPreviewed, SprayWallResetPreviewedProps> {
  return { name: SHARED_EVENTS.SprayWallResetPreviewed, properties };
}

export type SprayWallResetAppliedProps = {
  keptCount: number;
  removedCount: number;
  addedCount: number;
  climbsChanged: number;
  /**
   * How many "same hold, moved here" pairings the owner confirmed — the only
   * thing that makes remix able to suggest a successor months later.
   */
  moveCount: number;
};

export function sprayWallResetApplied(
  properties: SprayWallResetAppliedProps,
): SprayWallPayload<typeof SHARED_EVENTS.SprayWallResetApplied, SprayWallResetAppliedProps> {
  return { name: SHARED_EVENTS.SprayWallResetApplied, properties };
}

/** Which surface offered the remix. One today; named so a second is legible. */
export type SprayRemixSurface = 'play_drawer';

export type ClimbRemixedFromBrokenProps = {
  /** Holds this climb lost to a reset. Never which holds. */
  lostHoldCount: number;
  /**
   * Successors the reset review linked for those lost holds, when the surface
   * knows them. Optional because the play drawer offers the remix off the
   * climb's own `missingHoldCount` and does not always have the suggestions
   * loaded; an event without it means "not known here", not "none".
   */
  suggestedHoldCount?: number;
  source: SprayRemixSurface;
};

export function climbRemixedFromBroken(
  properties: ClimbRemixedFromBrokenProps,
): SprayWallPayload<typeof SHARED_EVENTS.ClimbRemixedFromBroken, ClimbRemixedFromBrokenProps> {
  return { name: SHARED_EVENTS.ClimbRemixedFromBroken, properties };
}

/**
 * The two ratios the flag rollout is gated on (`docs/feature-flags.md`).
 *
 * Exported as functions rather than written into a dashboard description so the
 * numbers in the doc and the numbers in the code cannot drift, and so a reader
 * can see exactly which events each one divides.
 */
export const SPRAY_ROLLOUT_GATES = {
  /**
   * Detection quality proxy: of the walls where the detector proposed holds, how
   * far the saved hold count sits from what it proposed. A wall where the
   * climber kept the suggestions lands near 0; one where they rebuilt the wall
   * by hand lands near 1. Gate: <= 0.15 before widening the flag.
   *
   * A proxy, not an F1: we do not store the detections, so a correction and a
   * deletion followed by an addition are indistinguishable. It moves in the
   * right direction, which is what a rollout gate needs.
   */
  detectionCorrectionRate(detected: number, saved: number): number {
    if (detected <= 0) return 0;
    return Math.abs(saved - detected) / detected;
  },
  /**
   * Reset satisfaction: applied / previewed. An owner who previews a reset and
   * never applies it has been shown something they do not believe. Gate: >= 0.6.
   */
  resetCommitRate(previewed: number, applied: number): number {
    if (previewed <= 0) return 0;
    return applied / previewed;
  },
} as const;
