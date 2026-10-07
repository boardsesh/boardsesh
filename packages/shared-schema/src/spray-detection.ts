/** The server and homelab worker share this versioned, photo-pixel contract. */
export const SPRAY_DETECTION_QUEUE = 'spray-wall-detection';
export const SPRAY_DETECTION_COMPLETION_QUEUE = 'spray-wall-detection-completed';
export interface SprayDetectionCompletionJob {
  detectionId: string;
}
export interface SprayWallImportProgress {
  wallUuid: string;
  versionId: string | null;
  detectionId: string | null;
  stage: 'draft' | 'queued' | 'running' | 'ready' | 'failed';
  queuePosition: number | null;
  retryAt: string | null;
  /** The wall this unpublished reset clone replaces; null for a plain new wall. */
  resetOfWallUuid: string | null;
}
export const SPRAY_WALL_WRITE_LOCK_NAMESPACE = 0x53505259;
export const SPRAY_DETECTION_DEAD_QUEUE = 'spray-wall-detection-failed';
export const SPRAY_DETECTION_RECONCILE_QUEUE = 'spray-wall-detection-reconcile';
export const SPRAY_DETECTION_MODEL_VERSION = '2026-09-18-seg';
export const SPRAY_DETECTION_WEIGHTS_SHA256 = '04847246ceaef144759cd7e1edb00268217a71c1a32709813c2957318572fcb1';
export const SPRAY_DETECTION_TIMEOUT_MS = 120_000;
export const SPRAY_DETECTION_PENDING_MS = 24 * 60 * 60 * 1000;

/**
 * Detector confidence at or above which a candidate opens ON — drawn as a solid
 * ring and written on Publish unless the climber switches it off.
 *
 * The band this cut sits in is set by the WORKER, not by the app: the hold
 * detector keeps only detections at or above its manifest's
 * `thresholds.default`, which is 0.6 for `2026-09-18-seg` (`detect()` in
 * `packages/hold-detector/src/detect.ts` falls back to it and
 * `inference-thread.ts` passes no override). Every candidate the spray hold
 * editor ever sees therefore scores 0.6–1.0, and a cut below 0.6 would make every find ON
 * and the maybe state unreachable.
 *
 * 0.75 splits that band where the old editor already drew its dashed
 * "low confidence" rings. On a 240-hold validation spray wall
 * (`roboflow-1class/valid/IMG_8992`) the deployed model returned 224 finds,
 * median 0.84; this cut opens 189 of them ON and 35 as maybes. No precision
 * curve for the seg model is checked in yet — re-derive this once one lands in
 * `ml/holds/results/`, and lower the worker's threshold if more maybes are wanted.
 */
export const SPRAY_ON_CUTOFF = 0.75;

/**
 * Candidates between this and {@link SPRAY_ON_CUTOFF} open as MAYBES: a dashed
 * amber ring that is drawn but not written until the climber taps it on.
 * Anything below is never shown at all.
 *
 * Matches the worker's own 0.6 floor, so today every candidate it sends is
 * shown; the floor only bites if a future model ships a lower default.
 *
 * Shared with the backend (SW-20, #5471): the training review counts a
 * candidate at or above this floor that no saved hold points back at as
 * DELETED, and one below it as NOT_SHOWN, because the climber never saw it.
 */
export const SPRAY_MAYBE_FLOOR = 0.6;

export type SprayDetectionStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export interface SprayDetectionCandidate {
  cx: number;
  cy: number;
  r: number;
  confidence: number;
  outline?: number[] | null;
}
export interface SprayDetectionResult {
  width: number;
  height: number;
  candidates: SprayDetectionCandidate[];
}
export interface SprayDetectionJob {
  detectionId: string;
}
export interface SprayDetectionView {
  id: string;
  wallUuid: string;
  versionId: string;
  status: SprayDetectionStatus;
  modelVersion: string;
  result: SprayDetectionResult | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  queuePosition?: number | null;
  retryAt?: string | null;
}

export const SPRAY_DETECTION_JOB_OPTIONS = {
  retryLimit: 3,
  retryDelay: 15,
  retryBackoff: true,
  retryDelayMax: 120,
  expireInSeconds: SPRAY_DETECTION_TIMEOUT_MS / 1000,
  heartbeatSeconds: 30,
  retentionSeconds: SPRAY_DETECTION_PENDING_MS / 1000,
  deadLetter: SPRAY_DETECTION_DEAD_QUEUE,
} as const;

export function isSprayDetectionPending(status: SprayDetectionStatus): boolean {
  return status === 'pending' || status === 'running';
}
