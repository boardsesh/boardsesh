/** The server and homelab worker share this versioned, photo-pixel contract. */
export const SPRAY_DETECTION_QUEUE = 'spray-wall-detection';
export const SPRAY_WALL_WRITE_LOCK_NAMESPACE = 0x53505259;
export const SPRAY_DETECTION_DEAD_QUEUE = 'spray-wall-detection-failed';
export const SPRAY_DETECTION_RECONCILE_QUEUE = 'spray-wall-detection-reconcile';
export const SPRAY_DETECTION_MODEL_VERSION = '2026-09-18-seg';
export const SPRAY_DETECTION_WEIGHTS_SHA256 = '04847246ceaef144759cd7e1edb00268217a71c1a32709813c2957318572fcb1';
export const SPRAY_DETECTION_TIMEOUT_MS = 120_000;
export const SPRAY_DETECTION_PENDING_MS = 24 * 60 * 60 * 1000;

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
