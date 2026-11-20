import {
  RestTimerLengthSettingView,
  RestTimerAutoAdvanceSettingView,
  RestTimerLockScreenRowView,
  RestTimerCadenceSettingView,
  RestTimerSheetView,
} from './RestTimerSheetViews';
// The rest timer's options sheet (#5378) — everything the pill can't say in one
// row, plus the live clock so it never reads as a dead settings page while the
// rest carries on underneath.
//
// Hosted, never routed: `docs/mobile/mobile-sheets-vs-routes.md` rule 1. It takes the
// CONTROLLED `visible` prop rather than an imperative ref, because each of the
// two hosts (root and play drawer) owns its own open state — see
// RestTimerPillHost.
//
// Reading order is the order a climber reaches for things: the clock they came
// to look at, the rest length they change most, what happens when it runs out,
// the cadence they set once, and the transport last — at the bottom, in the
// thumb zone, because it is the only part you press without reading.

import { useCallback, useMemo } from 'react';

import { useQueueSessionId } from '../../providers/queue-provider';
import { useSessionTimerDriver } from '../../hooks/use-session-timer-driver';
import { useSetting } from '../../settings';
import { useRestTimerArmed, useRestTimerState } from '../../hooks/use-rest-timer';
import { sessionPresenceSupportsRestTimer } from '../../lib/live-activity/live-activity-plugin';
import { nowMs } from '../../lib/clock';
import { hapticMedium } from '../../lib/haptics';
import { type RestTimerMode } from '../../lib/rest-timer';
import { changeRestTimerMode } from '../../lib/rest-timer-mode-change';
import { disarmRestTimer, pauseRestTimer, resetRestTimer, resumeRestTimer } from '../../lib/rest-timer-store';

import { RestTimerHeroClock } from './RestTimerPill';

import { RestTimerWorkoutPacingRow } from './RestTimerWorkoutPacingRow';
import {
  useCrewRestConfig,
  useCrewRestControlsConfig,
  useRestTimerStagePacing,
} from '../../hooks/use-effective-rest-pacing';
import { editCrewRestPacing } from '../../lib/crew-rest-cadence';
import { RestTimerCrewNote } from './RestTimerCrewNote';

/**
 * What the three rest controls below show (length, cadence, auto-advance) and
 * what an edit writes (#5382). With no crew clock, the climber's own settings,
 * as always. While this phone follows a crew clock, the crew clock's (Marco,
 * 2026-10-25): that is what the timer runs on and what everyone in the session
 * sees. An edit goes to the crew clock as its config with only that change
 * (`editCrewRestPacing`, a CONFIGURE), and the controls show it until the
 * server answers, so a second tap steps on from the first. The climber's
 * settings take the crew's values with the change too (`takeCrewPacing`), so
 * the length they picked is still theirs after the session.
 */
function useRestPacingControls() {
  const [ownTargetSeconds, writeTargetSeconds] = useSetting('restTimerTargetSeconds');
  const [ownMode, writeMode] = useSetting('restTimerMode');
  const [ownAutoAdvance, writeAutoAdvance] = useSetting('restTimerAutoAdvance');
  const crewConfig = useCrewRestControlsConfig();

  return useMemo(() => {
    if (crewConfig === null) {
      return {
        targetSeconds: ownTargetSeconds,
        mode: ownMode,
        autoAdvance: ownAutoAdvance,
        setTargetSeconds: writeTargetSeconds,
        setAutoAdvance: writeAutoAdvance,
        takeCrewPacing: () => {},
      };
    }
    const takeCrewPacing = () => {
      writeTargetSeconds(crewConfig.targetSeconds);
      writeMode(crewConfig.mode);
      writeAutoAdvance(crewConfig.autoAdvance);
    };
    return {
      targetSeconds: crewConfig.targetSeconds,
      mode: crewConfig.mode,
      autoAdvance: crewConfig.autoAdvance,
      setTargetSeconds: (next: number | null) => {
        editCrewRestPacing({ targetSeconds: next });
        takeCrewPacing();
        writeTargetSeconds(next);
      },
      setAutoAdvance: (next: boolean) => {
        editCrewRestPacing({ autoAdvance: next });
        takeCrewPacing();
        writeAutoAdvance(next);
      },
      takeCrewPacing,
    };
  }, [crewConfig, ownAutoAdvance, ownMode, ownTargetSeconds, writeAutoAdvance, writeMode, writeTargetSeconds]);
}

