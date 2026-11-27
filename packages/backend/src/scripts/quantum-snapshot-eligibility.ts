import { QUANTUM_RELEASED_LAYOUT_IDS } from '@boardsesh/board-constants/quantum';

const RELEASED_LAYOUT_IDS = QUANTUM_RELEASED_LAYOUT_IDS.join(', ');

/** Shared by both public artifact exporters. Prefixes are internal SQL aliases. */
export function snapshotQuantumEligibility(prefix = ''): string {
  return `(${prefix}board_type <> 'quantum' OR (
    ${prefix}layout_id IN (${RELEASED_LAYOUT_IDS})
    AND ${prefix}is_listed IS TRUE AND ${prefix}controller_route_uuid IS NOT NULL
  ))`;
}
