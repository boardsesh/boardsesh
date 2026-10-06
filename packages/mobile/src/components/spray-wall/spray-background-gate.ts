// Which wall backgrounds an owner may pick, and what to tell them.
//
// Pure, so every state the picker can be in is a test row rather than a
// screenshot. The server makes the same call (`setSprayWallRenderSettings`
// refuses a generated look for a photo that fails the gate), and this reads its
// verdict rather than re-measuring: `sprayWallArt.quality` is computed live
// from the version's pins with the shared `photoQuality`.

import type { SprayWallArt } from '@boardsesh/graphql/generated/graphql';
import type { SprayWallBackground } from '../../lib/spray/spray-wall-background';

export type SprayBackgroundGate =
  /** No answer yet. The picker is not shown, so nothing jumps when it lands. */
  | { kind: 'loading' }
  /**
   * The backend predates generated looks, or could not say. The picker is not
   * shown at all, so nothing is sent that an older backend would refuse.
   */
  | { kind: 'unsupported' }
  /** The generated looks cannot be offered for this photo. */
  | { kind: 'locked'; reason: 'no-pins' | 'retake' }
  /** Offered. `soft` = usable, but a front-on retake would look sharper. */
  | { kind: 'open'; soft: boolean; status: 'none' | 'pending' | 'ready' | 'failed' };

export function sprayBackgroundGate(input: {
  status: 'pending' | 'error' | 'success';
  art: SprayWallArt | null | undefined;
}): SprayBackgroundGate {
  if (input.status === 'pending') return { kind: 'loading' };
  if (input.status === 'error' || !input.art) return { kind: 'unsupported' };
  const { quality, status } = input.art;
  if (quality.verdict === 'FAIL' || status === 'REFUSED') {
    return { kind: 'locked', reason: quality.reason === 'no-pins' ? 'no-pins' : 'retake' };
  }
  return {
    kind: 'open',
    soft: quality.verdict === 'SOFT',
    status: status === 'READY' ? 'ready' : status === 'PENDING' ? 'pending' : status === 'FAILED' ? 'failed' : 'none',
  };
}

/** Whether a background can be picked under this gate. The photo always can. */
export function canPickBackground(gate: SprayBackgroundGate, background: SprayWallBackground): boolean {
  return background === 'photo' || gate.kind === 'open';
}

/**
 * The background a NEW wall starts on: "Wall only" whenever its photo passes
 * the gate, the photo otherwise. Holds only is never the suggestion — volumes
 * are not detected, so it can drop them.
 */
export function suggestedBackground(gate: SprayBackgroundGate): SprayWallBackground {
  return gate.kind === 'open' ? 'wall-crop' : 'photo';
}

/** The one line of help under the control, by gate and choice. */
export function backgroundPickerNote(
  gate: SprayBackgroundGate,
  value: SprayWallBackground,
  isDraft: boolean,
): 'lockedNoPins' | 'lockedRetake' | 'generating' | 'failed' | 'afterPublish' | 'soft' | 'volumes' | null {
  if (gate.kind === 'locked') return gate.reason === 'no-pins' ? 'lockedNoPins' : 'lockedRetake';
  if (gate.kind !== 'open' || value === 'photo') return null;
  if (isDraft) return 'afterPublish';
  // NONE on a published version means the job is queued by this very read
  // (old recipe, or a wall published before generated looks): still coming.
  if (gate.status === 'pending' || gate.status === 'none') return 'generating';
  if (gate.status === 'failed') return 'failed';
  if (gate.soft) return 'soft';
  if (value === 'hold-cutouts') return 'volumes';
  return null;
}
