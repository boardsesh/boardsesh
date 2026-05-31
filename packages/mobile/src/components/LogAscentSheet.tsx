import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, TextInput, ScrollView, StyleSheet, Alert, type ViewStyle } from 'react-native';
import BottomSheet, { BottomSheetBackdrop, BottomSheetView, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { Grade } from '@boardsesh/shared-schema';
import { Text } from './Text';
import { Button } from './Button';
import { Icon } from './Icon';
import { Separator } from './Separator';
import { SegmentedControl } from './SegmentedControl';
import { StarRating } from './StarRating';
import { useTheme } from '../providers/theme-provider';
import { useGrades } from '../lib/graphql/hooks';
import { useSaveTick, type TickStatus } from '@boardsesh/board-react';
import { useMobileSaveTickDeps } from '../providers/mobile-board-data-deps';
import { toBoardName } from '../lib/board-name';
import { hapticSuccess, hapticLight, hapticError, hapticSelection } from '../lib/haptics';
import { brandColors } from '../theme/colors';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing } from '../theme/tokens';

type LogAscentSheetProps = {
  visible: boolean;
  onDismiss: () => void;
  climbUuid: string;
  climbName: string;
  boardName: string;
  angle: number;
  isMirror: boolean;
  isBenchmark: boolean;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  sessionId?: string | null;
};

const STATUS_OPTIONS: TickStatus[] = ['flash', 'send', 'attempt'];

function getMinAttempts(tickStatus: TickStatus): number {
  if (tickStatus === 'send') return 2;
  return 1;
}

