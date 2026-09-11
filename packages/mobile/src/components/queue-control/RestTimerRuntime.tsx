// The rest timer's mount gate (#5378). Renders nothing itself.
//
// It subscribes to exactly two cheap booleans — the rollout flag and "is the
// timer armed" — and mounts the runtime only when both are true. For the
// overwhelming majority of app sessions, where nobody arms a timer, the queue
// subscriptions and the session-detail query below never exist at all.

import { useEffect } from 'react';
import { useRestTimerEnabled } from '../../providers/feature-flags-provider';
import { useRestTimerArmed } from '../../hooks/use-rest-timer';
import { disarmRestTimer } from '../../lib/rest-timer-store';
import { RestTimerSessionSync } from './RestTimerSessionSync';
import { RestTimerAutoAdvanceScheduler } from './RestTimerAutoAdvanceScheduler';

export function RestTimerRuntime() {
  const enabled = useRestTimerEnabled();
  const armed = useRestTimerArmed();

  // Pulling the rollout must STOP an armed timer, not leave it driving a wall
  // with no UI to turn it off.
  useEffect(() => {
    if (!enabled && armed) disarmRestTimer();
  }, [armed, enabled]);

  if (!enabled || !armed) return null;

  return (
    <>
      <RestTimerSessionSync />
      <RestTimerAutoAdvanceScheduler />
    </>
  );
}
