// The rest timer's mount gate (#5378). Renders nothing itself.
//
// It subscribes to exactly one cheap boolean — "is the timer armed" — and mounts
// the runtime only when it is true. For the overwhelming majority of app
// sessions, where nobody arms a timer, the queue subscriptions and the
// session-detail query below never exist at all.
//
// The one exception is the stage pacing sync, which sits OUTSIDE the gate so
// arming (from the Record tab, or Start with a timed block) already runs on the
// workout stage's cadence. Without a workout it reads two cheap values and
// nothing else (see RestTimerPacingSync).

import { useRestTimerArmed } from '../../hooks/use-rest-timer';
import { RestTimerSessionSync } from './RestTimerSessionSync';
import { RestTimerAutoAdvanceScheduler } from './RestTimerAutoAdvanceScheduler';
import { RestTimerPacingSync } from './RestTimerPacingSync';

export function RestTimerRuntime() {
  const armed = useRestTimerArmed();

  return (
    <>
      <RestTimerPacingSync />
      {armed ? (
        <>
          <RestTimerSessionSync />
          <RestTimerAutoAdvanceScheduler />
        </>
      ) : null}
    </>
  );
}
