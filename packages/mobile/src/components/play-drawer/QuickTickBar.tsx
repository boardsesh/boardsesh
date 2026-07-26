// Ticking form contents. Always rendered inside `LogAscentSheet`'s
// BottomSheetModal — the sheet owns positioning, slide-in, backdrop,
// pan-down-to-close, and the drag handle. This component is just the
// pickers + save row.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, type TextStyle } from 'react-native';
import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import {
  createInitialTickState,
  deriveAscentType,
  clampAttempts,
  MIN_ATTEMPT_COUNT,
  type TickStatus,
} from '@boardsesh/play-view';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { InlineStarPicker } from './InlineStarPicker';
import { InlineTriesPicker } from './InlineTriesPicker';
import { GradeSingleSelectRail } from '../grade';
import { ClimbedAtField } from '../logbook/ClimbedAtField';
import { clampToNow, MAXIMUM_CLIMBED_AT_REFRESH_MS } from '../logbook/climbed-at';
import { useTheme } from '../../providers/theme-provider';
import { useGrades } from '../../lib/graphql/hooks';
import {
  useOptionalBoardActions,
  useOptionalBoardLogbook,
  useSaveTick,
  logbookClimbAngleKey,
} from '@boardsesh/board-react';
import { toBoardName } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useToast } from '../../providers/toast-provider';
import { useOptionalRogueTimer } from '../../providers/rogue-timer-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useLocalPendingTicks } from '../../hooks/use-local-ticks';
import { track } from '../../lib/analytics';
import { hapticSuccess, hapticError } from '../../lib/haptics';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

// Read once at module load rather than allocating a fresh createInitialTickState()
// on every field-snapshot sync (see below) just to read this one default.
const DEFAULT_ATTEMPT_COUNT = createInitialTickState().attemptCount;

// Field-completeness snapshot for the "abandoned the form" analytics event.
// Owned by QuickTickBar (only place with the tick-state fields) but read by
// LogAscentSheet, which is the only place able to see the X-button and
// pan-down dismiss paths that never call onDismiss themselves.
export type QuickTickDismissSnapshot = {
  hasQuality: boolean;
  hasDifficulty: boolean;
  hasComment: boolean;
  attemptCountChanged: boolean;
};

export type QuickTickBarProps = {
  climbUuid: string;
  boardName: string;
  angle: number;
  isMirror: boolean;
  isBenchmark: boolean;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  sessionId?: string | null;
  // The climb's consensus grade label (e.g. "V5", "7a+"). Resolved to a
  // numeric difficulty id at render time via the loaded grades list and
  // forwarded to GradeSingleSelectRail so the consensus chip is centered (and
  // visually outlined) without being preselected.
  consensusGradeName?: string;
  onDismiss: () => void;
  // Optional analytics plumbing for LogAscentSheet's dismiss tracking. Both
  // are refs (not state) so updating them never triggers a re-render.
  savedRef?: React.RefObject<boolean>;
  fieldSnapshotRef?: React.RefObject<QuickTickDismissSnapshot>;
};

