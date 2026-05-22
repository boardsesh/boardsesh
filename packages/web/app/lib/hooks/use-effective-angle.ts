'use client';

import { useContext } from 'react';
import { QueueBridgeBoardInfoContext } from '@/app/components/queue-control/queue-bridge-board-info-context';
import type { Climb } from '@/app/lib/types';

/**
 * Resolve the angle a user action should log/send at. Designed for log paths
 * (LogAscentForm, QuickTickBar, tick swipe actions) and any other surface
 * that needs the "current climbing angle" without silently defaulting to 0°.
 *
 * Priority order — first non-zero wins:
 *   1. The Queue Bridge angle (`useQueueBridgeBoardInfo`). After the
 *      group-session feedback fix this prefers the live route angle,
 *      falling back to the active party session's angle (parsed from
 *      `Session.boardPath`) for off-board surfaces, then the local
 *      current-climb's angle for solo.
 *   2. The opening climb's own `angle` field, when supplied. This handles
 *      log paths fired from surfaces where the bridge has no active queue
 *      yet (cold start on /you, ticking a public profile climb, etc.).
 *   3. `null`. Callers must surface a "pick an angle" affordance rather
 *      than silently defaulting to 0° — Aurora treats 0° as a real angle,
 *      not "missing".
 */
export function useEffectiveAngle(climb?: Climb | null): number | null {
  // Read the bridge context directly via useContext so this hook works on
  // surfaces that don't sit beneath a GraphQLQueueProvider. The default
  // context value has angle: 0 and hasActiveQueue: false — we treat the
  // combination as "no bridge angle available" and fall through.
  const bridge = useContext(QueueBridgeBoardInfoContext);

  if (bridge.hasActiveQueue && bridge.angle) {
    return bridge.angle;
  }

  if (climb?.angle != null && climb.angle > 0) {
    return climb.angle;
  }

  return null;
}
