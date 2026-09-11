// The rest timer's options sheet (#5378) — everything the pill can't say in one
// row, plus the live clock so it never reads as a dead settings page while the
// rest carries on underneath.
//
// Hosted, never routed: `docs/mobile-sheets-vs-routes.md` rule 1. It takes the
// CONTROLLED `visible` prop rather than an imperative ref, because each of the
// two hosts (root and play drawer) owns its own open state — see
// RestTimerPillHost.
//
// Reading order is the order a climber reaches for things: the clock they came
// to look at, the rest length they change most, what happens when it runs out,
// the cadence they set once (folded away), and the transport last — at the
// bottom, in the thumb zone, because it is the only part you press without
// reading.

import { useCallback, useMemo } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { Button } from '../Button';
import { SwitchRow } from '../SwitchRow';
import { SectionHeader } from '../SectionHeader';
import { CollapsibleSection } from '../CollapsibleSection';
import { SegmentedControl } from '../SegmentedControl';
import type { SegmentOption } from '../SegmentedControl.types';
import { TickDestructiveRow } from '../tick/TickDestructiveRow';
import { TICK_GUTTER, TICK_RAIL_ROW_HEIGHT, tickActionHeight } from '../tick/tick-sheet-metrics';
import { useTheme } from '../../providers/theme-provider';
import { useQueueSessionId, useIsSharedSession } from '../../providers/queue-provider';
import { useBoardConnectionState } from '../ble/use-board-connection-state';
import { useSetting } from '../../settings';
import { useRestTimerState } from '../../hooks/use-rest-timer';
import { nowMs } from '../../lib/clock';
import { hapticMedium } from '../../lib/haptics';
import { type RestTimerMode } from '../../lib/rest-timer';
import {
  armRestTimer,
  disarmRestTimer,
  pauseRestTimer,
  resetRestTimer,
  resumeRestTimer,
} from '../../lib/rest-timer-store';
import { spacing } from '../../theme/tokens';
import { RestTimerHeroClock } from './RestTimerPill';
import { RestLengthRail } from './RestLengthRail';
import { hasRestLength } from './rest-length-rail.logic';

/** Where the cadence section remembers whether it is open. */
const CADENCE_SECTION_KEY = 'restTimer.cadence';

/**
 * Rest length: one horizontal rail, `Off` then every length from 0:15 to 1:00:00.
 * Exported because the Record tab's arm row mounts the same control inline — one
 * implementation, two mounts, so the two surfaces can never disagree about what
 * "3:00" means.
 *
 * The rail is FULL-BLEED rather than sitting in a `TickFormRow`: starting it at
 * the 84pt control seam leaves about four and a half chips visible on a 393pt
 * screen, which reads as a cramped list rather than a rail you scrub.
 */
export function RestTimerLengthControl({ inset = true }: { inset?: boolean } = {}) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const [targetSeconds, setTargetSeconds] = useSetting('restTimerTargetSeconds');

  return (
    // `inset={false}` is the Record tab's padded `Card`: the rail has to reach
    // the card's edge, so the whole block pulls back out through the card's own
    // 16pt padding and re-applies it as content padding (SectionHeader and the
    // rail each already carry TICK_GUTTER).
    <View style={inset ? null : styles.cardBleed}>
      <SectionHeader title={t('mobile.restTimer.targetLabel')} />
      <View style={styles.railRow}>
        <RestLengthRail
          value={targetSeconds}
          onSelect={setTargetSeconds}
          accessibilityLabel={t('mobile.restTimer.targetAria')}
        />
      </View>
      {hasRestLength(targetSeconds) ? null : (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.groupFootnote}>
          {t('mobile.restTimer.lengthOffFootnote')}
        </Text>
      )}
    </View>
  );
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
 */
