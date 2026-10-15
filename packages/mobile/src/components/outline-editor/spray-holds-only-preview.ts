import { holdRole, type SprayEditorHold } from './spray-hold-editor-reducer';
import { holdPathData } from './spray-hold-path';
import { ringToPathData } from './stroke';

/** A Refine session's kept strokes, before Done writes them to the editor reducer. */
export type RefinedHoldPreview = { holdId: number; outlineBoardPx: readonly number[] };

/**
 * Match the circle fallback's negative winding. All subpaths must wind alike:
 * opposite winding cancels the overlap of two ON holds in a nonzero SVG mask.
 */
function previewRing(ring: readonly number[]): number[] {
  let twiceArea = 0;
  for (let index = 0; index + 1 < ring.length; index += 2) {
    const next = (index + 2) % ring.length;
    twiceArea += ring[index] * ring[next + 1] - ring[next] * ring[index + 1];
  }
  if (twiceArea <= 0) return [...ring];
  const reversed: number[] = [];
  for (let index = ring.length - 2; index >= 0; index -= 2) reversed.push(ring[index], ring[index + 1]);
  return reversed;
}

/** The current ON holds, including local edits, as one union-shaped mask path. */
export function holdsOnlyPreviewPath(holds: readonly SprayEditorHold[], refined?: RefinedHoldPreview | null): string {
  const paths: string[] = [];
  for (const hold of holds) {
    if (holdRole(hold) !== 'on') continue;
    if (refined?.holdId === hold.id) {
      paths.push(ringToPathData(previewRing(refined.outlineBoardPx)));
    } else {
      paths.push(holdPathData(hold.outline ? { ...hold, outline: previewRing(hold.outline) } : hold));
    }
  }
  return paths.join('');
}
