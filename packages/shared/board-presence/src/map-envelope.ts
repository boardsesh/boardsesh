/**
 * Wire-format normaliser for board-presence subscription events.
 *
 * The presence subscription emits a `BoardPresenceEvent` union discriminated
 * by `__typename`. This narrows it into a reducer dispatch decision so callers
 * (web + mobile) only carry their `dispatch`, keeping the wire contract in one
 * place. Modelled on `mapSubscriptionEnvelopeToAction` in
 * `@boardsesh/queue-runtime`.
 */

import type { BoardPresenceEvent } from '@boardsesh/shared-schema';
import type { BoardPresenceAction } from './types';

/**
 * Map a presence subscription envelope to a reducer action, or `null` when the
 * event carries no actionable state (unknown/absent `__typename`).
 */
export function mapBoardPresenceEnvelopeToAction(event: BoardPresenceEvent): BoardPresenceAction | null {
  switch (event.__typename) {
    case 'BoardClimbSet':
      return { type: 'APPLY_CLIMB_SET', payload: event.climb };
    case 'BoardClimbCleared':
      return {
        type: 'APPLY_CLIMB_CLEARED',
        payload: { clearedAt: event.clearedAt, seq: event.seq },
      };
    case 'BoardStatsUpdated':
      return {
        type: 'APPLY_STATS_UPDATED',
        payload: { stats: event.stats, seq: event.seq },
      };
    case 'BoardConnectionChanged':
      return {
        type: 'APPLY_CONNECTION_CHANGED',
        payload: { holder: event.holder, seq: event.seq },
      };
    default:
      return null;
  }
}
