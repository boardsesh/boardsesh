import type { SprayLedPair } from '@boardsesh/spray-wall-geometry';

/** Both markers in a pair resolve to the same ordered unit. */
export function mapLedPairsById(pairs: readonly SprayLedPair[]): Map<string, SprayLedPair> {
  const byId = new Map<string, SprayLedPair>();
  for (const pair of pairs) {
    byId.set(pair[0], pair);
    byId.set(pair[1], pair);
  }
  return byId;
}
