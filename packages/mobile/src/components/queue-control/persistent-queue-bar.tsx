/**
 * PersistentQueueBar — bottom-anchored control bar that mounts at the app
 * root and is visible on every screen while a current climb is set.
 *
 * Layout (condensed for mobile, no thumbnail per design):
 *   [grade] climb name…              [✓ tick] [BT] [⏻ end]
 *      ↑ tap opens PlayDrawer    ↑ horizontal swipe = prev/next
 *
 * The horizontal swipe mirrors the play-drawer carousel pattern
 * (`use-carousel-gesture`), reusing the shared timings + peek math from
 * `@boardsesh/play-view` so the bar and drawer feel identical.
 */

import { useCallback, useMemo, useState } from 'react';
import { View, Pressable, StyleSheet, useColorScheme, type ColorValue, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { FadeIn, runOnJS, useAnimatedStyle, useDerivedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { computePeekOffset, getGradeTintColor } from '@boardsesh/play-view';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { iosSystemColors } from '../../theme/ios-colors';
import { shadowColor } from '../../theme/tokens';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { BluetoothStatusIcon } from '../ble/BluetoothStatusIcon';
import { EndSessionSheet } from '../EndSessionSheet';
import { useTheme } from '../../providers/theme-provider';
import { useQueue } from '../../providers/queue-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { hapticSelection } from '../../lib/haptics';
import { useCarouselGesture } from '../play-drawer/use-carousel-gesture';
import { TAB_BAR_HEIGHT } from '../BlurTabBar';
import { useRouter } from 'expo-router';

export const BAR_CONTENT_HEIGHT = 56;
// Re-export so layout consumers that already import bar metrics from this
// module don't need to know which file owns the tab-bar height.
export { TAB_BAR_HEIGHT };

type ClimbDisplay = {
  difficulty: string | null | undefined;
  name: string | undefined;
};

function climbDisplay(item: ClimbQueueItem | null | undefined): ClimbDisplay | null {
  if (!item?.climb) return null;
  return {
    difficulty: item.climb.difficulty,
    name: item.climb.name,
  };
}

type ClimbLabelProps = {
  display: ClimbDisplay;
  labelColor: ColorValue;
  formattedGrade: string | null;
  chipBackground: string;
};

function ClimbLabel({ display, labelColor, formattedGrade, chipBackground }: ClimbLabelProps) {
  return (
    <View style={styles.labelInner}>
      {formattedGrade ? (
        <View style={[styles.gradePill, { backgroundColor: chipBackground }]}>
          <Text variant="caption1" color={iosSystemColors.white} style={styles.gradeText}>
            {formattedGrade}
          </Text>
        </View>
      ) : null}
      <Text variant="subheadline" color={labelColor} numberOfLines={1} ellipsizeMode="tail" style={styles.name}>
        {display.name ?? ''}
      </Text>
    </View>
  );
}

export function PersistentQueueBar() {
  const { state, nextClimb, previousClimb, sessionId, endSession } = useQueue();
  const { boardConfig, openPlayDrawer, openLogAscent } = useDrawerHost();
  const bluetooth = useOptionalBluetoothContext();
  const insets = useSafeAreaInsets();
  const { systemColors, brandColors } = useTheme();
  const { t } = useTranslation('session');
  const router = useRouter();
  const { formatGrade: format } = useGradeFormat();
  const isDark = useColorScheme() === 'dark';

  const [barWidth, setBarWidth] = useState(0);
  const [showEndSession, setShowEndSession] = useState(false);
  const [isEnding, setIsEnding] = useState(false);

  const { currentClimbQueueItem, queue } = state;

  const currentIndex = useMemo(() => {
    if (!currentClimbQueueItem) return -1;
    return queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem.uuid);
  }, [queue, currentClimbQueueItem]);

  const canPrevious = currentIndex > 0;
  const canNext = currentIndex >= 0 && currentIndex < queue.length - 1;
  const previousItem = canPrevious ? queue[currentIndex - 1] : null;
  const nextItem = canNext ? queue[currentIndex + 1] : null;

  const handleNext = useCallback(() => {
    hapticSelection();
    nextClimb();
  }, [nextClimb]);

  const handlePrevious = useCallback(() => {
    hapticSelection();
    previousClimb();
  }, [previousClimb]);

  const { gesture: panGesture, translateX } = useCarouselGesture({
    onSwipeNext: handleNext,
    onSwipePrevious: handlePrevious,
    canSwipeNext: canNext,
    canSwipePrevious: canPrevious,
    boardWidth: barWidth,
    enabled: barWidth > 0,
  });

  const handleOpenPlay = useCallback(() => {
    if (!currentClimbQueueItem?.climb) return;
    openPlayDrawer(currentClimbQueueItem.climb);
  }, [openPlayDrawer, currentClimbQueueItem]);

  const tapGesture = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(250)
        .onEnd(() => {
          'worklet';
          runOnJS(handleOpenPlay)();
        }),
    [handleOpenPlay],
  );

  const composedGesture = useMemo(() => Gesture.Race(panGesture, tapGesture), [panGesture, tapGesture]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setBarWidth(event.nativeEvent.layout.width);
  }, []);

  const currentLabelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const nextPeekX = useDerivedValue(() =>
    computePeekOffset({ direction: 'next', swipeOffset: translateX.value, viewportWidth: barWidth }),
  );
  const prevPeekX = useDerivedValue(() =>
    computePeekOffset({ direction: 'prev', swipeOffset: translateX.value, viewportWidth: barWidth }),
  );

  const nextPeekStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: nextPeekX.value }],
  }));
  const prevPeekStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: prevPeekX.value }],
  }));

  const handleTick = useCallback(() => {
    if (!currentClimbQueueItem?.climb || !boardConfig) return;
    hapticSelection();
    openLogAscent({
      climbUuid: currentClimbQueueItem.climb.uuid,
      climbName: currentClimbQueueItem.climb.name,
      boardName: boardConfig.boardName,
      angle: currentClimbQueueItem.climb.angle,
      isMirror: currentClimbQueueItem.climb.mirrored === true,
      isBenchmark: currentClimbQueueItem.climb.benchmark_difficulty != null,
      layoutId: boardConfig.layoutId,
      sizeId: boardConfig.sizeId,
      setIds: boardConfig.setIds,
      sessionId,
    });
  }, [openLogAscent, currentClimbQueueItem, boardConfig, sessionId]);

  const handleBluetoothPress = useCallback(() => {
    if (!bluetooth) return;
    if (bluetooth.isConnected) void bluetooth.disconnect();
    else void bluetooth.connect();
  }, [bluetooth]);

  const handleEndSessionPress = useCallback(() => {
    hapticSelection();
    setShowEndSession(true);
  }, []);

  const handleEndSessionConfirm = useCallback(async () => {
    setIsEnding(true);
    const summary = await endSession();
    setIsEnding(false);
    setShowEndSession(false);
    if (summary) {
      router.push({ pathname: '/(tabs)/queue/summary', params: { sessionId: summary.sessionId } });
    }
  }, [endSession, router]);

  const currentDisplay = climbDisplay(currentClimbQueueItem);
  const previousDisplay = climbDisplay(previousItem);
  const nextDisplay = climbDisplay(nextItem);

  if (!currentDisplay) return null;

  // Soft pastel tint derived from the current climb's grade, matching the web
  // queue bar's `getGradeTintColor(difficulty, 'default', isDark)` call.
  // Falls back to the neutral system background when the grade is unrecognised.
  const tintBackground = getGradeTintColor(currentDisplay.difficulty, 'default', isDark);

  const currentFormatted = format(currentDisplay.difficulty);
  const previousFormatted = previousDisplay ? format(previousDisplay.difficulty) : null;
  const nextFormatted = nextDisplay ? format(nextDisplay.difficulty) : null;

  // Vivid grade color (`getGradeColor` raw hex) for the chip, matching the
  // PlayDrawer header pill. Falls back to the default neutral grade color when
  // the difficulty is unrecognised.
  const currentChipColor = getGradeColor(currentDisplay.difficulty) ?? DEFAULT_GRADE_COLOR;
  const previousChipColor = previousDisplay
    ? (getGradeColor(previousDisplay.difficulty) ?? DEFAULT_GRADE_COLOR)
    : DEFAULT_GRADE_COLOR;
  const nextChipColor = nextDisplay
    ? (getGradeColor(nextDisplay.difficulty) ?? DEFAULT_GRADE_COLOR)
    : DEFAULT_GRADE_COLOR;

  return (
    <>
      <Animated.View
        entering={FadeIn.duration(200)}
        pointerEvents="box-none"
        style={[
          styles.bar,
          {
            // Sit directly above the BlurTabBar — side margins + rounded
            // corners give the floating-card look; no extra vertical gap.
            bottom: insets.bottom + TAB_BAR_HEIGHT,
            backgroundColor: tintBackground ?? systemColors.background,
          },
        ]}
      >
        <View style={styles.row}>
          <GestureDetector gesture={composedGesture}>
            <View style={styles.swipeArea} onLayout={onLayout} accessibilityRole="button">
              <Animated.View style={[styles.labelSlot, currentLabelStyle]}>
                <ClimbLabel
                  display={currentDisplay}
                  labelColor={systemColors.label}
                  formattedGrade={currentFormatted}
                  chipBackground={currentChipColor}
                />
              </Animated.View>
              {nextDisplay ? (
                <Animated.View style={[styles.peekSlot, nextPeekStyle]} pointerEvents="none">
                  <ClimbLabel
                    display={nextDisplay}
                    labelColor={systemColors.label}
                    formattedGrade={nextFormatted}
                    chipBackground={nextChipColor}
                  />
                </Animated.View>
              ) : null}
              {previousDisplay ? (
                <Animated.View style={[styles.peekSlot, prevPeekStyle]} pointerEvents="none">
                  <ClimbLabel
                    display={previousDisplay}
                    labelColor={systemColors.label}
                    formattedGrade={previousFormatted}
                    chipBackground={previousChipColor}
                  />
                </Animated.View>
              ) : null}
            </View>
          </GestureDetector>

          <Pressable
            onPress={handleEndSessionPress}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.queue.endSession')}
            hitSlop={8}
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
          >
            <Icon name="end.session" size={24} color={brandColors.error} />
          </Pressable>

          {bluetooth ? (
            <BluetoothStatusIcon
              isConnected={bluetooth.isConnected}
              isScanning={bluetooth.loading}
              onPress={handleBluetoothPress}
            />
          ) : null}

          <Pressable
            onPress={handleTick}
            disabled={!currentClimbQueueItem || !boardConfig}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.queue.logAscent')}
            hitSlop={8}
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
          >
            <Icon name="tick" size={26} color={brandColors.primary} />
          </Pressable>
        </View>
      </Animated.View>

      <EndSessionSheet
        visible={showEndSession}
        onDismiss={() => setShowEndSession(false)}
        onConfirm={handleEndSessionConfirm}
        isEnding={isEnding}
        climbCount={queue.length}
      />
    </>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 8,
    right: 8,
    // `bottom` is set inline from safe-area insets + tab-bar height so
    // the bar sits flush against the tab bar with all four corners
    // rounded (Spotify mini-player style).
    borderRadius: 10,
    overflow: 'hidden',
    shadowColor,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: BAR_CONTENT_HEIGHT,
    paddingHorizontal: 12,
  },
  swipeArea: {
    flex: 1,
    height: BAR_CONTENT_HEIGHT,
    overflow: 'hidden',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  labelSlot: {
    position: 'absolute',
    left: 4,
    right: 4,
    justifyContent: 'center',
  },
  peekSlot: {
    position: 'absolute',
    left: 4,
    right: 4,
    justifyContent: 'center',
  },
  labelInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  gradePill: {
    // Reserve a 3-char slot ("V10") so the climb name doesn't shift
    // horizontally as the user swipes between climbs with different
    // grade widths. 4-char grades like "V10+" still expand slightly.
    minWidth: 40,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gradeText: {
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
    textAlign: 'center',
  },
  name: {
    flex: 1,
    fontWeight: '600',
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  iconButtonPressed: {
    opacity: 0.5,
  },
});
