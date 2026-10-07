// How cleanly a set of corner pins would flatten into the generated wall looks
// ("Wall only", "Holds only"), as one sentence for the corner step. The grade is
// the shared `photoQuality`, the same one the server stores a look against.

import { photoQuality, type Quad, type ReferenceSize } from '@boardsesh/spray-wall-geometry';

/** Which sentence grades the current corners, or null for none. Exported for tests. */
export function cornerQualityNote(
  quad: Quad | null,
  frame: ReferenceSize | null | undefined,
): 'good' | 'soft' | 'fail' | 'small' | null {
  if (!quad || !frame) return null;
  const quality = photoQuality(quad, frame);
  if (quality.verdict === 'good') return 'good';
  if (quality.verdict === 'soft') return 'soft';
  return quality.reason === 'small-frame' ? 'small' : 'fail';
}
