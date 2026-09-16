// Turning a wall photo into hold suggestions, and surviving not being able to
// (epic #5346, SW-09).
//
// The model itself is SW-02's: the ONNX Runtime session, the weights downloaded
// from R2 and verified, and the manifest that says what size and threshold the
// export was trained for. None of that is in this module and none of it is
// imported by it — SW-02 is the epic's ONE native PR and ships on the release
// train, while this slice ships by OTA into binaries that may predate it.
//
// So the detector is REGISTERED rather than imported. A build that carries the
// runtime installs one at startup; a build that does not installs nothing, and
// every caller here answers `unavailable`, which routes the flow into the hold
// editor in manual mode. That is not a degraded path bolted on for old binaries:
// it is the path the epic decided the product lives on either way
// (`docs/spray-walls.md`, "Detection post-processing" — suggestions, not
// auto-detect), and the editor is the product with or without a model.
//
// Registering also keeps the module graph honest. A static import of the
// runtime, even inside a `try`, puts `onnxruntime-react-native` into the bundle
// for everyone — including the Expo web build, which has no such native module.

import type { SprayHoldCandidate } from '../../components/outline-editor/spray-hold-editor-types';

/** What a detector is asked to look at: a local JPEG and its pixel size. */
export type SprayDetectorRequest = {
  uri: string;
  width: number;
  height: number;
  /** Called after each tile so the screen can draw a real progress bar. */
  onProgress?: (done: number, total: number) => void;
};

/**
 * Photo in, candidates out, in the pixels of the photo that was handed in.
 *
 * `null` means "this device cannot answer" — no runtime, no weights, no network
 * to fetch them with. A THROW means it tried and went wrong. The two are
 * different to a climber ("your phone can't suggest holds" vs "suggesting holds
 * failed"), which is why they are different here.
 */
export type SprayHoldDetector = (request: SprayDetectorRequest) => Promise<readonly SprayHoldCandidate[] | null>;

let registeredDetector: SprayHoldDetector | null = null;

/**
 * Install the on-device detector, or clear it with `null`.
 *
 * Called once, from the app root, by the build that has a runtime to offer.
 */
export function registerSprayHoldDetector(detector: SprayHoldDetector | null): void {
  registeredDetector = detector;
}

/** Whether this binary can suggest holds at all. Cheap; safe to call from a render. */
export function canSuggestSprayHolds(): boolean {
  return registeredDetector != null;
}

export type SprayDetectionOutcome =
  | { outcome: 'ok'; candidates: readonly SprayHoldCandidate[] }
  | { outcome: 'unavailable' }
  | { outcome: 'failed' };

/**
 * Rescale candidates from the photo the detector saw to the photo the SERVER
 * stored.
 *
 * These are not the same picture. The app compresses to a 2048 px long edge
 * before uploading, and the upload handler re-encodes through sharp with
 * `rotate()`, so the stored object can differ in size (and, for a photo with an
 * EXIF orientation the compressor did not already bake, in orientation). The
 * editor draws on the STORED photo's pixels, so a candidate measured on the
 * local file lands offset by exactly that ratio unless it is mapped here.
 *
 * The radius takes the mean of the two axis scales rather than one of them: a
 * hold is drawn as a circle, and with a non-uniform scale — which only happens
 * if something upstream changed the aspect ratio — neither axis alone is right,
 * while the mean is wrong by the same small amount in both directions.
 */
export function scaleCandidatesToStoredPhoto(
  candidates: readonly SprayHoldCandidate[],
  from: { width: number; height: number },
  to: { width: number; height: number },
): readonly SprayHoldCandidate[] {
  if (!(from.width > 0) || !(from.height > 0) || !(to.width > 0) || !(to.height > 0)) return candidates;
  const scaleX = to.width / from.width;
  const scaleY = to.height / from.height;
  if (scaleX === 1 && scaleY === 1) return candidates;
  const radiusScale = (scaleX + scaleY) / 2;
  return candidates.map((candidate) => ({
    ...candidate,
    cx: candidate.cx * scaleX,
    cy: candidate.cy * scaleY,
    r: candidate.r * radiusScale,
  }));
}

/**
 * Run the registered detector over a picked photo and hand back candidates in
 * the stored photo's pixels.
 *
 * Never throws. Every way this can go wrong — no detector, a detector that
 * declines, a detector that blows up — resolves to an outcome the caller can
 * show, because the one thing a failed suggestion must not do is stop somebody
 * adding their wall.
 */
export async function suggestSprayHolds(request: {
  photo: { uri: string; width: number; height: number };
  storedPhoto: { width: number; height: number };
  onProgress?: (done: number, total: number) => void;
}): Promise<SprayDetectionOutcome> {
  const detector = registeredDetector;
  if (!detector) return { outcome: 'unavailable' };

  try {
    const candidates = await detector({
      uri: request.photo.uri,
      width: request.photo.width,
      height: request.photo.height,
      onProgress: request.onProgress,
    });
    if (!candidates) return { outcome: 'unavailable' };
    return {
      outcome: 'ok',
      candidates: scaleCandidatesToStoredPhoto(candidates, request.photo, request.storedPhoto),
    };
  } catch {
    return { outcome: 'failed' };
  }
}