export const QuickTickBar = React.memo(function QuickTickBar({
  climbUuid,
  boardName,
  angle,
  isMirror,
  isBenchmark,
  layoutId,
  sizeId,
  setIds,
  sessionId,
  consensusGradeName,
  onDismiss,
  savedRef,
  fieldSnapshotRef,
}: QuickTickBarProps) {
  const { t } = useTranslation('session');
  const { t: tClimbs } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const insets = useSafeAreaInsets();
  const saveTick = useSaveTick(toBoardName(boardName));
  // Only the (stable, memoized) startStopwatch action is used here — depend on
  // it directly so the save handler isn't recreated on every timer status /
  // deviceName change.
  const startTimerStopwatch = useOptionalRogueTimer()?.startStopwatch;
  const { enabled: boardPresenceEnabled, boardId: boardPresenceBoardId } = useBoardPresenceControls();
  const { data: grades } = useGrades(boardName);

  // Mobile's `Climb.userAscents`/`userAttempts` GraphQL fields aren't
  // populated server-side, so we read the user's accumulated logbook
  // (denormalised via `BoardProvider` → `useLogbook`) directly. Same
  // logbook source the climb-row status glyph reads.
  //
  // Two failure modes the save-button label must guard against:
  // 1. `BoardProvider` not mounted → no logbook context at all → `Send`.
  // 2. Provider is mounted but this climb's ticks haven't been fetched
  //    yet → the lookup returns nothing. We trigger `getLogbook` on mount
  //    (idempotent thanks to useLogbook's fetched-uuid dedupe) so the
  //    answer becomes authoritative on the next render after the fetch
  //    resolves. In the brief window before then the label may still read
  //    `Flash` for a climb that actually has history — bounded to flows
  //    that bypass the climbs-index pre-fetch (e.g. deep link to
  //    /climbs/[uuid]).
  //
  // Read the prebuilt `logbookByClimbAngle` index (an O(1) Map lookup the
  // BoardProvider rebuilds once per logbook change) rather than scanning
  // the raw `logbook` array — otherwise every logbook merge while this
  // sheet is open (own tick saves, list paging, peer ticks in a session)
  // re-runs an O(logbook) scan. Same index `useAscentStatus` reads.
  const boardActions = useOptionalBoardActions();
  const boardLogbook = useOptionalBoardLogbook();
  const { data: localPendingTicks = 0 } = useLocalPendingTicks(climbUuid, boardName);
  useEffect(() => {
    if (!boardActions) return;
    void boardActions.getLogbook([climbUuid]);
  }, [boardActions, climbUuid]);
  const hasPriorHistory = useMemo(() => {
    // A locally-queued tick that hasn't drained yet still counts as history so
    // the label stays `Send` while offline.
    if (localPendingTicks > 0) return true;
    // No provider → assume history so the label stays `Send` (failure mode 1).
    if (!boardLogbook) return true;
    // Not fetched yet → also assume history (failure mode 2). An empty index
    // lookup can't distinguish "no ticks" from "not loaded", and guessing
    // "no ticks" offers a green Flash on a climb the user has sent many times;
    // tapping it in that window writes a phantom flash, which is worse than a
    // Send label that resolves to Flash a moment later (#3940).
    if (!boardLogbook.fetchedLogbookClimbUuids.has(climbUuid)) return true;
    return (boardLogbook.logbookByClimbAngle.get(logbookClimbAngleKey(climbUuid, angle))?.length ?? 0) > 0;
  }, [boardLogbook, climbUuid, angle, localPendingTicks]);

  const [tickState, setTickState] = useState(createInitialTickState);
  const [comment, setComment] = useState('');
  // The climb date/time to log. Defaults to now; the Date/Time rows let the
  // user backdate a send they forgot to log (issue #3303).
  const [climbedAt, setClimbedAt] = useState(() => new Date());
  const [maximumClimbedAtDate, setMaximumClimbedAtDate] = useState(() => new Date());
  // Whether the user explicitly picked a date/time. Until they do, the tick logs
  // at *save-time* now — this sheet stays mounted (PlayDrawer only toggles
  // visibility), so a value frozen at mount would otherwise save a stale
  // timestamp minutes/hours in the past.
  const hasEditedClimbedAtRef = useRef(false);
  // Renders an inline error row above the save buttons when the last
  // save attempt failed. Cleared on the next attempt or on success.
  const [lastError, setLastError] = useState<string | null>(null);

  // Resolve the consensus grade *name* (e.g. "V5") to a numeric difficulty
  // id by matching against the loaded grades list. The id is what
  // GradeSingleSelectRail compares against each chip's `difficultyId`.
  const consensusDifficultyId = useMemo(() => {
    if (!consensusGradeName || !grades) return undefined;
    return grades.find((grade) => grade.name === consensusGradeName)?.difficultyId;
  }, [consensusGradeName, grades]);

  // Inverse of consensusDifficultyId: resolve the picked numeric difficulty
  // id back to its human-readable grade name (e.g. "V5") for analytics.
  const resolvedGradeName = useMemo(() => {
    if (tickState.difficulty == null || !grades) return undefined;
    return grades.find((grade) => grade.difficultyId === tickState.difficulty)?.name;
  }, [tickState.difficulty, grades]);

  // Type follows the count, never the reverse — the picker floors at MIN_ATTEMPT_COUNT
  // for every status, so what it shows and what gets saved can't drift (#2888).
  const ascentType = deriveAscentType(hasPriorHistory, tickState.attemptCount);

  // Keep the dismiss-analytics snapshot current so LogAscentSheet can read
  // field-completeness at close time — its X-button/pan-down paths never
  // call back into this component, so they can't read tickState directly.
  useEffect(() => {
    if (!fieldSnapshotRef) return;
    fieldSnapshotRef.current = {
      hasQuality: tickState.quality != null && tickState.quality > 0,
      hasDifficulty: tickState.difficulty != null,
      hasComment: comment.length > 0,
      attemptCountChanged: tickState.attemptCount !== DEFAULT_ATTEMPT_COUNT,
    };
  }, [fieldSnapshotRef, tickState.quality, tickState.difficulty, tickState.attemptCount, comment]);

  // Reset form state when the climb context changes underneath an open
  // sheet (e.g. user swiped to next while the sheet was already open).
  useEffect(() => {
    setTickState(createInitialTickState());
    setComment('');
    setLastError(null);
    setClimbedAt(new Date());
    setMaximumClimbedAtDate(new Date());
    hasEditedClimbedAtRef.current = false;
  }, [climbUuid]);

  // Keep "now" fresh while the sheet lives on. The picker's upper bound tracks
  // now so a long-open sheet can't select a future minute; and, until the user
  // picks a date, the displayed default tracks now too so a reopened sheet
  // doesn't show a stale day. Mirrors LogbookEditSheet's max-date refresh.
  useEffect(() => {
    const intervalId = setInterval(() => {
      setMaximumClimbedAtDate(new Date());
      if (!hasEditedClimbedAtRef.current) setClimbedAt(new Date());
    }, MAXIMUM_CLIMBED_AT_REFRESH_MS);
    return () => clearInterval(intervalId);
  }, []);

  const handleQualitySelect = useCallback((value: number | null) => {
    setTickState((prev) => ({ ...prev, quality: value }));
  }, []);

  const handleClimbedAtChange = useCallback((next: Date) => {
    hasEditedClimbedAtRef.current = true;
    setClimbedAt(next);
  }, []);

  const handleFutureAdjusted = useCallback(() => {
    showToast(t('playView.tickBar.futureTimeAdjusted'), 'warning');
  }, [showToast, t]);

  const handleGradeSelect = useCallback((difficultyId: number | undefined) => {
    setTickState((prev) => ({ ...prev, difficulty: difficultyId }));
  }, []);

  const handleTriesSelect = useCallback((value: number) => {
    setTickState((prev) => ({ ...prev, attemptCount: value }));
  }, []);

  const handleSaveWithStatus = useCallback(
    (status: TickStatus) => {
      if (saveTick.isPending) return;
      track(SHARED_EVENTS.TickButtonClicked, { climbUuid, layoutId: layoutId ?? null });
      setLastError(null);

      // Mirrors the server's flash-is-one-try rule; a no-op for every value the picker can show.
      const finalAttempts = clampAttempts(tickState.attemptCount, status);

      saveTick.mutate(
        {
          climbUuid,
          angle,
          isMirror,
          status,
          attemptCount: finalAttempts,
          quality: tickState.quality != null && tickState.quality > 0 ? tickState.quality : null,
          difficulty: tickState.difficulty ?? null,
          isBenchmark,
          comment,
          // Untouched: log a fresh save-time "now". Edited: honour the pick
          // (clamped, in case the sheet sat open past the chosen minute).
          climbedAt: (hasEditedClimbedAtRef.current ? clampToNow(climbedAt) : new Date()).toISOString(),
          ...(sessionId ? { sessionId } : {}),
          ...(layoutId != null ? { layoutId } : {}),
          ...(sizeId != null ? { sizeId } : {}),
          ...(setIds ? { setIds } : {}),
          ...(boardPresenceEnabled && boardPresenceBoardId != null ? { boardId: boardPresenceBoardId } : {}),
        },
        {
          onSuccess: () => {
            track(SHARED_EVENTS.QuickTickSaved, {
              climbUuid,
              layoutId: layoutId ?? null,
              status,
              attemptCount: finalAttempts,
              hasQuality: tickState.quality != null && tickState.quality > 0,
              hasDifficulty: tickState.difficulty != null,
              difficulty: tickState.difficulty ?? null,
              grade: resolvedGradeName ?? null,
              hasComment: comment.length > 0,
            });
            track(SHARED_EVENTS.TickLogged, {
              climbUuid,
              layoutId: layoutId ?? null,
              status,
              platform: 'mobile',
              surface: 'mobile_quick_tick',
            });
            hapticSuccess();
            // Kick off the paired gym timer's stopwatch. No-op unless a Rogue
            // timer is connected — which only happens while this user is driving
            // the wall (see RogueTimerProvider), so a passenger's tick can't
            // touch the timer. Fire-and-forget; never block the save flow.
            void startTimerStopwatch?.();
            // Reset on commit so reopening the sheet on the same climb
            // doesn't show stale state from the just-saved tick.
            setTickState(createInitialTickState());
            setComment('');
            setLastError(null);
            setClimbedAt(new Date());
            setMaximumClimbedAtDate(new Date());
            hasEditedClimbedAtRef.current = false;
            showToast(tClimbs('mobile.logAscent.savedToast'), 'success');
            // Tell LogAscentSheet this close is a completed save, not an
            // abandon, so its wrapped onClose doesn't fire QuickTickDismissed.
            if (savedRef) savedRef.current = true;
            onDismiss();
          },
          onError: (error: unknown) => {
            hapticError();
            track(SHARED_EVENTS.QuickTickFailed, { climbUuid, layoutId: layoutId ?? null });
            const message =
              error instanceof Error && error.message ? error.message : tClimbs('mobile.logAscent.errorMessage');
            setLastError(message);
          },
        },
      );
    },
    [
      saveTick,
      climbUuid,
      angle,
      isMirror,
      isBenchmark,
      sessionId,
      layoutId,
      sizeId,
      setIds,
      boardPresenceEnabled,
      boardPresenceBoardId,
      tickState,
      comment,
      climbedAt,
      onDismiss,
      showToast,
      tClimbs,
      resolvedGradeName,
      savedRef,
      startTimerStopwatch,
    ],
  );

  const handleSave = useCallback(() => handleSaveWithStatus(ascentType), [handleSaveWithStatus, ascentType]);
  const handleAttempt = useCallback(() => handleSaveWithStatus('attempt'), [handleSaveWithStatus]);

  const saveLabel = ascentType === 'flash' ? t('playView.tickBar.flashSaveLabel') : t('playView.tickBar.sendSaveLabel');

  return (
    // The save row sits at the very bottom of LogAscentSheet, so the bottom
    // padding must clear the Android system nav bar / home indicator.
    <View style={[styles.container, { paddingBottom: insets.bottom + spacing[3] }]}>
      <View style={styles.row}>
        <Text variant="footnote" color={iosSystemColors.systemGray} style={styles.rowLabel}>
          {t('playView.tickBar.gradeLabel')}
        </Text>
        <View style={styles.rowPicker}>
          {grades && (
            <GradeSingleSelectRail
              grades={grades}
              selectedDifficultyId={tickState.difficulty}
              consensusDifficultyId={consensusDifficultyId}
              onSelect={handleGradeSelect}
              style={styles.gradeRailContent}
            />
          )}
        </View>
      </View>

      <View style={styles.row}>
        <Text variant="footnote" color={iosSystemColors.systemGray} style={styles.rowLabel}>
          {t('playView.tickBar.triesLabel')}
        </Text>
        <View style={styles.rowPicker}>
          <InlineTriesPicker
            attemptCount={tickState.attemptCount}
            minAttempts={MIN_ATTEMPT_COUNT}
            onSelect={handleTriesSelect}
          />
        </View>
      </View>

      <View style={styles.row}>
        <Text variant="footnote" color={iosSystemColors.systemGray} style={styles.rowLabel}>
          {t('playView.tickBar.starsLabel')}
        </Text>
        <View style={styles.rowPicker}>
          <InlineStarPicker quality={tickState.quality} onSelect={handleQualitySelect} />
        </View>
      </View>

      <View style={styles.row}>
        <Text variant="footnote" color={iosSystemColors.systemGray} style={styles.rowLabel}>
          {t('playView.tickBar.dateLabel')}
        </Text>
        <View style={styles.rowPicker}>
          <ClimbedAtField
            value={climbedAt}
            mode="date"
            maximumDate={maximumClimbedAtDate}
            onChange={handleClimbedAtChange}
            onFutureAdjusted={handleFutureAdjusted}
            accessibilityLabel={t('playView.tickBar.dateLabel')}
          />
        </View>
      </View>

      <View style={styles.row}>
        <Text variant="footnote" color={iosSystemColors.systemGray} style={styles.rowLabel}>
          {t('playView.tickBar.timeLabel')}
        </Text>
        <View style={styles.rowPicker}>
          <ClimbedAtField
            value={climbedAt}
            mode="time"
            maximumDate={maximumClimbedAtDate}
            onChange={handleClimbedAtChange}
            onFutureAdjusted={handleFutureAdjusted}
            accessibilityLabel={t('playView.tickBar.timeLabel')}
          />
        </View>
      </View>

      {/* Compact note row — same label grid as the picker rows above, with
          a borderless input that auto-grows when focused. Lower visual
          weight than the previous tall bordered textarea. */}
      <View style={styles.row}>
        <Text variant="footnote" color={iosSystemColors.systemGray} style={styles.rowLabel}>
          {t('playView.tickBar.noteLabel')}
        </Text>
        {/* `BottomSheetTextInput` (vs the bare `TextInput`) is what makes
            the host sheet auto-expand to its larger snap point when the
            keyboard appears — otherwise the keyboard covers the comment
            row and the save buttons. */}
        <BottomSheetTextInput
          value={comment}
          onChangeText={setComment}
          placeholder={t('playView.tickBar.commentPlaceholder')}
          placeholderTextColor={systemColors.tertiaryLabel}
          accessibilityLabel={t('playView.tickBar.commentAria')}
          multiline
          style={
            {
              flex: 1,
              fontSize: 14,
              lineHeight: 19,
              color: systemColors.label,
              minHeight: 36,
              paddingVertical: spacing[1],
              textAlignVertical: 'top',
            } satisfies TextStyle
          }
        />
      </View>

      {lastError ? (
        <View style={styles.errorRow}>
          <Icon name="close" size={14} color={iosSystemColors.systemRed} />
          <Text variant="footnote" color={iosSystemColors.systemRed} style={styles.errorText}>
            {lastError}
          </Text>
        </View>
      ) : null}

      <View style={styles.saveRow}>
        <Pressable
          onPress={handleAttempt}
          disabled={saveTick.isPending}
          accessibilityRole="button"
          accessibilityLabel={t('playView.tickBar.logAscentAria', { status: 'attempt' })}
          style={({ pressed }) => [
            styles.attemptButton,
            { borderColor: systemColors.separator },
            pressed && styles.buttonPressed,
            saveTick.isPending && styles.buttonDisabled,
          ]}
        >
          <Text variant="footnote" color={systemColors.label} style={styles.attemptLabel}>
            {tClimbs('mobile.logAscent.attempt')}
          </Text>
        </Pressable>

        <Pressable
          onPress={handleSave}
          disabled={saveTick.isPending}
          accessibilityRole="button"
          accessibilityLabel={t('playView.tickBar.logAscentAria', { status: ascentType })}
          style={({ pressed }) => [
            styles.saveButton,
            pressed && styles.buttonPressed,
            saveTick.isPending && styles.buttonDisabled,
          ]}
        >
          <Icon name="tick.outline" size={18} color={iosSystemColors.white} />
          <Text variant="footnote" color={iosSystemColors.white} style={styles.saveLabel}>
            {saveLabel}
          </Text>
        </Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    paddingTop: spacing[1],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    minHeight: 44,
  },
  rowLabel: {
    width: 56,
    fontWeight: '500',
  },
  rowPicker: {
    flex: 1,
  },
  gradeRailContent: {
    paddingHorizontal: 0,
  },
  saveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    // Pull the save buttons inward from the edges — the picker rows above
    // use spacing[4] for their content gutter, but pill buttons want a
    // larger visual margin so the green Send doesn't crowd the screen edge.
    paddingHorizontal: spacing[6],
    paddingTop: spacing[3],
  },
  saveButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[4],
    borderRadius: 22,
    backgroundColor: brandColors.success,
  },
  attemptButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[4],
    borderRadius: 22,
    borderWidth: 1,
    backgroundColor: 'transparent',
  },
  buttonPressed: {
    transform: [{ scale: 0.97 }],
    opacity: 0.9,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  saveLabel: {
    fontWeight: '600',
  },
  attemptLabel: {
    fontWeight: '600',
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
  errorText: {
    flexShrink: 1,
  },
});
