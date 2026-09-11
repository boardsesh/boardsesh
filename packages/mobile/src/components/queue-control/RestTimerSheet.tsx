// The rest timer's options sheet (#5378) — everything the pill can't say in one
// row, plus the live clock so it never reads as a dead settings page while the
// rest carries on underneath.
//
// Hosted, never routed: `docs/mobile-sheets-vs-routes.md` rule 1. It takes the
// CONTROLLED `visible` prop rather than an imperative ref, because each of the
// two hosts (root and play drawer) owns its own open state — see
// RestTimerPillHost.

import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { ListRow } from '../ListRow';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { Button } from '../Button';
import { Stepper } from '../Stepper';
import { SwitchRow } from '../SwitchRow';
import { SegmentedControl } from '../SegmentedControl';
import type { SegmentOption } from '../SegmentedControl.types';
import { useTheme } from '../../providers/theme-provider';
import { useQueueSessionId, useIsSharedSession } from '../../providers/queue-provider';
import { useBoardConnectionState } from '../ble/use-board-connection-state';
import { useSetting } from '../../settings';
import { useRestTimerState } from '../../hooks/use-rest-timer';
import { nowMs } from '../../lib/clock';
import { formatRestTimerElapsed, type RestTimerMode } from '../../lib/rest-timer';
import {
  armRestTimer,
  disarmRestTimer,
  pauseRestTimer,
  resetRestTimer,
  resumeRestTimer,
} from '../../lib/rest-timer-store';
import { spacing } from '../../theme/tokens';
import { RestTimerClock } from './RestTimerPill';

/** The one-tap rest lengths. Anything else is Custom. */
const REST_LENGTH_PRESETS = [60, 120, 180, 300] as const;

type RestLengthKey = 'off' | 'custom' | `${(typeof REST_LENGTH_PRESETS)[number]}`;

const CUSTOM_STEP_SECONDS = 15;
const CUSTOM_MIN_SECONDS = 15;
const CUSTOM_MAX_SECONDS = 3600;
/** Where Custom starts from when the timer had no length at all. */
const DEFAULT_CUSTOM_SECONDS = 90;

function isCustomTarget(targetSeconds: number | null): boolean {
  if (targetSeconds === null) return false;
  return !REST_LENGTH_PRESETS.some((preset) => preset === targetSeconds);
}

/**
 * `Stepper` steps by one, and a rest length that moved a second at a time would
 * take 240 taps to cross a minute. So the stepper's value IS the rest in seconds
 * (which is exactly what its accessibility label says it is), and each ±1 is
 * rounded away from where it started to the next 15 s mark — one tap, one step.
 */
function snapCustomSeconds(nextSeconds: number, previousSeconds: number): number {
  const snapped =
    nextSeconds > previousSeconds
      ? Math.ceil(nextSeconds / CUSTOM_STEP_SECONDS) * CUSTOM_STEP_SECONDS
      : Math.floor(nextSeconds / CUSTOM_STEP_SECONDS) * CUSTOM_STEP_SECONDS;
  return Math.min(CUSTOM_MAX_SECONDS, Math.max(CUSTOM_MIN_SECONDS, snapped));
}

/**
 * Rest length: `Off · 1:00 · 2:00 · 3:00 · 5:00 · Custom`, with Custom revealing
 * a 15-second stepper. Exported because the Record tab's arm row reveals the
 * same control inline — one implementation, two mounts, so the two surfaces can
 * never disagree about what "3:00" means.
 */
export function RestTimerLengthControl({ inset = true }: { inset?: boolean } = {}) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const [targetSeconds, setTargetSeconds] = useSetting('restTimerTargetSeconds');
  // Keeps Custom selected after the climber steps onto a value that happens to
  // equal a preset (e.g. 1:00), instead of the segment jumping under their thumb.
  const [customPinned, setCustomPinned] = useState<boolean>(() => isCustomTarget(targetSeconds));

  const options = useMemo<SegmentOption<RestLengthKey>[]>(
    () => [
      { key: 'off', label: t('mobile.restTimer.off') },
      ...REST_LENGTH_PRESETS.map((preset) => ({
        key: String(preset) as RestLengthKey,
        label: formatRestTimerElapsed(preset),
      })),
      { key: 'custom', label: t('mobile.restTimer.custom') },
    ],
    [t],
  );

  const showCustom = targetSeconds !== null && (customPinned || isCustomTarget(targetSeconds));
  const selectedKey: RestLengthKey =
    targetSeconds === null ? 'off' : showCustom ? 'custom' : (String(targetSeconds) as RestLengthKey);

  const handleSelect = useCallback(
    (key: RestLengthKey) => {
      if (key === 'off') {
        setCustomPinned(false);
        setTargetSeconds(null);
        return;
      }
      if (key === 'custom') {
        const seed = targetSeconds ?? DEFAULT_CUSTOM_SECONDS;
        setCustomPinned(true);
        setTargetSeconds(snapCustomSeconds(seed, seed));
        return;
      }
      setCustomPinned(false);
      setTargetSeconds(Number(key));
    },
    [setTargetSeconds, targetSeconds],
  );

  const handleCustomChange = useCallback(
    (nextSeconds: number) => {
      setTargetSeconds(snapCustomSeconds(nextSeconds, targetSeconds ?? nextSeconds));
    },
    [setTargetSeconds, targetSeconds],
  );

  return (
    <View style={[styles.section, inset ? styles.sectionInset : null]}>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionLabel}>
        {t('mobile.restTimer.targetLabel')}
      </Text>
      <SegmentedControl
        options={options}
        selectedKey={selectedKey}
        onSelect={handleSelect}
        accessibilityLabel={t('mobile.restTimer.targetAria')}
      />
      {showCustom ? (
        <Stepper
          label={t('mobile.restTimer.customAria')}
          value={targetSeconds}
          min={CUSTOM_MIN_SECONDS}
          max={CUSTOM_MAX_SECONDS}
          onChange={handleCustomChange}
        />
      ) : null}
    </View>
  );
}

