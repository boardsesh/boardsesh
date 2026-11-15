import { useState } from 'react';
import { RestTimerHeroClockView, type RestTimerDisplay } from '../../components/queue-control/RestTimerViews';
import { RestTimerPacerCaptionView } from '../../components/queue-control/RestTimerPacerCaption';
import { RestTimerCrewNoteView } from '../../components/queue-control/RestTimerCrewNote';
import {
  RestTimerLengthSettingView,
  RestTimerAutoAdvanceSettingView,
  RestTimerCadenceSettingView,
  RestTimerLockScreenRowView,
  RestTimerSheetView,
} from '../../components/queue-control/RestTimerSheetViews';
import { RestTimerWorkoutPacingRow } from '../../components/queue-control/RestTimerWorkoutPacingRow';
import { formatRestTimerElapsed, formatRestTimerSigned, type RestTimerMode } from '../../lib/rest-timer';
import type { WallDriverRole } from '../../lib/session-timer/driver-rule';
import type { RestTimerStagePacing } from '../../lib/rest-timer-pacing';

export function timerDisplay(secondsLeft = 80, targetSeconds = 120): RestTimerDisplay {
  return {
    armed: true,
    isRunning: true,
    phase: secondsLeft < 0 ? 'exceeded' : secondsLeft <= 3 ? 'final' : 'running',
    elapsedSeconds: targetSeconds - secondsLeft,
    targetSeconds,
    remainingSeconds: secondsLeft,
    displayLabel: formatRestTimerSigned(secondsLeft),
    targetLabel: formatRestTimerElapsed(targetSeconds),
    listEnded: false,
    leadSeconds: 3,
  };
}
export function RestTimerScene({
  role = 'solo',
  stage,
  onReady,
}: {
  role?: WallDriverRole;
  stage?: RestTimerStagePacing;
  onReady: () => void;
}) {
  const [visible, setVisible] = useState(true);
  const [running, setRunning] = useState(true);
  const [target, setTarget] = useState<number | null>(stage?.targetSeconds ?? 120);
  const [mode, setMode] = useState<RestTimerMode>(stage?.mode ?? 'onTheMinute');
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [lockScreen, setLockScreen] = useState(true);
  const [elapsed, setElapsed] = useState(40);
  const display = { ...timerDisplay((target ?? 120) - elapsed, target ?? 120), isRunning: running };
  if (!running) display.phase = 'paused';
  const close = () => setVisible(false);
  return (
    <RestTimerSheetView
      visible={visible}
      onPresented={onReady}
      onClose={close}
      isRunning={running}
      waitingForFirstTick={false}
      onTogglePause={() => setRunning((previous) => !previous)}
      onReset={() => setElapsed(0)}
      onTurnOff={close}
      clock={
        <RestTimerHeroClockView
          display={display}
          pacer={
            <RestTimerPacerCaptionView
              role={role}
              pacerDisplayName="Sam"
              variant="subheadline"
              centered
              scalesWithText
            />
          }
        />
      }
      crewNote={<RestTimerCrewNoteView placement="sheet" status="shared" isCrewSession={role !== 'solo'} />}
      length={
        stage ? (
          <RestTimerWorkoutPacingRow stage={stage} />
        ) : (
          <RestTimerLengthSettingView inset targetSeconds={target} setTargetSeconds={setTarget} />
        )
      }
      cadence={
        stage ? null : <RestTimerCadenceSettingView inset mode={mode} targetSeconds={target} onSelect={setMode} />
      }
      autoAdvance={
        stage ? null : (
          <RestTimerAutoAdvanceSettingView
            autoAdvance={autoAdvance}
            setAutoAdvance={setAutoAdvance}
            targetSeconds={target}
            driverBlockedReason={role === 'passenger' ? 'heldByPeer' : null}
            role={role}
            pacerDisplayName="Sam"
            followsCrewClock={role !== 'solo'}
          />
        )
      }
      lockScreen={<RestTimerLockScreenRowView showOnLockScreen={lockScreen} setShowOnLockScreen={setLockScreen} />}
    />
  );
}
