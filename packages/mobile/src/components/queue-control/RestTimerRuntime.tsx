// The rest timer's mount gate (#5378). Renders nothing itself.
//
// It subscribes to exactly one cheap boolean — "is the timer armed" — and mounts
// the runtime only when it is true. For the overwhelming majority of app
// sessions, where nobody arms a timer, the queue subscriptions and the
// session-detail query below never exist at all.
//
// Two parts sit OUTSIDE the gate. The stage pacing sync, so arming (from the
// Record tab, or Start with a timed block) already runs on the workout stage's
// cadence; without a workout it reads two cheap values and nothing else (see
// RestTimerPacingSync). And the crew publisher, which exists only while there
// is a session: a crewmate can turn the shared rest clock on for this phone, so
// it has to be listening before this phone is armed (see RestTimerCrewPublisher).

import { useRestTimerArmed } from '../../hooks/use-rest-timer';
import { RestTimerSessionSync } from './RestTimerSessionSync';
import { RestTimerAutoAdvanceScheduler } from './RestTimerAutoAdvanceScheduler';
import { RestTimerPacingSync } from './RestTimerPacingSync';
import { RestTimerCrewPublisher } from './RestTimerCrewPublisher';

export function RestTimerRuntime() {
  const armed = useRestTimerArmed();

  return (
    <>
      <RestTimerPacingSync />
      <RestTimerCrewPublisher />
      {armed ? (
        <>
          <RestTimerSessionSync />
          <RestTimerAutoAdvanceScheduler />
        </>
      ) : null}
    </>
  );
}
