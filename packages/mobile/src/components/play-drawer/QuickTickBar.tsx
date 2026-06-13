// Ticking form contents. Always rendered inside `LogAscentSheet`'s
// BottomSheetModal — the sheet owns positioning, slide-in, backdrop,
// pan-down-to-close, and the drag handle. This component is just the
// pickers + save row.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Pressable, StyleSheet, type TextStyle } from 'react-native';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import {
  createInitialTickState,
  deriveAscentType,
  getMinAttempts,
  clampAttempts,
  type TickStatus,
} from '@boardsesh/play-view';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { InlineStarPicker } from './InlineStarPicker';
import { InlineTriesPicker } from './InlineTriesPicker';
import { GradeSingleSelectRail } from '../grade';
import { useTheme } from '../../providers/theme-provider';
import { useGrades } from '../../lib/graphql/hooks';
import { useOptionalBoardProvider, useSaveTick, logbookClimbAngleKey } from '@boardsesh/board-react';
import { toBoardName } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useToast } from '../../providers/toast-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { track } from '../../lib/analytics';
import { hapticSuccess, hapticError } from '../../lib/haptics';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

type QuickTickBarProps = {
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
}: QuickTickBarProps) {
  const { t } = useTranslation('session');
  const { t: tClimbs } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const insets = useSafeAreaInsets();
  const saveTick = useSaveTick(toBoardName(boardName));
  const { enabled: boardPresenceEnabled, boardId: boardPresenceBoardId } = useBoardPresenceControls();
  const { data: activeBoard } = useActiveBoard();
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
  const board = useOptionalBoardProvider();
  useEffect(() => {
    if (!board) return;
    void board.getLogbook([climbUuid]);
  }, [board, climbUuid]);
  const hasPriorHistory = useMemo(() => {
    if (!board) return true;
    return (board.logbookByClimbAngle.get(logbookClimbAngleKey(climbUuid, angle))?.length ?? 0) > 0;
  }, [board, climbUuid, angle]);

  const [tickState, setTickState] = useState(createInitialTickState);
  const [comment, setComment] = useState('');
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

  const ascentType = deriveAscentType(hasPriorHistory, tickState.attemptCount);
  const minAttempts = useMemo(() => getMinAttempts(ascentType), [ascentType]);
  const activeBoardIdForTick = useMemo(() => {
    if (!activeBoard) return null;
    if (activeBoard.boardType !== boardName) return null;
    if (layoutId == null || sizeId == null || !setIds) return null;
    const activeSetIds = normalizeSetIdsForTick(activeBoard.setIds);
    const tickSetIds = normalizeSetIdsForTick(setIds);
    if (activeBoard.layoutId !== layoutId || activeBoard.sizeId !== sizeId || activeSetIds !== tickSetIds) {
      return null;
    }
    return activeBoard.id;
  }, [activeBoard, boardName, layoutId, sizeId, setIds]);
  const tickBoardId =
    boardPresenceEnabled && boardPresenceBoardId != null ? boardPresenceBoardId : activeBoardIdForTick;

  // Reset form state when the climb context changes underneath an open
  // sheet (e.g. user swiped to next while the sheet was already open).
  useEffect(() => {
    setTickState(createInitialTickState());
    setComment('');
    setLastError(null);
  }, [climbUuid]);

  const handleQualitySelect = useCallback((value: number | null) => {
    setTickState((prev) => ({ ...prev, quality: value }));
  }, []);

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
          climbedAt: new Date().toISOString(),
          ...(sessionId ? { sessionId } : {}),
          ...(layoutId != null ? { layoutId } : {}),
          ...(sizeId != null ? { sizeId } : {}),
          ...(setIds ? { setIds } : {}),
          ...(tickBoardId != null ? { boardId: tickBoardId } : {}),
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
              hasComment: comment.length > 0,
            });
            hapticSuccess();
            // Reset on commit so reopening the sheet on the same climb
            // doesn't show stale state from the just-saved tick.
            setTickState(createInitialTickState());
            setComment('');
            setLastError(null);
            showToast(tClimbs('mobile.logAscent.savedToast'), 'success');
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
      tickBoardId,
      tickState,
      comment,
      onDismiss,
      showToast,
      tClimbs,
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
            minAttempts={minAttempts}
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

function normalizeSetIdsForTick(setIds: string): string {
  return [
    ...new Set(
      setIds
        .split(',')
        .map((token) => token.trim())
        .filter((token) => /^\d+$/.test(token)),
    ),
  ]
    .sort((first, second) => Number(first) - Number(second))
    .join(',');
}

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