function GradeChip({ grade, selected, onPress }: { grade: Grade; selected: boolean; onPress: () => void }) {
  const chipStyle: ViewStyle = {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: 16,
    borderWidth: 1,
    borderColor: selected ? brandColors.primary : iosSystemColors.separator,
    backgroundColor: selected ? brandColors.primary : 'transparent',
  };

  return (
    <Pressable
      onPress={() => {
        hapticSelection();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={grade.name}
    >
      <View style={chipStyle}>
        <Text variant="footnote" color={selected ? iosSystemColors.white : undefined} style={styles.gradeChipText}>
          {grade.name}
        </Text>
      </View>
    </Pressable>
  );
}

export function LogAscentSheet({
  visible,
  onDismiss,
  climbUuid,
  climbName,
  boardName,
  angle,
  isMirror,
  isBenchmark,
  layoutId,
  sizeId,
  setIds,
  sessionId,
}: LogAscentSheetProps) {
  const { t } = useTranslation('climbs');
  const theme = useTheme();
  const sheetRef = useRef<BottomSheet>(null);

  useEffect(() => {
    // Expand whenever the sheet becomes visible. Keyed on `visible` (not [])
    // so re-opens always expand, regardless of whether the component stayed
    // mounted between opens.
    if (visible) {
      sheetRef.current?.expand();
    }
  }, [visible]);

  const saveTick = useSaveTick(useMobileSaveTickDeps(), toBoardName(boardName));
  const { data: grades } = useGrades(boardName);

  const [status, setStatus] = useState<TickStatus>('flash');
  const [attemptCount, setAttemptCount] = useState(1);
  const [quality, setQuality] = useState(0);
  const [selectedDifficultyId, setSelectedDifficultyId] = useState<number | null>(null);
  const [comment, setComment] = useState('');

  const snapPoints = useMemo(() => ['85%'], []);

  const statusLabels: Record<TickStatus, string> = useMemo(
    () => ({
      flash: t('mobile.logAscent.flash'),
      send: t('mobile.logAscent.send'),
      attempt: t('mobile.logAscent.attempt'),
    }),
    [t],
  );

  const segmentOptions = useMemo(
    () => STATUS_OPTIONS.map((option) => ({ key: option, label: statusLabels[option] })),
    [statusLabels],
  );

  const minAttempts = getMinAttempts(status);

  const handleStatusChange = useCallback(
    (newStatus: string) => {
      const tickStatus = newStatus as TickStatus;
      setStatus(tickStatus);
      if (tickStatus === 'flash') {
        setAttemptCount(1);
      } else if (tickStatus === 'send' && attemptCount < 2) {
        setAttemptCount(2);
      }
    },
    [attemptCount],
  );

  const handleIncrement = useCallback(() => {
    hapticLight();
    setAttemptCount((previous) => previous + 1);
  }, []);

  const handleDecrement = useCallback(() => {
    hapticLight();
    setAttemptCount((previous) => Math.max(minAttempts, previous - 1));
  }, [minAttempts]);

  const handleQualityChange = useCallback((rating: number | undefined) => {
    setQuality(rating ?? 0);
  }, []);

  const resetForm = useCallback(() => {
    setStatus('flash');
    setAttemptCount(1);
    setQuality(0);
    setSelectedDifficultyId(null);
    setComment('');
  }, []);

  const handleSave = useCallback(() => {
    saveTick.mutate(
      {
        climbUuid,
        angle,
        isMirror,
        status,
        attemptCount,
        quality: quality > 0 ? quality : null,
        difficulty: selectedDifficultyId,
        isBenchmark,
        comment,
        climbedAt: new Date().toISOString(),
        ...(sessionId ? { sessionId } : {}),
        ...(layoutId != null ? { layoutId } : {}),
        ...(sizeId != null ? { sizeId } : {}),
        ...(setIds ? { setIds } : {}),
      },
      {
        onSuccess: () => {
          hapticSuccess();
          resetForm();
          sheetRef.current?.close();
          onDismiss();
        },
        onError: () => {
          hapticError();
          Alert.alert(t('mobile.logAscent.errorTitle'), t('mobile.logAscent.errorMessage'));
        },
      },
    );
  }, [
    saveTick,
    climbUuid,
    angle,
    isMirror,
    status,
    attemptCount,
    quality,
    selectedDifficultyId,
    isBenchmark,
    comment,
    sessionId,
    layoutId,
    sizeId,
    setIds,
    onDismiss,
    resetForm,
    t,
  ]);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1) {
        onDismiss();
      }
    },
    [onDismiss],
  );

  const renderBackdrop = useCallback(
    (backdropProps: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...backdropProps} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} />
    ),
    [],
  );

  const { systemColors } = theme;

  const backgroundStyle: ViewStyle = {
    backgroundColor: systemColors.secondaryBackground as string,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  };

  const trackColor = systemColors.fill;

  const stepperButtonStyle: ViewStyle = {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: systemColors.fill as string,
  };

  const commentInputStyle = {
    borderWidth: 1,
    borderColor: systemColors.separator as string,
    borderRadius: 10,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    fontSize: 16,
    lineHeight: 22,
    color: systemColors.label as string,
    minHeight: 80,
    textAlignVertical: 'top' as const,
  };

  if (!visible) return null;

  return (
    <BottomSheet
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      onChange={handleSheetChange}
      handleIndicatorStyle={styles.indicator}
      backgroundStyle={backgroundStyle}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
    >
      <BottomSheetView style={styles.content}>
        {/* Header */}
        <View style={styles.header}>
          <Text variant="title3">{t('mobile.logAscent.title')}</Text>
          <Text variant="subheadline" style={styles.climbName}>
            {climbName}
          </Text>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Status segmented control */}
          <View style={styles.section}>
            <SegmentedControl
              options={segmentOptions}
              selectedKey={status}
              onSelect={handleStatusChange}
              trackColor={trackColor}
            />
          </View>

          {/* Attempt count stepper */}
          <View style={styles.section}>
            <Text variant="subheadline" style={styles.sectionLabel}>
              {t('mobile.logAscent.attempts')}
            </Text>
            <View style={styles.stepperRow}>
              <Pressable
                onPress={handleDecrement}
                disabled={attemptCount <= minAttempts}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.logAscent.decreaseAttempts')}
                style={[stepperButtonStyle, attemptCount <= minAttempts && styles.stepperDisabled]}
              >
                <Icon
                  name="minus.circle"
                  size={22}
                  color={attemptCount <= minAttempts ? iosSystemColors.systemGray4 : brandColors.primary}
                />
              </Pressable>
              <Text variant="title3" style={styles.attemptCount}>
                {attemptCount}
              </Text>
              <Pressable
                onPress={handleIncrement}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.logAscent.increaseAttempts')}
                style={stepperButtonStyle}
              >
                <Icon name="add" size={22} color={brandColors.primary} />
              </Pressable>
            </View>
          </View>

          <Separator />

          {/* Quality rating */}
          <View style={styles.section}>
            <Text variant="subheadline" style={styles.sectionLabel}>
              {t('mobile.logAscent.quality')}
            </Text>
            <StarRating value={quality} onChange={handleQualityChange} clearValue={0} />
          </View>

          <Separator />

          {/* Grade opinion */}
          {grades && grades.length > 0 && (
            <>
              <View style={styles.section}>
                <Text variant="subheadline" style={styles.sectionLabel}>
                  {t('mobile.logAscent.gradeOpinion')}
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.gradeChipsContainer}
                >
                  {grades.map((grade) => (
                    <GradeChip
                      key={grade.difficultyId}
                      grade={grade}
                      selected={selectedDifficultyId === grade.difficultyId}
                      onPress={() =>
                        setSelectedDifficultyId(selectedDifficultyId === grade.difficultyId ? null : grade.difficultyId)
                      }
                    />
                  ))}
                </ScrollView>
              </View>

              <Separator />
            </>
          )}

          {/* Comment */}
          <View style={styles.section}>
            <Text variant="subheadline" style={styles.sectionLabel}>
              {t('mobile.logAscent.comment')}
            </Text>
            <TextInput
              value={comment}
              onChangeText={setComment}
              placeholder={t('mobile.logAscent.commentPlaceholder')}
              placeholderTextColor={systemColors.tertiaryLabel as string}
              multiline
              style={commentInputStyle}
            />
          </View>

          {/* Save button */}
          <View style={styles.saveSection}>
            <Button
              title={t('mobile.logAscent.save')}
              onPress={handleSave}
              variant="filled"
              size="large"
              loading={saveTick.isPending}
              disabled={saveTick.isPending}
              style={styles.saveButton}
            />
          </View>
        </ScrollView>
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  indicator: {
    backgroundColor: iosSystemColors.separator,
    width: 36,
    height: 5,
    borderRadius: 3,
  },
  content: {
    flex: 1,
  },
  header: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
    alignItems: 'center',
    gap: 4,
  },
  climbName: {
    opacity: 0.6,
  },
  scrollContent: {
    paddingBottom: spacing[10],
  },
  section: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  sectionLabel: {
    opacity: 0.6,
    marginBottom: spacing[2],
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[5],
  },
  stepperDisabled: {
    opacity: 0.4,
  },
  attemptCount: {
    minWidth: 40,
    textAlign: 'center',
  },
  gradeChipsContainer: {
    gap: spacing[2],
    paddingVertical: spacing[1],
  },
  gradeChipText: {
    fontWeight: '500',
  },
  saveSection: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
  },
  saveButton: {
    width: '100%',
  },
});
