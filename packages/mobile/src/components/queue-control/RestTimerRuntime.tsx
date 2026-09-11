// The rest timer's mount gate (#5378). Renders nothing itself.
//
// It subscribes to exactly one cheap boolean — "is the timer armed" — and mounts
// the runtime only when it is true. For the overwhelming majority of app
// sessions, where nobody arms a timer, the queue subscriptions and the
// session-detail query below never exist at all.

import { useRestTimerArmed } from '../../hooks/use-rest-timer';
import { RestTimerSessionSync } from './RestTimerSessionSync';
import { RestTimerAutoAdvanceScheduler } from './RestTimerAutoAdvanceScheduler';

export function RestTimerRuntime() {
  const armed = useRestTimerArmed();

  if (!armed) return null;

  return (
    <>
      <RestTimerSessionSync />
      <RestTimerAutoAdvanceScheduler />
    </>
  );
}