/**
 * The auto-advance switch, with the passenger rule made visible. In a crew only
 * the climber driving the wall may move the shared queue (the scheduler enforces
 * the same rule), so for everyone else the switch is DISABLED with the reason
 * spelled out — never silently ignored.
 */
export function RestTimerAutoAdvanceRow() {
  const { t } = useTranslation('session');
  const [autoAdvance, setAutoAdvance] = useSetting('restTimerAutoAdvance');
  const isSharedSession = useIsSharedSession();
  const { inAppBoardConnection } = useBoardConnectionState();
  const blocked = isSharedSession && inAppBoardConnection !== 'connectedByMe';

  return (
    <SwitchRow
      label={t('mobile.restTimer.autoAdvance')}
      description={blocked ? t('mobile.restTimer.autoAdvanceBlocked') : t('mobile.restTimer.autoAdvanceHint')}
      value={autoAdvance}
      onValueChange={setAutoAdvance}
      disabled={blocked}
    />
  );
}

/** Cadence: what the countdown anchors to. Sheet-only — the Record tab's arm row
 *  keeps to the two controls a climber changes mid-session (length, auto-advance). */
function RestTimerModeControl() {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const [mode, setMode] = useSetting('restTimerMode');
  const { armed } = useRestTimerState();
  const { sessionId } = useQueueSessionId();

  const options = useMemo<SegmentOption<RestTimerMode>[]>(
    () => [
      { key: 'afterTick', label: t('mobile.restTimer.modeAfterTick') },
      { key: 'onTheMinute', label: t('mobile.restTimer.modeOnTheMinute') },
    ],
    [t],
  );

  const handleSelect = useCallback(
    (nextMode: RestTimerMode) => {
      setMode(nextMode);
      // Re-arm rather than leave a half-converted anchor: `onTheMinute` needs an
      // anchor from this instant, `afterTick` needs none until the next tick, and
      // the two cannot be reconciled by editing the existing one.
      if (armed) armRestTimer(nextMode, nowMs(), sessionId);
    },
    [armed, sessionId, setMode],
  );

  return (
    <View style={[styles.section, styles.sectionInset]}>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionLabel}>
        {t('mobile.restTimer.modeLabel')}
      </Text>
      <SegmentedControl
        options={options}
        selectedKey={mode}
        onSelect={handleSelect}
        accessibilityLabel={t('mobile.restTimer.modeAria')}
      />
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {mode === 'afterTick' ? t('mobile.restTimer.modeAfterTickHint') : t('mobile.restTimer.modeOnTheMinuteHint')}
      </Text>
    </View>
  );
}

type RestTimerSheetProps = {
  visible: boolean;
  onClose: () => void;
};

export function RestTimerSheet({ visible, onClose }: RestTimerSheetProps) {
  const { t } = useTranslation('session');
  const { brandColors } = useTheme();
  const { isRunning } = useRestTimerState();

  const handleTogglePause = useCallback(() => {
    if (isRunning) pauseRestTimer(nowMs());
    else resumeRestTimer(nowMs());
  }, [isRunning]);

  const handleReset = useCallback(() => {
    resetRestTimer(nowMs());
  }, []);

  const handleTurnOff = useCallback(() => {
    disarmRestTimer();
    onClose();
  }, [onClose]);

  return (
    // Solid ground: this is a form, not chrome — reading a stepper and two
    // segmented controls through the board art behind it is unreadable. Sized to
    // its content so the pinned "Turn off" row is never stranded off-screen.
    <ModalSheet visible={visible} surface="solid" enableDynamicSizing onClose={onClose} enablePanDownToClose>
      <View style={styles.content}>
        {/* The rest keeps running while this is open, so the sheet shows it. */}
        <View style={styles.clockRow}>
          <RestTimerClock variant="title1" />
        </View>

        <View style={styles.actionsRow}>
          <Button
            title={isRunning ? t('mobile.restTimer.pause') : t('mobile.restTimer.resume')}
            onPress={handleTogglePause}
            variant="filled"
          />
          <Button title={t('mobile.restTimer.reset')} onPress={handleReset} variant="text" />
        </View>

        <RestTimerLengthControl />
        <RestTimerModeControl />
        <RestTimerAutoAdvanceRow />

        {/* Pinned last and tinted like BleControlSheet's Disconnect: the one way
            to turn the timer off from wherever you happen to be. */}
        <ListRow
          title={t('mobile.restTimer.turnOff')}
          leading={<Icon name="clock" size={22} color={brandColors.error} />}
          onPress={handleTurnOff}
          showSeparator={false}
          style={styles.turnOffRow}
          accessibilityLabel={t('mobile.restTimer.turnOff')}
        />
      </View>
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing[2],
    gap: spacing[4],
  },
  clockRow: {
    alignItems: 'center',
    paddingTop: spacing[2],
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
  },
  section: {
    gap: spacing[2],
  },
  // The sheet's own gutter. Omitted inside the Record tab's card, which already
  // pads 16 — see RestTimerLengthControl's `inset`.
  sectionInset: {
    paddingHorizontal: spacing[4],
  },
  sectionLabel: {
    textTransform: 'uppercase',
  },
  turnOffRow: {
    marginTop: spacing[2],
  },
});
