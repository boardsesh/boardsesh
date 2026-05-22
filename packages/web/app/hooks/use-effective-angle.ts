'use client';

import { useContext } from 'react';
import { QueueBridgeBoardInfoContext } from '@/app/components/queue-control/queue-bridge-board-info-context';
import type { Climb } from '@/app/lib/types';

/**
 * Resolve the angle a user action should log/send at. Designed for log paths
 * (LogAscentForm, QuickTickBar, tick swipe actions) and any other surface
 * that needs the "current climbing angle" without silently defaulting to 0°.
 *
 * Priority — first present (NOT first non-zero — 0° is a real angle for
 * vertical-board climbs, see `ANGLES` in board-data.ts):
 *   1. The Queue Bridge angle (`useQueueBridgeBoardInfo`). After the
 *      group-session feedback fix this prefers the live route angle,
 *      falling back to the active party session's angle (parsed from
 *      `Session.boardPath`) for off-board surfaces, then the local
 *      current-climb's angle for solo. Gated on `hasActiveQueue` so the
 *      default-zero context value doesn't masquerade as a real 0°.
 *   2. The opening climb's own `angle` field when present (`!= null`).
 *      Handles log paths fired from surfaces where the bridge has no
 *      active queue yet (cold start on /you, ticking a public profile
 *      climb, etc.).
 *   3. `null`. Callers must surface a "pick an angle" affordance.
 *      Distinguish null from numeric 0 — a logged 0° is a real ascent,
 *      a logged null is a bug.
 */
export function useEffectiveAngle(climb?: Climb | null): number | null {
  // Read the bridge context directly via useContext so this hook works on
  // surfaces that don't sit beneath a GraphQLQueueProvider. The default
  // context value has `hasActiveQueue: false` (with angle: 0 as a
  // placeholder), so the flag — not the angle value — is the source of
  // truth for "is there a real angle here."
  const bridge = useContext(QueueBridgeBoardInfoContext);

  if (bridge.hasActiveQueue) {
    return bridge.angle;
  }

  if (climb?.angle != null) {
    return climb.angle;
  }

  return null;
}
