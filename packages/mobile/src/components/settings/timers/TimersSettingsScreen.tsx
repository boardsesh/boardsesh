import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreForm } from '../../MoreForm';
import { useSessionTimerDriver } from '../../../hooks/use-session-timer-driver';
import { hapticSelection } from '../../../lib/haptics';
import { isRestTimerSoundAvailable } from '../../../lib/rest-timer-cues';
import { changeRestTimerMode } from '../../../lib/rest-timer-mode-change';
import { withSettingTracking } from '../../../lib/settings-analytics';
import { useQueueSessionId } from '../../../providers/queue-provider';
import { useSetting } from '../../../settings';
import { buildTimersModel } from './timers-model';

/**
 * Settings › Timers. The rest timer's saved defaults and its cues, over the same
 * settings the in-session sheet writes, so the two always agree. A cadence change
 * goes through `changeRestTimerMode`, the one re-arm rule the sheet uses too.
 * Every change reports one `Setting Changed` under the `timers` page.
 */
export function TimersSettingsScreen() {
  const { t } = useTranslation('common');
  const [targetSeconds, setTargetSeconds] = useSetting('restTimerTargetSeconds');
  const [mode] = useSetting('restTimerMode');
  const [autoAdvance, setAutoAdvance] = useSetting('restTimerAutoAdvance');
  const [sound, setSound] = useSetting('restTimerSound');
  const { blockedReason } = useSessionTimerDriver();
  const { sessionId } = useQueueSessionId();
  // A build property, fixed for the life of the app.
  const soundAvailable = isRestTimerSoundAvailable();

  const onTargetChange = useCallback(
    (seconds: number | null) => {
      hapticSelection();
      setTargetSeconds(seconds);
    },
    [setTargetSeconds],
  );
  const onModeChange = useCallback(
    (nextMode: 'afterTick' | 'onTheMinute') => {
      if (changeRestTimerMode(nextMode, sessionId)) hapticSelection();
    },
    [sessionId],
  );
  const onToggle = useCallback((apply: (enabled: boolean) => void) => {
    return (enabled: boolean) => {
      hapticSelection();
      apply(enabled);
    };
  }, []);

  const model = useMemo(
    () =>
      withSettingTracking(
        buildTimersModel({
          t,
          rest: {
            targetSeconds,
            mode,
            autoAdvance,
            autoAdvanceBlockedByCrew: blockedReason !== null,
            onTargetChange,
            onModeChange,
            onAutoAdvanceChange: onToggle(setAutoAdvance),
          },
          cues: {
            // No reader on this branch yet: the countdown buzz lands with #5396,
            // which passes `{ enabled, onChange }` here.
            countdownCues: null,
            sound: soundAvailable ? { enabled: sound, onChange: onToggle(setSound) } : null,
          },
        }),
        'timers',
      ),
    [
      t,
      targetSeconds,
      mode,
      autoAdvance,
      blockedReason,
      onTargetChange,
      onModeChange,
      onToggle,
      setAutoAdvance,
      soundAvailable,
      sound,
      setSound,
    ],
  );

  return <MoreForm model={model} />;
}