/**
 * The workout stage "Set by your workout" stands for, or null when the
 * controls show instead. In a crew the crew's clock is what runs (Marco,
 * 2026-10-25): the stage row only while that clock is a workout's pacing, and
 * the crew's controls once a crewmate changed it by hand.
 */
function useWorkoutPacingRowStage() {
  const stagePacing = useRestTimerStagePacing();
  const crewConfig = useCrewRestConfig();
  return crewConfig === null || crewConfig.source === 'stage' ? stagePacing : null;
}

/**
 * Rest length: one pill that steps 30 s a tap, and the fine slider it reveals on
 * a long press. Exported because the Record tab's arm row mounts the same
 * control — one implementation, two mounts, so the two surfaces can never
 * disagree about what "3:00" means.
 *
 * While a timed workout block paces the timer, "Set by your workout" stands in
 * for it (and the cadence and auto-advance controls step aside).
 */
export function RestTimerLengthControl({ inset = true }: { inset?: boolean } = {}) {
  const stagePacing = useWorkoutPacingRowStage();
  if (stagePacing !== null) return <RestTimerWorkoutPacingRow stage={stagePacing} inset={inset} />;
  return <RestTimerLengthSetting inset={inset} />;
}

function RestTimerLengthSetting({ inset }: { inset: boolean }) {
  const { targetSeconds, setTargetSeconds } = useRestPacingControls();

  return <RestTimerLengthSettingView inset={inset} targetSeconds={targetSeconds} setTargetSeconds={setTargetSeconds} />;
}

/**
 * The auto-advance switch, with both reasons it can't run made visible.
 *
 * In a crew only the climber driving the wall may move the shared queue (the
 * scheduler enforces the same rule). And with the rest length Off there is no
 * deadline at all, so the scheduler has nothing to fire on — a lit switch there
 * promises a thing that cannot happen. Either way the switch is DISABLED with
 * the reason spelled out, never silently ignored.
 *
 * The crew reason OUTRANKS the no-length one: a passenger who sets a rest length
 * still can't move the queue, so telling them to pick one would send them round
 * a loop that ends where it started.
 *
 * With a crew clock (#5382) auto-advance is the crew's setting instead: the
 * switch shows the crew's, anyone in the session may flip it, and the line
 * says whose phone moves the wall for everyone. Only the no-length reason
 * still blocks it, read from the crew's rest length: with none there is no
 * deadline for anyone's phone to move the wall on.
 *
 * Hidden while a workout stage paces the timer: a stage always auto-advances.
 */
export function RestTimerAutoAdvanceRow() {
  return useWorkoutPacingRowStage() === null ? <RestTimerAutoAdvanceSetting /> : null;
}

function RestTimerAutoAdvanceSetting() {
  const { autoAdvance, setAutoAdvance, targetSeconds } = useRestPacingControls();
  // The scheduler's own rule (lib/session-timer/driver-rule.ts), so the switch
  // can never say yes where the scheduler would refuse.
  const { blockedReason: driverBlockedReason, role, pacerDisplayName } = useSessionTimerDriver();
  const followsCrewClock = useCrewRestConfig() !== null;

  return (
    <RestTimerAutoAdvanceSettingView
      autoAdvance={autoAdvance}
      setAutoAdvance={setAutoAdvance}
      targetSeconds={targetSeconds}
      driverBlockedReason={driverBlockedReason}
      role={role}
      pacerDisplayName={pacerDisplayName}
      followsCrewClock={followsCrewClock}
    />
  );
}

/**
 * Whether the rest also counts down on the Lock Screen, in the Dynamic Island
 * and in the Android session notification (#6513). On by default; arming the
 * timer is the real opt-in. Hidden on a binary that cannot draw it, where the
 * switch would promise something nothing does.
 */
