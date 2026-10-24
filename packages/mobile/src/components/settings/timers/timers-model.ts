import type { RestTimerMode } from '../../../lib/rest-timer';
import {
  formatRestLength,
  hasRestLength,
  MAX_TAP_REST_LENGTH_SECONDS,
  REST_LENGTH_TAP_STEP_SECONDS,
} from '../../queue-control/rest-length.logic';
import type { MoreFormModel, MoreOption, MoreRow } from '../../MoreForm.types';
import type { SettingsTranslate } from '../root/settings-pages';

export type TimersModelInput = {
  t: SettingsTranslate;
  rest: {
    /** The saved rest length; `null` is Off. */
    targetSeconds: number | null;
    mode: RestTimerMode;
    autoAdvance: boolean;
    /** This phone may not move the wall (a crewmate drives it). Outranks a missing length. */
    autoAdvanceBlockedByCrew: boolean;
    onTargetChange: (seconds: number | null) => void;
    onModeChange: (mode: RestTimerMode) => void;
    onAutoAdvanceChange: (enabled: boolean) => void;
  };
  cues: {
    /**
     * `null` until something reads the setting and emits the countdown buzz
     * (#5396): the row is left out, never shown as a switch that does nothing.
     */
    countdownCues: { enabled: boolean; onChange: (enabled: boolean) => void } | null;
    /** `null` on a build that cannot play a sound: the row is left out, not greyed. */
    sound: { enabled: boolean; onChange: (enabled: boolean) => void } | null;
  };
};

const OFF_KEY = 'off';

/** The rungs the in-session pill steps through: 0:30 to 10:00 in 30 s. */
export const REST_LENGTH_LADDER_SECONDS: readonly number[] = Array.from(
  { length: MAX_TAP_REST_LENGTH_SECONDS / REST_LENGTH_TAP_STEP_SECONDS },
  (_, index) => (index + 1) * REST_LENGTH_TAP_STEP_SECONDS,
);

/**
 * Off, then the tap ladder, plus the saved length when it sits between rungs
 * (a 1:40 set with the slider, or a longer one). Without it the row would show a
 * choice nobody made.
 */
export function restLengthOptions(t: SettingsTranslate, targetSeconds: number | null): MoreOption[] {
  const seconds = [...REST_LENGTH_LADDER_SECONDS];
  if (hasRestLength(targetSeconds) && !seconds.includes(targetSeconds)) {
    seconds.push(targetSeconds);
    seconds.sort((first, second) => first - second);
  }
  return [
    { key: OFF_KEY, label: t('mobile.settings.timers.restLengthOff') },
    ...seconds.map((value) => ({ key: String(value), label: formatRestLength(value) })),
  ];
}

export function restLengthKey(targetSeconds: number | null): string {
  return hasRestLength(targetSeconds) ? String(targetSeconds) : OFF_KEY;
}

/** The root row's trailing value: the rest default, or Off. */
export function restLengthSummary(t: SettingsTranslate, targetSeconds: number | null): string {
  return hasRestLength(targetSeconds) ? formatRestLength(targetSeconds) : t('mobile.settings.timers.restLengthOff');
}

/**
 * Settings › Timers: the rest timer's saved defaults, then its countdown cues.
 * The in-session sheet edits the same settings, so the two always agree.
 */
export function buildTimersModel(input: TimersModelInput): MoreFormModel {
  const { t, rest, cues } = input;
  const hasLength = hasRestLength(rest.targetSeconds);

  const modeOptions: (MoreOption & { key: RestTimerMode })[] = [
    { key: 'afterTick', label: t('mobile.settings.timers.modeAfterTick') },
    {
      key: 'onTheMinute',
      label: hasLength
        ? t('mobile.settings.timers.modeEvery', { length: formatRestLength(rest.targetSeconds as number) })
        : t('mobile.settings.timers.modeOnTheMinute'),
    },
  ];

  const autoAdvanceSubtitle = rest.autoAdvanceBlockedByCrew
    ? t('mobile.settings.timers.autoAdvanceBlocked')
    : hasLength
      ? t('mobile.settings.timers.autoAdvanceHint')
      : t('mobile.settings.timers.autoAdvanceNeedsLength');

  const cueRows: MoreRow[] = [
    ...(cues.countdownCues
      ? [
          {
            kind: 'toggle' as const,
            key: 'countdownCues',
            label: t('mobile.settings.timers.countdownCues'),
            subtitle: t('mobile.settings.timers.countdownCuesHint'),
            value: cues.countdownCues.enabled,
            onValueChange: cues.countdownCues.onChange,
          },
        ]
      : []),
    ...(cues.sound
      ? [
          {
            kind: 'toggle' as const,
            key: 'sound',
            label: t('mobile.settings.timers.sound'),
            subtitle: t('mobile.settings.timers.soundHint'),
            value: cues.sound.enabled,
            onValueChange: cues.sound.onChange,
          },
        ]
      : []),
  ];

  return {
    sections: [
      {
        key: 'rest',
        title: t('mobile.settings.timers.restTitle'),
        footer:
          rest.mode === 'afterTick'
            ? t('mobile.settings.timers.modeAfterTickHint')
            : t('mobile.settings.timers.modeOnTheMinuteHint'),
        rows: [
          {
            kind: 'select',
            key: 'restLength',
            label: t('mobile.settings.timers.restLength'),
            options: restLengthOptions(t, rest.targetSeconds),
            selectedKey: restLengthKey(rest.targetSeconds),
            onSelect: (key) => rest.onTargetChange(key === OFF_KEY ? null : Number(key)),
          },
          {
            kind: 'segmented',
            key: 'restMode',
            label: t('mobile.settings.timers.modeLabel'),
            options: modeOptions,
            selectedKey: rest.mode,
            onSelect: (key) => {
              const next = modeOptions.find((option) => option.key === key);
              if (next) rest.onModeChange(next.key);
            },
          },
          {
            kind: 'toggle',
            key: 'autoAdvance',
            label: t('mobile.settings.timers.autoAdvance'),
            subtitle: autoAdvanceSubtitle,
            value: rest.autoAdvance,
            disabled: rest.autoAdvanceBlockedByCrew || !hasLength,
            onValueChange: rest.onAutoAdvanceChange,
          },
        ],
      },
      ...(cueRows.length > 0
        ? [
            {
              key: 'cues' as const,
              title: t('mobile.settings.timers.cuesTitle'),
              footer: t('mobile.settings.timers.cuesFooter'),
              rows: cueRows,
            },
          ]
        : []),
    ],
  };
}
