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
// the cadence they set once, and the transport last — at the bottom, in the
// thumb zone, because it is the only part you press without reading.

import { useCallback, useMemo } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { Button } from '../Button';
import { SwitchRow } from '../SwitchRow';
import { SectionHeader } from '../SectionHeader';
import { SegmentedControl } from '../SegmentedControl';
import { makeSelectHandler } from '../SegmentedControl.logic';
import type { SegmentOption } from '../SegmentedControl.types';
import { ScrollableTabs } from '../navigation/ScrollableTabs';
import { TickDestructiveRow } from '../tick/TickDestructiveRow';
import { TICK_ACTION_MAX_FONT_SCALE, TICK_GUTTER, tickActionHeight } from '../tick/tick-sheet-metrics';
import { useTheme } from '../../providers/theme-provider';
import { useQueueSessionId } from '../../providers/queue-provider';
import { useSessionTimerDriver } from '../../hooks/use-session-timer-driver';
import { useSetting } from '../../settings';
import { useRestTimerArmed, useRestTimerState } from '../../hooks/use-rest-timer';
import { nowMs } from '../../lib/clock';
import { hapticMedium } from '../../lib/haptics';
import { type RestTimerMode } from '../../lib/rest-timer';
import { changeRestTimerMode } from '../../lib/rest-timer-mode-change';
import { disarmRestTimer, pauseRestTimer, resetRestTimer, resumeRestTimer } from '../../lib/rest-timer-store';
import { spacing } from '../../theme/tokens';
import { RestTimerHeroClock } from './RestTimerPill';
import { RestLengthPicker } from './RestLengthPicker';
import { formatRestLength, hasRestLength } from './rest-length.logic';
import { RestTimerWorkoutPacingRow } from './RestTimerWorkoutPacingRow';
import {
  useCrewRestConfig,
  useCrewRestControlsConfig,
  useRestTimerStagePacing,
} from '../../hooks/use-effective-rest-pacing';
import { editCrewRestPacing } from '../../lib/crew-rest-cadence';
import { RestTimerCrewNote } from './RestTimerCrewNote';
import { restTimerCrewAutoAdvanceDescription } from './RestTimerPacerCaption';

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
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { targetSeconds, setTargetSeconds } = useRestPacingControls();

  return (
    // `inset={false}` cancels a caller-owned card gutter. The Record card now
    // cancels its gutter once around the whole group and uses the default here.
    <View style={inset ? null : styles.cardBleed}>
      {/* Label and value on ONE row: this is a field, not a section. A caption
          stacked over a lone pill left a third of the row empty and read as a
          heading for a group of one. `body` in `label` rather than the grey
          uppercase caption, for the same reason — it names the value beside it. */}
      {/* The picker draws this row itself and opens its slider on a full-width
          line under it — a slider sharing the row got only the pill's width. */}
      <View style={styles.lengthBlock}>
        <RestLengthPicker
          label={
            <Text variant="body" color={systemColors.label} style={styles.lengthLabel}>
              {t('mobile.restTimer.targetLabel')}
            </Text>
          }
          value={targetSeconds}
          onChange={setTargetSeconds}
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
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { autoAdvance, setAutoAdvance, targetSeconds } = useRestPacingControls();
  // The scheduler's own rule (lib/session-timer/driver-rule.ts), so the switch
  // can never say yes where the scheduler would refuse.
  const { blockedReason: driverBlockedReason, role, pacerDisplayName } = useSessionTimerDriver();
  const followsCrewClock = useCrewRestConfig() !== null;

  const blockedReason =
    driverBlockedReason !== null && !followsCrewClock
      ? t('mobile.restTimer.autoAdvanceBlocked')
      : hasRestLength(targetSeconds)
        ? null
        : t('mobile.restTimer.autoAdvanceNeedsLength');
  const crewDescription = followsCrewClock ? restTimerCrewAutoAdvanceDescription(role, pacerDisplayName, t) : null;

  return (
    <View style={styles.autoAdvanceGroup}>
      <SwitchRow
        label={t('mobile.restTimer.autoAdvance')}
        // Short enough to read at a glance. The "only while the app is open"
        // caveat lives in the group footnote below: SwitchRow includes both its
        // label and description in the accessible name.
        description={blockedReason ?? crewDescription ?? t('mobile.restTimer.autoAdvanceHint')}
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
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const { mode, targetSeconds, takeCrewPacing } = useRestPacingControls();
  // Only whether it is armed: the full state emits on every tick, pause and
  // reset, and this block sits on the Record card as well as the sheet.
  const armed = useRestTimerArmed();
  const { sessionId } = useQueueSessionId();

  const fixedWindowLabel = hasRestLength(targetSeconds)
    ? t('mobile.restTimer.modeEvery', { length: formatRestLength(targetSeconds) })
    : t('mobile.restTimer.modeOnTheMinute');

  const options = useMemo<SegmentOption<RestTimerMode>[]>(
    () => [
      { key: 'afterTick', label: t('mobile.restTimer.modeAfterTick') },
      { key: 'onTheMinute', label: fixedWindowLabel },
    ],
    [fixedWindowLabel, t],
  );

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
  // Match the iOS segmented control's large-text fallback. Paper's fixed-width
  // Android segments ellipsize the cadence labels when the text grows.
  const usesScrollingTabs = fontScale > 1.3;
  const CadenceControl = usesScrollingTabs ? ScrollableTabs : SegmentedControl;
  const handleScrollingSelect = useMemo(() => makeSelectHandler(handleSelect), [handleSelect]);

  return (
    <View style={inset ? null : styles.cardBleed}>
      <SectionHeader title={t('mobile.restTimer.modeLabel')} />
      <View style={styles.cadenceContent}>
        <CadenceControl
          options={options}
          selectedKey={mode}
          onSelect={usesScrollingTabs ? handleScrollingSelect : handleSelect}
          accessibilityLabel={t('mobile.restTimer.modeAria')}
        />
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {mode === 'afterTick' ? t('mobile.restTimer.modeAfterTickHint') : t('mobile.restTimer.modeOnTheMinuteHint')}
        </Text>
      </View>
    </View>
  );
}

type RestTimerSheetProps = {
  visible: boolean;
  onClose: () => void;
};

const REST_TIMER_SNAP_POINTS = ['90%'];

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
  // a fresh prop on both of them. Same shared height, 2:1 split and Dynamic Type
  // cap as TickActionBar (48pt, labels stop at 1.3x) — two different native
  // controls left to measure themselves land about 7pt apart and the row reads
  // crooked.
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
    // A bounded scroll body keeps the final action reachable at accessibility
    // sizes and on short screens. Content-fitting proposes an unbounded height
    // to the native host, so adding a ScrollView alone cannot bound its viewport.
    <ModalSheet visible={visible} snapPoints={REST_TIMER_SNAP_POINTS} scrollable onClose={onClose} enablePanDownToClose>
      {/* No container `gap`: each block owns its own rhythm (SectionHeader brings
          the section's top padding, each control its own inset), and a blanket
          gap on top of those produced the ladder of unequal seams the old sheet
          had. */}
      <View style={styles.content}>
        {/* The rest keeps running while this is open, so the sheet shows it. Its
            own leaf — the 1 Hz tick stops here and never reaches this form. */}
        <RestTimerHeroClock />

        {/* A crew's clock is everyone's: say so before the controls that change it. */}
        <RestTimerCrewNote placement="sheet" />

        {/* Rest, then cadence, then what happens when it runs out — the order
            you set them up in. The auto-advance switch carries no section
            heading: it names itself, and a caption over a single switch is a
            heading for a group of one. */}
        <RestTimerLengthControl />

        <RestTimerCadenceSection />

        <RestTimerAutoAdvanceRow />

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
            maxFontSizeMultiplier={TICK_ACTION_MAX_FONT_SCALE}
            style={transportStyles.primary}
          />
          <Button
            title={t('mobile.restTimer.reset')}
            icon="refresh"
            onPress={handleReset}
            disabled={waitingForFirstTick}
            variant="tonal"
            size="large"
            maxFontSizeMultiplier={TICK_ACTION_MAX_FONT_SCALE}
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
  // Cancels a caller-owned card gutter; each child re-applies TICK_GUTTER.
  cardBleed: {
    marginHorizontal: -spacing[4],
  },
  lengthBlock: {
    paddingHorizontal: TICK_GUTTER,
    paddingTop: spacing[1],
  },
  // Explanatory line under a group, aligned to the label seam the SwitchRow and
  // SectionHeader both use.
  lengthLabel: {
    flexShrink: 1,
  },
  groupFootnote: {
    paddingHorizontal: TICK_GUTTER,
    paddingTop: spacing[1],
  },
  cadenceContent: {
    paddingHorizontal: TICK_GUTTER,
    gap: spacing[2],
  },
  autoAdvanceGroup: {
    marginTop: spacing[4],
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
