import { type RefObject, useCallback, useEffect, useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { type BottomSheet } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { useUpdateTick, useDeleteTick } from '@boardsesh/board-react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { useBoardAngleOptions } from '../../hooks/use-board-angle-options';
import { getGradeColor } from '@boardsesh/board-constants/grade-colors';
import type { BoardName } from '@boardsesh/shared-schema';
import { track } from '../../lib/analytics';
import type { AscentFeedItem, UpdateTickInput } from '@boardsesh/graphql/operations';
import { Text } from '../Text';
import { Sheet } from '../Sheet';
import { StarRating } from '../StarRating';
import { SegmentedControl } from '../SegmentedControl';
import { GradeSingleSelectRail } from '../grade';
import { AngleSlider } from '../play-drawer/AngleSlider';
import {
  EDIT_TICK_SNAP_POINTS,
  TICK_ANGLE_ROW_HEIGHT,
  TICK_RAIL_ROW_HEIGHT,
  TICK_RAIL_TRAIL_INSET,
  TickActionBar,
  TickCountRail,
  TickDateRow,
  TickDestructiveRow,
  TickFormRow,
  TickNoteField,
  TickSheetHeader,
} from '../tick';
import { clampToNow, toEditableDate, MAXIMUM_CLIMBED_AT_REFRESH_MS } from '../logbook/climbed-at';
import { useGrades } from '../../lib/graphql/hooks';
import { hapticSuccess, hapticError } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { useConfirm } from '../../providers/dialog-provider';

type TickStatus = 'flash' | 'send' | 'attempt';

type LogbookEditSheetProps = {
  sheetRef: RefObject<BottomSheet | null>;
  ascent: AscentFeedItem | null;
  onClose: () => void;
};

/**
 * Edit (status / grade / angle / stars / tries / note) or delete a logged ascent.
 *
 * Shares its whole chassis with the create sheet (LogAscentSheet/QuickTickBar):
 * the same `TickSheetHeader`, the same `TickFormRow` beat and two vertical seams,
 * the same chips, stars and pinned `TickActionBar`. Row labels come from the
 * shared `mobile.tick.*` family in `climbs` for the same reason — a climber who
 * logs a send and then edits it should not see the form redrawn.
 */
export function LogbookEditSheet({ sheetRef, ascent, onClose }: LogbookEditSheetProps) {
  const { t } = useTranslation('you');
  const { t: tTick } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const updateTick = useUpdateTick();
  const deleteTick = useDeleteTick();
  // Save and delete hit the same tick UUID — never let one fire while the other
  // is in flight, or a concurrent edit+delete can corrupt the row. Both controls
  // disable (and both handlers bail) whenever either mutation is pending. The
  // delete also goes through a modal Alert, which blocks the save button behind
  // it, so this closes the window completely.
  const isMutating = updateTick.isPending || deleteTick.isPending;
  const gradesQuery = useGrades(ascent?.boardType ?? '', !!ascent);
  const grades = gradesQuery.data ?? [];

  const [status, setStatus] = useState<TickStatus>('send');
  const [difficulty, setDifficulty] = useState<number | null>(null);
  const [quality, setQuality] = useState<number | undefined>(undefined);
  const [attemptCount, setAttemptCount] = useState(1);
  const [climbedAt, setClimbedAt] = useState(() => new Date());
  const [hasClimbedAtChanged, setHasClimbedAtChanged] = useState(false);
  const [maximumClimbedAtDate, setMaximumClimbedAtDate] = useState(() => new Date());
  const [comment, setComment] = useState('');
  const [angle, setAngle] = useState(0);
  // A failed save or delete prints here, in the action bar's always-reserved
  // slot, instead of a toast the sheet itself covers.
  const [lastError, setLastError] = useState<string | null>(null);

  // Valid angles come from the static per-board table (what web and the
  // play-drawer angle selector use) — robust and offline, unlike a per-board
  // query.
  const angles = useBoardAngleOptions(ascent?.boardType as BoardName | undefined);

  // Re-seed the form whenever a different ascent opens the sheet.
  useEffect(() => {
    if (!ascent) return;
    setStatus(ascent.status);
    setDifficulty(ascent.difficulty);
    setQuality(ascent.quality ?? undefined);
    setAttemptCount(Math.max(1, ascent.attemptCount));
    setClimbedAt(toEditableDate(ascent.climbedAt));
    setHasClimbedAtChanged(false);
    setComment(ascent.comment ?? '');
    setAngle(ascent.angle);
    setLastError(null);
  }, [ascent]);

  useEffect(() => {
    if (!ascent?.uuid) return undefined;
    setMaximumClimbedAtDate(new Date());
    const intervalId = setInterval(() => setMaximumClimbedAtDate(new Date()), MAXIMUM_CLIMBED_AT_REFRESH_MS);
    return () => clearInterval(intervalId);
  }, [ascent?.uuid]);

  const statusOptions = useMemo<{ key: TickStatus; label: string }[]>(
    () => [
      { key: 'flash', label: t('mobile.logbook.status.flash') },
      { key: 'send', label: t('mobile.logbook.status.send') },
      { key: 'attempt', label: t('mobile.logbook.status.attempt') },
    ],
    [t],
  );

  const handleStatusSelect = useCallback((nextStatus: TickStatus) => {
    setStatus(nextStatus);
  }, []);

  const handleClimbedAtChange = useCallback((next: Date) => {
    setHasClimbedAtChanged(true);
    setClimbedAt(next);
  }, []);

  const handleFutureAdjusted = useCallback(() => {
    showToast(tTick('mobile.tick.futureTimeAdjusted'), 'warning');
  }, [showToast, tTick]);

  const handleGradeSelect = useCallback((difficultyId: number | undefined) => {
    setDifficulty(difficultyId ?? null);
  }, []);

  const handleClose = useCallback(() => {
    sheetRef.current?.close();
  }, [sheetRef]);

  // The grade the header's identity bar paints from: what the climber has picked
  // right now, falling back to the grade the ascent was logged at while the
  // board's grade list is still loading.
  const selectedGradeName = useMemo(
    () => grades.find((grade) => grade.difficultyId === difficulty)?.name,
    [grades, difficulty],
  );

  const save = useCallback(() => {
    if (!ascent || isMutating) return;
    setLastError(null);
    const finalAttemptCount = status === 'flash' ? 1 : attemptCount;
    const input: UpdateTickInput = {
      status,
      difficulty,
      quality: quality ?? null,
      attemptCount: finalAttemptCount,
      comment,
      angle,
    };
    if (hasClimbedAtChanged) {
      input.climbedAt = clampToNow(climbedAt).toISOString();
    }
    updateTick.mutate(
      {
        uuid: ascent.uuid,
        input,
      },
      {
        onSuccess: () => {
          track(SHARED_EVENTS.LogbookEntryEdited, { method: 'sheet' });
          hapticSuccess();
          sheetRef.current?.close();
        },
        onError: () => {
          hapticError();
          setLastError(t('mobile.logbook.saveError'));
        },
      },
    );
  }, [
    ascent,
    angle,
    attemptCount,
    climbedAt,
    comment,
    difficulty,
    hasClimbedAtChanged,
    isMutating,
    quality,
    sheetRef,
    status,
    t,
    updateTick,
  ]);

  const confirmDelete = useCallback(async () => {
    if (!ascent || isMutating) return;
    const confirmed = await confirm({
      title: t('mobile.logbook.deleteTitle'),
      message: t('mobile.logbook.deleteConfirm'),
      confirmLabel: t('mobile.logbook.delete'),
      cancelLabel: t('mobile.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    setLastError(null);
    deleteTick.mutate(ascent.uuid, {
      onSuccess: () => {
        track(SHARED_EVENTS.LogbookEntryDeleted, { method: 'sheet' });
        sheetRef.current?.close();
      },
      onError: () => {
        hapticError();
        setLastError(t('mobile.logbook.deleteError'));
      },
    });
  }, [ascent, isMutating, confirm, deleteTick, sheetRef, t]);

  const isFlash = status === 'flash';

  return (
    <Sheet
      ref={sheetRef}
      snapPoints={EDIT_TICK_SNAP_POINTS}
      scrollable
      surface="solid"
      footerSurface="flush"
      // See the identical fix on the create-tick sheet (`LogAscentSheet`,
      // #4723 / #4720): the edit sheet has the same pinned-footer-over-a-tall-
      // form shape, so it gets the same Android content-fitting opt-in.
      androidContentSized
      onClose={onClose}
      header={
        <TickSheetHeader
          title={ascent?.climbName ?? t('mobile.logbook.editTitle')}
          subtitle={ascent ? formatBoardDisplayName(ascent.boardType) : undefined}
          gradeColor={getGradeColor(selectedGradeName ?? ascent?.difficultyName)}
          onClose={handleClose}
          closeAccessibilityLabel={tTick('mobile.tick.closeAria')}
        />
      }
      footer={
        <TickActionBar
          error={lastError}
          primary={{
            title: tTick('mobile.tick.save'),
            onPress: save,
            loading: updateTick.isPending,
            disabled: isMutating,
          }}
        />
      }
    >
      <TickFormRow label={tTick('mobile.tick.statusLabel')}>
        <SegmentedControl
          options={statusOptions}
          selectedKey={status}
          onSelect={handleStatusSelect}
          tint={brandColors.primaryFill}
          accessibilityLabel={tTick('mobile.tick.statusLabel')}
        />
      </TickFormRow>

      <TickFormRow label={tTick('mobile.tick.dateLabel')}>
        <TickDateRow
          value={climbedAt}
          maximumDate={maximumClimbedAtDate}
          onChange={handleClimbedAtChange}
          onFutureAdjusted={handleFutureAdjusted}
          dateAccessibilityLabel={tTick('mobile.tick.dateLabel')}
          timeAccessibilityLabel={tTick('mobile.tick.timeLabel')}
        />
      </TickFormRow>

      <TickFormRow label={tTick('mobile.tick.gradeLabel')} bleed height={TICK_RAIL_ROW_HEIGHT}>
        <GradeSingleSelectRail
          grades={grades}
          selectedDifficultyId={difficulty}
          onSelect={handleGradeSelect}
          allowClear={false}
          colorway="selection"
          contentInsetLeft={0}
          contentInsetRight={TICK_RAIL_TRAIL_INSET}
        />
      </TickFormRow>

      <TickFormRow label={tTick('mobile.tick.angleLabel')} height={TICK_ANGLE_ROW_HEIGHT}>
        <View style={styles.angleSlider}>
          {angles.length > 0 && <AngleSlider angles={angles} value={angle} onChange={setAngle} />}
        </View>
        {/* The value trails the slider instead of sitting above it as a centred
            title3 — that readout was the same size as the sheet's own climb
            title and gave the form a second reading axis. */}
        <Text variant="body" color={systemColors.label} style={styles.angleValue}>
          {angle}°
        </Text>
      </TickFormRow>

      <TickFormRow label={tTick('mobile.tick.starsLabel')}>
        <StarRating value={quality} onChange={setQuality} size={STAR_GLYPH_SIZE} />
      </TickFormRow>

      {/* Flash means one try. The row stays MOUNTED and dims rather than
          unmounting ~92pt from under the climber's finger — which also makes the
          clamp visible instead of unexplained. */}
      <TickFormRow label={tTick('mobile.tick.triesLabel')} bleed height={TICK_RAIL_ROW_HEIGHT} disabled={isFlash}>
        <TickCountRail
          value={isFlash ? 1 : attemptCount}
          onSelect={setAttemptCount}
          resetKey={ascent?.uuid}
          disabled={isFlash}
          accessibilityLabel={tTick('mobile.tick.triesLabel')}
        />
      </TickFormRow>

      {/* `alignTop` for the same reason as the create sheet's note row (#4642). */}
      <TickFormRow label={tTick('mobile.tick.noteLabel')} alignTop showSeparator={false} testID="tick-row-note">
        <TickNoteField
          value={comment}
          onChangeText={setComment}
          placeholder={tTick('mobile.tick.notePlaceholder')}
          accessibilityLabel={tTick('mobile.tick.noteAria')}
        />
      </TickFormRow>

      <View style={styles.deleteGroup}>
        <TickDestructiveRow label={tTick('mobile.tick.deleteRow')} onPress={confirmDelete} disabled={isMutating} />
      </View>
    </Sheet>
  );
}

/** Matches the create sheet's stars exactly — one rating control, one size. */
const STAR_GLYPH_SIZE = 24;

const styles = StyleSheet.create({
  angleSlider: {
    flex: 1,
  },
  angleValue: {
    minWidth: 44,
    textAlign: 'right',
    // Digits keep their column as the angle steps, so the readout does not
    // twitch under the thumb.
    fontVariant: ['tabular-nums'],
  },
  deleteGroup: {
    // Off on its own, well clear of the last field row — Delete is not the next
    // step in the form.
    marginTop: spacing[8],
  },
});