export function RestTimerAutoAdvanceRow() {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const [autoAdvance, setAutoAdvance] = useSetting('restTimerAutoAdvance');
  const [targetSeconds] = useSetting('restTimerTargetSeconds');
  const isSharedSession = useIsSharedSession();
  const { inAppBoardConnection } = useBoardConnectionState();
  const isCrewPassenger = isSharedSession && inAppBoardConnection !== 'connectedByMe';

  const blockedReason = isCrewPassenger
    ? t('mobile.restTimer.autoAdvanceBlocked')
    : hasRestLength(targetSeconds)
      ? null
      : t('mobile.restTimer.autoAdvanceNeedsLength');

  return (
    <View>
      <SwitchRow
        label={t('mobile.restTimer.autoAdvance')}
        // Short enough to read at a glance. The "only while the app is open"
        // caveat moved to the group footnote below — SwiftUI derives the Toggle's
        // VoiceOver name from BOTH its Text children (see SwitchRow.ios.tsx), so
        // leaving it here made the spoken name a paragraph.
        description={blockedReason ?? t('mobile.restTimer.autoAdvanceHint')}
        value={autoAdvance}
        onValueChange={setAutoAdvance}
        disabled={blockedReason !== null}
      />
      {blockedReason === null ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.groupFootnote}>
          {t('mobile.restTimer.autoAdvanceFootnote')}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Cadence: what the countdown anchors to.
 *
 * Folded away by default. It is a set-once choice (the arm row says as much by
 * leaving it out entirely), and changing it RE-ARMS the live timer — so it must
 * not sit one careless tap from the rail, which is the control on this sheet
 * people actually come back for.
 */
function RestTimerCadenceSection() {
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

  const modeLabel = mode === 'afterTick' ? t('mobile.restTimer.modeAfterTick') : t('mobile.restTimer.modeOnTheMinute');

  return (
    <View style={styles.cadenceBlock}>
      <CollapsibleSection title={t('mobile.restTimer.modeLabel')} summary={modeLabel} persistKey={CADENCE_SECTION_KEY}>
        <View style={styles.cadenceContent}>
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
      </CollapsibleSection>
    </View>
  );
}

type RestTimerSheetProps = {
  visible: boolean;
  onClose: () => void;
};

export function RestTimerSheet({ visible, onClose }: RestTimerSheetProps) {
  const { t } = useTranslation('session');
  const { fontScale } = useWindowDimensions();
  const { isRunning, anchorMs } = useRestTimerState();

  // `afterTick` before the first tick: armed and nominally running, but with no
  // anchor there is nothing to pause and nothing to reset. The buttons stay
  // MOUNTED and dimmed rather than disappearing, so the column under the
  // climber's thumb doesn't jump the moment they log a climb.
  const waitingForFirstTick = isRunning && anchorMs === null;

  // Memoized: `Button` is a native host, so a fresh style object every render is
  // a fresh prop on both of them. Same shared height and 2:1 split as
  // TickActionBar — two different native controls left to measure themselves
  // land about 7pt apart and the row reads crooked.
  const transportStyles = useMemo(() => transportButtonStyles(tickActionHeight(fontScale)), [fontScale]);

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
    // Solid ground: this is a form, not chrome — reading a rail and a segmented
    // control through the board art behind it is unreadable. Sized to its
    // content, and deliberately WITHOUT `header` / `footer`: `enableDynamicSizing`
    // with sheet chrome but no `androidContentSized` gives the Android column
    // `flex: 1` under a `matchContents` host, which resolves to zero (#4720).
    <ModalSheet visible={visible} surface="solid" enableDynamicSizing onClose={onClose} enablePanDownToClose>
      {/* No container `gap`: each block owns its own rhythm (SectionHeader brings
          its own top padding, the collapsible its own inset), and a blanket gap
          on top of those produced the ladder of unequal seams the old sheet had. */}
      <View style={styles.content}>
        {/* The rest keeps running while this is open, so the sheet shows it. Its
            own leaf — the 1 Hz tick stops here and never reaches this form. */}
        <RestTimerHeroClock />

        <RestTimerLengthControl />

        <View>
          <SectionHeader title={t('mobile.restTimer.whenUpLabel')} />
          <RestTimerAutoAdvanceRow />
        </View>

        <RestTimerCadenceSection />

        {/* Transport last, in the thumb zone. Tonal Reset rather than a text
            button: same silhouette as Pause, one emphasis step down, so it stops
            reading as a link floating beside a button. */}
        <View style={styles.transportRow}>
          <Button
            title={isRunning ? t('mobile.restTimer.pause') : t('mobile.restTimer.resume')}
            icon={isRunning ? 'pause' : 'play.fill'}
            onPress={handleTogglePause}
            disabled={waitingForFirstTick}
            variant="filled"
            size="large"
            style={transportStyles.primary}
          />
          <Button
            title={t('mobile.restTimer.reset')}
            icon="refresh"
            onPress={handleReset}
            disabled={waitingForFirstTick}
            variant="tonal"
            size="large"
            style={transportStyles.secondary}
          />
        </View>

        {/* The one way to turn the timer off from wherever you happen to be. A
            STOP glyph, not a clock: the clock is the same glyph as the pill that
            opened this sheet, so it read as "set a timer" — the opposite. */}
        <View style={styles.destructiveGroup}>
          <TickDestructiveRow label={t('mobile.restTimer.turnOff')} icon="end.session" onPress={handleTurnOff} />
        </View>

        {/* Nothing below the destructive row: ModalSheet's footerless branch
            already composes the window inset into the body. */}
      </View>
    </ModalSheet>
  );
}

/** The transport row's two buttons: one shared height, and the 2:1 split that
 *  makes Pause the bigger object. Mirrors `tickButtonStyles` in TickActionBar. */
function transportButtonStyles(height: number) {
  return {
    primary: { flex: 2, height },
    secondary: { flex: 1, height },
  };
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing[2],
  },
  // Pulls the block back out through the Record tab card's 16pt padding so the
  // rail bleeds to the card edge; every child re-applies TICK_GUTTER itself.
  cardBleed: {
    marginHorizontal: -spacing[4],
  },
  railRow: {
    height: TICK_RAIL_ROW_HEIGHT,
    justifyContent: 'center',
  },
  // Explanatory line under a group, aligned to the label seam the SwitchRow and
  // SectionHeader both use.
  groupFootnote: {
    paddingHorizontal: TICK_GUTTER,
    paddingTop: spacing[1],
  },
  cadenceBlock: {
    marginHorizontal: TICK_GUTTER,
    marginTop: spacing[6],
  },
  cadenceContent: {
    gap: spacing[2],
  },
  transportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: TICK_GUTTER,
    marginTop: spacing[6],
  },
  destructiveGroup: {
    marginTop: spacing[8],
  },
});
