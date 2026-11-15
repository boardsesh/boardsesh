import { formatShowcaseAnchorLine, type LayoutObservation } from '../../lib/showcase-anchor';
/** Existing showcase-video recorder protocol; only dev roots install this observer. */
export function reportLayoutObservation({ name, x, y, width, height }: LayoutObservation): void {
  const line = formatShowcaseAnchorLine(name, x, y, width, height);
  if (line) console.log(line);
}
