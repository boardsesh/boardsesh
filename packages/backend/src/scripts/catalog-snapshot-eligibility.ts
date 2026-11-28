import { HIDDEN_WITHDRAWN_CLIMB_BOARD_NAMES } from '@boardsesh/board-config';
import { QUANTUM_RELEASED_LAYOUT_IDS } from '@boardsesh/board-constants/quantum';

const RELEASED_LAYOUT_IDS = QUANTUM_RELEASED_LAYOUT_IDS.join(', ');
const HIDDEN_WITHDRAWN_BOARD_LIST = HIDDEN_WITHDRAWN_CLIMB_BOARD_NAMES.map((boardName) => `'${boardName}'`).join(', ');

/**
 * Whether a catalogue row may enter a public artifact. Shared by both public
 * artifact exporters; prefixes are internal SQL aliases. A Quantum row must be on
 * a released model, and on a board that hides withdrawn climbs a supplier row
 * ships only while it is listed and carries its supplier id. Every other board's
 * unlisted rows ship as they are, so a withdrawn MoonBoard problem still resolves.
 */
export function snapshotCatalogEligibility(prefix = ''): string {
  const releasedModel = `(${prefix}board_type <> 'quantum' OR ${prefix}layout_id IN (${RELEASED_LAYOUT_IDS}))`;
  const notWithdrawn = HIDDEN_WITHDRAWN_BOARD_LIST
    ? `(${prefix}board_type NOT IN (${HIDDEN_WITHDRAWN_BOARD_LIST}) OR (
    ${prefix}is_listed IS TRUE AND ${prefix}controller_route_uuid IS NOT NULL
  ))`
    : 'TRUE';
  return `(${releasedModel} AND ${notWithdrawn})`;
}