export function RestTimerLockScreenRow() {
  const [showOnLockScreen, setShowOnLockScreen] = useSetting('restTimerShowOnLockScreen');

  if (!sessionPresenceSupportsRestTimer) return null;

  return <RestTimerLockScreenRowView showOnLockScreen={showOnLockScreen} setShowOnLockScreen={setShowOnLockScreen} />;
}

/**
 * Cadence: what the countdown anchors to.
 *
 * Inline, not folded away. It is a binary with two visible options and a one-line
 * hint — a disclosure over that hides nothing worth hiding and costs a tap to
 * read a choice you can already see. Exported because the Record tab's arm row
 * mounts it too: that card is where a climber sets up a session, and without it
 * the card could only ever arm "after each send" (#5664).
 *
 * The fixed-window option names its own length ("Every 3:00"), because that is
 * the thing someone setting up a boulder-every-three-minutes block is looking
 * for. With the rest length Off there is no length to name, so it falls back to
 * the plain mode name.
 *
 * `inset={false}` cancels a caller-owned card gutter, exactly as for
 * {@link RestTimerLengthControl}. The Record card uses one shared wrapper for
 * all its controls, so it keeps the default inset here.
 *
 * Hidden while a workout stage paces the timer: the stage sets the cadence.
 */
export function RestTimerCadenceSection({ inset = true }: { inset?: boolean } = {}) {
  return useWorkoutPacingRowStage() === null ? <RestTimerCadenceSetting inset={inset} /> : null;
}

function RestTimerCadenceSetting({ inset }: { inset: boolean }) {
  const { mode, targetSeconds, takeCrewPacing } = useRestPacingControls();
  // Only whether it is armed: the full state emits on every tick, pause and
  // reset, and this block sits on the Record card as well as the sheet.
  const armed = useRestTimerArmed();
  const { sessionId } = useQueueSessionId();

  const handleSelect = useCallback(
    (nextMode: RestTimerMode) => {
      // The cadence on screen is the one to change from: the crew's while a crew
      // clock runs, which the settings only hold once it is copied over.
      if (nextMode === mode) return;
      editCrewRestPacing({ mode: nextMode });
      takeCrewPacing();
      changeRestTimerMode(nextMode, sessionId, armed);
    },
    [armed, mode, sessionId, takeCrewPacing],
  );

  return (
    <RestTimerCadenceSettingView inset={inset} mode={mode} targetSeconds={targetSeconds} onSelect={handleSelect} />
  );
}

type RestTimerSheetProps = {
  visible: boolean;
  onClose: () => void;
};

export function RestTimerSheet({ visible, onClose }: RestTimerSheetProps) {
  const { isRunning, anchorMs } = useRestTimerState();

  // `afterTick` before the first tick: armed and nominally running, but with no
  // anchor there is nothing to pause and nothing to reset. The buttons stay
  // MOUNTED and dimmed rather than disappearing, so the column under the
  // climber's thumb doesn't jump the moment they log a climb.
  const waitingForFirstTick = isRunning && anchorMs === null;

  const handleTogglePause = useCallback(() => {
    hapticMedium();
    if (isRunning) pauseRestTimer(nowMs());
    else resumeRestTimer(nowMs());
  }, [isRunning]);

  const handleReset = useCallback(() => {
    hapticMedium();
    resetRestTimer(nowMs());
  }, []);

  const handleTurnOff = useCallback(() => {
    disarmRestTimer();
    onClose();
  }, [onClose]);

  return (
    <RestTimerSheetView
      visible={visible}
      onClose={onClose}
      isRunning={isRunning}
      waitingForFirstTick={waitingForFirstTick}
      onTogglePause={handleTogglePause}
      onReset={handleReset}
      onTurnOff={handleTurnOff}
      clock={<RestTimerHeroClock />}
      crewNote={<RestTimerCrewNote placement="sheet" />}
      length={<RestTimerLengthControl />}
      cadence={<RestTimerCadenceSection />}
      autoAdvance={<RestTimerAutoAdvanceRow />}
      lockScreen={<RestTimerLockScreenRow />}
    />
  );
}
