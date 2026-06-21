import { type RefObject, useCallback, useEffect, useMemo, useState } from 'react';
import { View, Pressable, Platform, StyleSheet } from 'react-native';
import BottomSheet, { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import DateTimePicker, {
  DateTimePickerAndroid,
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { useTranslation } from 'react-i18next';
import { useUpdateTick, useDeleteTick } from '@boardsesh/board-react';
import type { AscentFeedItem, UpdateTickInput } from '@boardsesh/graphql/operations';
import { parseTickTime } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Sheet } from '../Sheet';
import { Button } from '../Button';
import { StarRating } from '../StarRating';
import { SegmentedControl } from '../SegmentedControl';
import { SectionHeader } from '../SectionHeader';
import { GradeSingleSelectRail } from '../grade';
import { useGrades } from '../../lib/graphql/hooks';
import { hapticSuccess, hapticError } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { useConfirm } from '../../providers/dialog-provider';

type TickStatus = 'flash' | 'send' | 'attempt';

const MAXIMUM_CLIMBED_AT_REFRESH_MS = 60_000;

type LogbookEditSheetProps = {
  sheetRef: RefObject<BottomSheet | null>;
  ascent: AscentFeedItem | null;
  onClose: () => void;
};

function toEditableDate(climbedAt: string): Date {
  const parsed = parseTickTime(climbedAt).toDate();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function clampToNow(date: Date): Date {
  const now = new Date();
  return date.getTime() > now.getTime() ? now : date;
}

function applyDatePart(current: Date, selectedDate: Date, options: { clampToPresent: boolean }): Date {
  const next = new Date(current);
  next.setFullYear(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
  return options.clampToPresent ? clampToNow(next) : next;
}

function applyTimePart(current: Date, selectedTime: Date, options: { clampToPresent: boolean }): Date {
  const next = new Date(current);
  next.setHours(selectedTime.getHours(), selectedTime.getMinutes(), 0, 0);
  return options.clampToPresent ? clampToNow(next) : next;
}

function formatDateForDisplay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTimeForDisplay(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** Edit (status / grade / stars / tries / comment) or delete a logged ascent. */
export function LogbookEditSheet({ sheetRef, ascent, onClose }: LogbookEditSheetProps) {
  const { t } = useTranslation('you');
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

  const handleDateChange = useCallback(
    (_event: DateTimePickerEvent, selectedDate?: Date) => {
      if (!selectedDate) return;
      setHasClimbedAtChanged(true);
      setClimbedAt((current) => {
        const requestedDate = applyDatePart(current, selectedDate, { clampToPresent: false });
        const clampedDate = clampToNow(requestedDate);
        if (clampedDate.getTime() !== requestedDate.getTime()) {
          showToast(t('mobile.logbook.futureTimeAdjusted'), 'warning');
        }
        return clampedDate;
      });
    },
    [showToast, t],
  );

  const handleTimeChange = useCallback(
    (_event: DateTimePickerEvent, selectedTime?: Date) => {
      if (!selectedTime) return;
      setHasClimbedAtChanged(true);
      setClimbedAt((current) => {
        const requestedTime = applyTimePart(current, selectedTime, { clampToPresent: false });
        const clampedTime = clampToNow(requestedTime);
        if (clampedTime.getTime() !== requestedTime.getTime()) {
          showToast(t('mobile.logbook.futureTimeAdjusted'), 'warning');
        }
        return clampedTime;
      });
    },
    [showToast, t],
  );

  const openAndroidDatePicker = useCallback(() => {
    DateTimePickerAndroid.open({
      value: climbedAt,
      mode: 'date',
      display: 'default',
      maximumDate: new Date(),
      onChange: (event, selectedDate) => {
        if (event.type !== 'set' || !selectedDate) return;
        setHasClimbedAtChanged(true);
        setClimbedAt((current) => {
          const requestedDate = applyDatePart(current, selectedDate, { clampToPresent: false });
          const clampedDate = clampToNow(requestedDate);
          if (clampedDate.getTime() !== requestedDate.getTime()) {
            showToast(t('mobile.logbook.futureTimeAdjusted'), 'warning');
          }
          return clampedDate;
        });
      },
    });
  }, [climbedAt, showToast, t]);

  const openAndroidTimePicker = useCallback(() => {
    DateTimePickerAndroid.open({
      value: climbedAt,
      mode: 'time',
      display: 'default',
      maximumDate: new Date(),
      onChange: (event, selectedTime) => {
        if (event.type !== 'set' || !selectedTime) return;
        setHasClimbedAtChanged(true);
        setClimbedAt((current) => {
          const requestedTime = applyTimePart(current, selectedTime, { clampToPresent: false });
          const clampedTime = clampToNow(requestedTime);
          if (clampedTime.getTime() !== requestedTime.getTime()) {
            showToast(t('mobile.logbook.futureTimeAdjusted'), 'warning');
          }
          return clampedTime;
        });
      },
    });
  }, [climbedAt, showToast, t]);

  const save = useCallback(() => {
    if (!ascent || isMutating) return;
    const finalAttemptCount = status === 'flash' ? 1 : attemptCount;
    const input: UpdateTickInput = {
      status,
      difficulty,
      quality: quality ?? null,
      attemptCount: finalAttemptCount,
      comment,
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
          hapticSuccess();
          sheetRef.current?.close();
        },
        onError: () => {
          hapticError();
          showToast(t('mobile.logbook.saveError'), 'error');
        },
      },
    );
  }, [
    ascent,
    attemptCount,
    climbedAt,
    comment,
    difficulty,
    hasClimbedAtChanged,
    isMutating,
    quality,
    sheetRef,
    showToast,
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
    deleteTick.mutate(ascent.uuid, {
      onSuccess: () => sheetRef.current?.close(),
      onError: () => {
        hapticError();
        showToast(t('mobile.logbook.deleteError'), 'error');
      },
    });
  }, [ascent, isMutating, confirm, deleteTick, sheetRef, showToast, t]);

  return (
    <Sheet
      ref={sheetRef}
      snapPoints={['75%', '92%']}
      scrollable
      fullWindowOverlay
      onClose={onClose}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      footer={
        <Button title={t('mobile.logbook.save')} onPress={save} loading={updateTick.isPending} disabled={isMutating} />
      }
    >
      <Text variant="title3" numberOfLines={1} style={styles.title}>
        {ascent?.climbName ?? t('mobile.logbook.editTitle')}
      </Text>

      <SectionHeader title={t('mobile.logbook.statusLabel')} />
      <View style={styles.field}>
        <SegmentedControl
          options={statusOptions}
          selectedKey={status}
          onSelect={handleStatusSelect}
          trackColor={systemColors.fill}
          accessibilityLabel={t('mobile.logbook.statusLabel')}
        />
      </View>

      <SectionHeader title={t('mobile.logbook.dateLabel')} />
      <View style={styles.field}>
        {Platform.OS === 'ios' ? (
          <DateTimePicker
            value={climbedAt}
            mode="date"
            display="compact"
            maximumDate={maximumClimbedAtDate}
            accessibilityLabel={t('mobile.logbook.dateLabel')}
            onChange={handleDateChange}
          />
        ) : (
          <Pressable
            onPress={openAndroidDatePicker}
            style={[styles.dateTimeButton, { backgroundColor: systemColors.fill }]}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.logbook.dateLabel')}
          >
            <Text variant="body" color={systemColors.label}>
              {formatDateForDisplay(climbedAt)}
            </Text>
            <Icon name="calendar" size={18} color={systemColors.secondaryLabel} />
          </Pressable>
        )}
      </View>

      <SectionHeader title={t('mobile.logbook.timeLabel')} />
      <View style={styles.field}>
        {Platform.OS === 'ios' ? (
          <DateTimePicker
            value={climbedAt}
            mode="time"
            display="compact"
            maximumDate={maximumClimbedAtDate}
            accessibilityLabel={t('mobile.logbook.timeLabel')}
            onChange={handleTimeChange}
          />
        ) : (
          <Pressable
            onPress={openAndroidTimePicker}
            style={[styles.dateTimeButton, { backgroundColor: systemColors.fill }]}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.logbook.timeLabel')}
          >
            <Text variant="body" color={systemColors.label}>
              {formatTimeForDisplay(climbedAt)}
            </Text>
            <Icon name="clock" size={18} color={systemColors.secondaryLabel} />
          </Pressable>
        )}
      </View>

      <SectionHeader title={t('mobile.logbook.gradeLabel')} />
      <GradeSingleSelectRail
        grades={grades}
        selectedDifficultyId={difficulty}
        onSelect={(difficultyId) => setDifficulty(difficultyId ?? null)}
        allowClear={false}
      />

      <SectionHeader title={t('mobile.logbook.qualityLabel')} />
      <View style={styles.field}>
        <StarRating value={quality} onChange={setQuality} />
      </View>

      {status === 'flash' ? null : (
        <>
          <SectionHeader title={t('mobile.logbook.triesLabel')} />
          <View style={[styles.field, styles.stepper]}>
            <Pressable
              onPress={() => setAttemptCount((current) => Math.max(1, current - 1))}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Icon name="minus.circle" size={28} color={systemColors.secondaryLabel} />
            </Pressable>
            <Text variant="title3" style={styles.stepperValue}>
              {attemptCount}
            </Text>
            <Pressable onPress={() => setAttemptCount((current) => current + 1)} hitSlop={8} accessibilityRole="button">
              <Icon name="add" size={28} color={brandColors.primary} />
            </Pressable>
          </View>
        </>
      )}

      <SectionHeader title={t('mobile.logbook.commentLabel')} />
      <View style={styles.field}>
        <BottomSheetTextInput
          style={[styles.input, { backgroundColor: systemColors.fill, color: systemColors.label }]}
          placeholder={t('mobile.logbook.commentPlaceholder')}
          placeholderTextColor={systemColors.tertiaryLabel}
          value={comment}
          onChangeText={setComment}
          multiline
        />
      </View>

      <Pressable
        onPress={confirmDelete}
        disabled={isMutating}
        style={[styles.deleteRow, isMutating && styles.deleteRowDisabled]}
        accessibilityRole="button"
      >
        <Icon name="delete" size={18} color={brandColors.error} />
        <Text variant="body" color={brandColors.error}>
          {t('mobile.logbook.delete')}
        </Text>
      </Pressable>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: { paddingHorizontal: spacing[4], paddingTop: spacing[2] },
  field: { paddingHorizontal: spacing[4] },
  dateTimeButton: {
    minHeight: 44,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[3],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing[5] },
  stepperValue: { minWidth: 40, textAlign: 'center' },
  input: {
    minHeight: 72,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    fontSize: 15,
    textAlignVertical: 'top',
  },
  deleteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    marginTop: spacing[6],
    paddingVertical: spacing[3],
  },
  deleteRowDisabled: {
    opacity: 0.4,
  },
});
