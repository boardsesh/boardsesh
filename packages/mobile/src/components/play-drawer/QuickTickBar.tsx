import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, runOnJS } from 'react-native-reanimated';
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
import { InlineGradePicker } from './InlineGradePicker';
import { InlineTriesPicker } from './InlineTriesPicker';
import { useGrades } from '../../lib/graphql/hooks';
import { useSaveTick } from '@boardsesh/board-react';
import { useMobileSaveTickDeps } from '../../providers/mobile-board-data-deps';
import { toBoardName } from '../../lib/board-name';
import { hapticSuccess, hapticError } from '../../lib/haptics';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
import { timing } from '../../theme/animations';

type QuickTickBarProps = {
  visible: boolean;
  climbUuid: string;
  boardName: string;
  angle: number;
  isMirror: boolean;
  isBenchmark: boolean;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  sessionId?: string | null;
  onDismiss: () => void;
};

export const QuickTickBar = React.memo(function QuickTickBar({
  visible,
  climbUuid,
  boardName,
  angle,
  isMirror,
  isBenchmark,
  layoutId,
  sizeId,
  setIds,
  sessionId,
  onDismiss,
}: QuickTickBarProps) {
  const { t } = useTranslation('session');
  const saveTick = useSaveTick(useMobileSaveTickDeps(), toBoardName(boardName));
  const { data: grades } = useGrades(boardName);

  const [tickState, setTickState] = useState(createInitialTickState);
  const [mounted, setMounted] = useState(visible);

  const ascentType = deriveAscentType(false, tickState.attemptCount);
  const minAttempts = useMemo(() => getMinAttempts(ascentType), [ascentType]);

  useEffect(() => {
    setTickState(createInitialTickState());
  }, [climbUuid]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
    }
  }, [visible]);

  const translateY = useSharedValue(200);

  useEffect(() => {
    if (visible) {
      translateY.value = withTiming(0, { duration: timing.normal });
    } else {
      translateY.value = withTiming(200, { duration: timing.fast }, () => {
        runOnJS(setMounted)(false);
      });
    }
  }, [visible, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: translateY.value < 100 ? 1 : 0,
  }));

  const handleQualitySelect = useCallback((value: number | null) => {
    setTickState((prev) => ({ ...prev, quality: value }));
  }, []);

  const handleGradeSelect = useCallback((difficultyId: number | undefined) => {
    setTickState((prev) => ({ ...prev, difficulty: difficultyId }));
  }, []);

  const handleTriesSelect = useCallback((value: number) => {
    setTickState((prev) => ({ ...prev, attemptCount: value }));
  }, []);

  const handleSave = useCallback(() => {
    if (saveTick.isPending) return;

    const status: TickStatus = ascentType;
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
        comment: '',
        climbedAt: new Date().toISOString(),
        ...(sessionId ? { sessionId } : {}),
        ...(layoutId != null ? { layoutId } : {}),
        ...(sizeId != null ? { sizeId } : {}),
        ...(setIds ? { setIds } : {}),
      },
      {
        onSuccess: () => {
          hapticSuccess();
          onDismiss();
        },
        onError: () => {
          hapticError();
        },
      },
    );
  }, [
    saveTick,
    boardName,
    climbUuid,
    angle,
    isMirror,
    isBenchmark,
    sessionId,
    layoutId,
    sizeId,
    setIds,
    ascentType,
    tickState,
    onDismiss,
  ]);

  if (!mounted) return null;

  const saveLabel = ascentType === 'flash' ? t('playView.tickBar.flashSaveLabel') : t('playView.tickBar.sendSaveLabel');

  return (
    <Animated.View style={[styles.container, animatedStyle]} pointerEvents={visible ? 'auto' : 'none'}>
      <View style={styles.row}>
        <Text variant="footnote" color={iosSystemColors.systemGray} style={styles.rowLabel}>
          {t('playView.tickBar.gradeLabel')}
        </Text>
        <View style={styles.rowPicker}>
          {grades && (
            <InlineGradePicker
              grades={grades}
              selectedDifficultyId={tickState.difficulty}
              consensusDifficultyId={undefined}
              onSelect={handleGradeSelect}
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

      <View style={styles.saveRow}>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel={t('playView.tickBar.cancelLabel')}
          style={styles.cancelButton}
        >
          <Text variant="footnote" color={iosSystemColors.systemGray}>
            {t('playView.tickBar.cancelLabel')}
          </Text>
        </Pressable>

        <Pressable
          onPress={handleSave}
          disabled={saveTick.isPending}
          accessibilityRole="button"
          accessibilityLabel={t('playView.tickBar.logAscentAria', { status: ascentType })}
          style={({ pressed }) => [
            styles.saveButton,
            pressed && styles.saveButtonPressed,
            saveTick.isPending && styles.saveButtonDisabled,
          ]}
        >
          <Icon name="tick.outline" size={18} color={iosSystemColors.white} />
          <Text variant="footnote" color={iosSystemColors.white} style={styles.saveLabel}>
            {saveLabel}
          </Text>
        </Pressable>
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: iosSystemColors.white,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: iosSystemColors.separator,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    zIndex: 5,
    paddingTop: spacing[3],
    paddingBottom: spacing[3],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    minHeight: 44,
  },
  rowLabel: {
    width: 48,
    fontWeight: '500',
  },
  rowPicker: {
    flex: 1,
  },
  saveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: iosSystemColors.separator,
    marginTop: spacing[2],
  },
  cancelButton: {
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[4],
    borderRadius: 20,
    backgroundColor: brandColors.success,
  },
  saveButtonPressed: {
    transform: [{ scale: 0.95 }],
    opacity: 0.9,
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveLabel: {
    fontWeight: '600',
  },
});
