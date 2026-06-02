import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming, runOnJS } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import type { Climb, BoardName } from '@boardsesh/shared-schema';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { Text } from './Text';
import { Icon } from './Icon';
import { ClimbListThumbnail } from './ClimbListThumbnail';
import { AscentStatusBadge } from './AscentStatusBadge';
import { HeartAnimationOverlay } from './HeartAnimationOverlay';
import { useDoubleTapFavorite } from '../hooks/use-double-tap-favorite';
import { hapticLight, hapticMedium, hapticSuccess } from '../lib/haptics';
import { formatSends, formatQuality } from '../lib/format-climb-stats';
import { getGradeTintColor } from '@boardsesh/play-view';
import { useGradeFormat } from '../hooks/use-grade-format';
import { useTheme } from '../providers/theme-provider';
import { iosSystemColors } from '../theme/ios-colors';
import { brandColors } from '../theme/colors';
import { spacing } from '../theme/tokens';

const MAX_GESTURE_SWIPE = 180;
const SHORT_ACTION_WIDTH = 120;
const RIGHT_ACTION_WIDTH = 100;
const SHORT_SWIPE_THRESHOLD = 60;
const TRANSITION_START = 115;
const LONG_SWIPE_THRESHOLD = 150;

type ClimbListRowProps = {
  climb: Climb;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  onPress: (climb: Climb) => void;
  onAddToQueue?: (climb: Climb) => void;
  onOpenPlaylist?: (climb: Climb) => void;
  onOpenActions?: (climb: Climb) => void;
  selected?: boolean;
  unsupported?: boolean;
};

const AnimatedView = Animated.View;

const ClimbListRow = React.memo(function ClimbListRow({
  climb,
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  onPress,
  onAddToQueue,
  onOpenPlaylist,
  onOpenActions,
  selected,
  unsupported,
}: ClimbListRowProps) {
  const { t } = useTranslation('climbs');
  const { colorScheme, systemColors } = useTheme();
  const isDark = colorScheme === 'dark';
  const { formatGrade } = useGradeFormat();

  const gradeColor = getGradeColor(climb.difficulty) ?? DEFAULT_GRADE_COLOR;
  const formattedGrade = formatGrade(climb.difficulty);

  // --- Double-tap favorite (ephemeral heart animation only — favorite status
  // is not available in the search query, so we don't show it in the subtitle) ---
  const { handleDoubleTap, showHeart, dismissHeart } = useDoubleTapFavorite({
    climbUuid: climb.uuid,
  });

  // --- Swipe gesture state ---
  const translateX = useSharedValue(0);
  const leftShortOpacity = useSharedValue(0);
  const leftLongOpacity = useSharedValue(0);
  const rightActionOpacity = useSharedValue(0);
  const swipeConfirmed = useSharedValue(false);

  // Reset shared values when the climb changes (FlashList recycles rows)
  useEffect(() => {
    translateX.value = 0;
    leftShortOpacity.value = 0;
    leftLongOpacity.value = 0;
    rightActionOpacity.value = 0;
    swipeConfirmed.value = false;
  }, [climb.uuid, translateX, leftShortOpacity, leftLongOpacity, rightActionOpacity, swipeConfirmed]);

  // Stable refs for callbacks to avoid gesture closure staleness
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;
  const onAddToQueueRef = useRef(onAddToQueue);
  onAddToQueueRef.current = onAddToQueue;
  const resolvedOpenPlaylist = onOpenPlaylist ?? onOpenActions;
  const onOpenPlaylistRef = useRef(resolvedOpenPlaylist);
  onOpenPlaylistRef.current = resolvedOpenPlaylist;
  const onOpenActionsRef = useRef(onOpenActions);
  onOpenActionsRef.current = onOpenActions;
  const climbRef = useRef(climb);
  climbRef.current = climb;
  const unsupportedRef = useRef(unsupported);
  unsupportedRef.current = unsupported;

  const handleRowPress = useCallback(() => {
    if (unsupportedRef.current) return;
    hapticLight();
    onPressRef.current(climbRef.current);
  }, []);

  const handleSwipeAddToQueue = useCallback(() => {
    hapticSuccess();
    onAddToQueueRef.current?.(climbRef.current);
  }, []);

  const handleSwipeOpenActions = useCallback(() => {
    hapticMedium();
    onOpenActionsRef.current?.(climbRef.current);
  }, []);

  const handleSwipePlaylist = useCallback(() => {
    hapticMedium();
    onOpenPlaylistRef.current?.(climbRef.current);
  }, []);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-10, 10])
        .failOffsetY([-15, 15])
        .onUpdate((event) => {
          'worklet';
          const offset = event.translationX;

          if (offset > 0) {
            const clamped = Math.min(offset, MAX_GESTURE_SWIPE);
            translateX.value = clamped;

            const baseOpacity = Math.min(1, clamped / SHORT_SWIPE_THRESHOLD);
            const transitionRange = LONG_SWIPE_THRESHOLD - TRANSITION_START;
            const blend =
              transitionRange > 0 ? Math.max(0, Math.min(1, (clamped - TRANSITION_START) / transitionRange)) : 1;

            leftShortOpacity.value = baseOpacity * (1 - blend);
            leftLongOpacity.value = baseOpacity * blend;
            rightActionOpacity.value = 0;
          } else {
            const clamped = Math.max(offset, -RIGHT_ACTION_WIDTH - 20);
            translateX.value = clamped;

            leftShortOpacity.value = 0;
            leftLongOpacity.value = 0;
            rightActionOpacity.value = Math.min(1, -clamped / SHORT_SWIPE_THRESHOLD);
          }
        })
        .onEnd(() => {
          'worklet';
          const offset = translateX.value;

          if (offset > LONG_SWIPE_THRESHOLD) {
            translateX.value = withSpring(0, { damping: 20, stiffness: 200 });
            leftShortOpacity.value = withTiming(0, { duration: 200 });
            leftLongOpacity.value = withTiming(0, { duration: 200 });
            runOnJS(handleSwipeOpenActions)();
          } else if (offset > SHORT_SWIPE_THRESHOLD) {
            translateX.value = withSpring(0, { damping: 20, stiffness: 200 });
            leftShortOpacity.value = withTiming(0, { duration: 200 });
            leftLongOpacity.value = withTiming(0, { duration: 200 });
            runOnJS(handleSwipePlaylist)();
          } else if (offset < -SHORT_SWIPE_THRESHOLD) {
            swipeConfirmed.value = true;
            translateX.value = withSpring(0, { damping: 20, stiffness: 200 });
            rightActionOpacity.value = withTiming(0, { duration: 300 }, () => {
              swipeConfirmed.value = false;
            });
            runOnJS(handleSwipeAddToQueue)();
          } else {
            translateX.value = withSpring(0, { damping: 20, stiffness: 200 });
            leftShortOpacity.value = withTiming(0, { duration: 150 });
            leftLongOpacity.value = withTiming(0, { duration: 150 });
            rightActionOpacity.value = withTiming(0, { duration: 150 });
          }
        }),
    [
      translateX,
      leftShortOpacity,
      leftLongOpacity,
      rightActionOpacity,
      swipeConfirmed,
      handleSwipeAddToQueue,
      handleSwipeOpenActions,
      handleSwipePlaylist,
    ],
  );

  // Double-tap gesture on the thumbnail
  const doubleTapGesture = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .onStart(() => {
          'worklet';
          runOnJS(handleDoubleTap)();
        }),
    [handleDoubleTap],
  );

  // Single tap on the whole row — uses ref to avoid hoisting/stale closure issues
  const handleRowPressRef = useRef(handleRowPress);
  handleRowPressRef.current = handleRowPress;

  const stableRowPress = useCallback(() => {
    handleRowPressRef.current();
  }, []);

  const singleTapGesture = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(300)
        .maxDistance(15)
        .onStart(() => {
          'worklet';
          runOnJS(stableRowPress)();
        }),
    [stableRowPress],
  );

  const handleMenuPress = useCallback(() => {
    hapticLight();
    onOpenActionsRef.current?.(climbRef.current);
  }, []);

  // --- Animated styles ---
  const contentAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const leftShortActionStyle = useAnimatedStyle(() => ({
    opacity: leftShortOpacity.value,
  }));

  const leftLongActionStyle = useAnimatedStyle(() => ({
    opacity: leftLongOpacity.value,
  }));

  const rightActionAnimatedStyle = useAnimatedStyle(() => ({
    opacity: rightActionOpacity.value,
  }));

  const rightConfirmedStyle = useAnimatedStyle(() => ({
    opacity: withTiming(swipeConfirmed.value ? 1 : 0, { duration: 120 }),
  }));

  // --- Background color (selected state) ---
  const backgroundColor = useMemo(() => {
    if (selected) {
      return getGradeTintColor(climb.difficulty, 'light', isDark) ?? `${iosSystemColors.systemGray}1A`;
    }
    return 'transparent';
  }, [selected, climb.difficulty, isDark]);

  // --- Subtitle parts (matching web's ClimbTitle gradePosition='right' layout) ---
  const subtitleText = useMemo(() => {
    const parts: string[] = [];
    if (climb.is_draft) {
      parts.push(t('createClimbForm.draftBadge'));
    }
    if (!climb.is_draft && climb.ascensionist_count) {
      parts.push(formatSends(climb.ascensionist_count));
    }
    const qualityNum = parseFloat(climb.quality_average);
    if (qualityNum > 0) {
      parts.push(`${formatQuality(climb.quality_average)}★`);
    }
    if (climb.setter_username) {
      parts.push(climb.setter_username);
    }
    return parts.length > 0 ? parts.join(' · ') : t('mobile.climbRow.projectFallback');
  }, [climb.is_draft, climb.ascensionist_count, climb.quality_average, climb.setter_username, t]);

  const tapGesture = useMemo(
    () => Gesture.Exclusive(doubleTapGesture, singleTapGesture),
    [doubleTapGesture, singleTapGesture],
  );

  const composedGesture = useMemo(() => Gesture.Race(tapGesture, panGesture), [tapGesture, panGesture]);

  return (
    <View style={[styles.outerContainer, unsupported && styles.unsupported]}>
      {/* Left action layers (revealed on swipe right) */}
      <View style={styles.leftActionContainer}>
        <AnimatedView style={[styles.leftShortAction, leftShortActionStyle]}>
          <Icon name="tag" size={20} color={iosSystemColors.white} />
        </AnimatedView>
        <AnimatedView style={[styles.leftLongAction, leftLongActionStyle]}>
          <Icon name="more" size={20} color={iosSystemColors.white} />
        </AnimatedView>
      </View>

      {/* Right action layer (revealed on swipe left) */}
      <View style={styles.rightActionContainer}>
        <AnimatedView style={[styles.rightActionDefault, rightActionAnimatedStyle]}>
          <Icon name="add" size={20} color={iosSystemColors.white} />
        </AnimatedView>
        <AnimatedView style={[styles.rightActionConfirmed, rightConfirmedStyle]}>
          <Icon name="check.small" size={20} color={iosSystemColors.white} />
        </AnimatedView>
      </View>

      {/* Main content row — single GestureDetector with composed gestures */}
      <GestureDetector gesture={composedGesture}>
        <AnimatedView style={[styles.contentRow, { backgroundColor }, contentAnimatedStyle]}>
          {/* Left: Thumbnail with ascent badge + heart overlay */}
          <View style={styles.thumbnailContainer}>
            <ClimbListThumbnail
              frames={climb.frames}
              boardName={boardName}
              layoutId={layoutId}
              sizeId={sizeId}
              setIds={setIds}
              mirrored={climb.mirrored ?? false}
            />
            <HeartAnimationOverlay visible={showHeart} onDismiss={dismissHeart} size={32} />
            <AscentStatusBadge climbUuid={climb.uuid} angle={angle} />
          </View>

          {/* Center: Name + subtitle */}
          <View style={styles.centerColumn}>
            <Text variant="body" numberOfLines={1} style={styles.climbName}>
              {climb.name}
            </Text>
            <Text variant="footnote" numberOfLines={1} style={styles.subtitle}>
              {subtitleText}
            </Text>
          </View>

          {/* Right: Colorized grade + menu button */}
          <View style={styles.rightSection}>
            <Text variant="headline" numberOfLines={1} style={[styles.gradeText, { color: gradeColor }]}>
              {formattedGrade ?? climb.difficulty}
            </Text>
            <Pressable
              onPress={handleMenuPress}
              hitSlop={spacing[2]}
              accessibilityRole="button"
              accessibilityLabel={t('mobile.climbRow.menuAccessibility', { climbName: climb.name })}
            >
              <Icon name="more" size={20} color={iosSystemColors.systemGray} />
            </Pressable>
          </View>
        </AnimatedView>
      </GestureDetector>

      {/* Separator */}
      <View style={[styles.separator, { backgroundColor: systemColors.separator }]} />
    </View>
  );
});

export { ClimbListRow };

const styles = StyleSheet.create({
  outerContainer: {
    position: 'relative',
    overflow: 'hidden',
  },
  unsupported: {
    opacity: 0.5,
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[2],
    gap: spacing[3],
  },
  thumbnailContainer: {
    width: spacing[16],
    height: spacing[16],
    flexShrink: 0,
    position: 'relative',
  },
  centerColumn: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: 2,
  },
  climbName: {
    fontWeight: '600',
  },
  subtitle: {
    opacity: 0.6,
  },
  rightSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    flexShrink: 0,
  },
  gradeText: {
    fontWeight: '700',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing[16] + spacing[2] + spacing[3],
  },
  // --- Swipe action layers ---
  leftActionContainer: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: SHORT_ACTION_WIDTH,
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingLeft: spacing[4],
  },
  leftShortAction: {
    ...StyleSheet.absoluteFill,
    backgroundColor: brandColors.primary,
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingLeft: spacing[4],
  },
  leftLongAction: {
    ...StyleSheet.absoluteFill,
    backgroundColor: iosSystemColors.systemGray,
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingLeft: spacing[4],
  },
  rightActionContainer: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: RIGHT_ACTION_WIDTH,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingRight: spacing[4],
  },
  rightActionDefault: {
    ...StyleSheet.absoluteFill,
    backgroundColor: brandColors.success,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingRight: spacing[4],
  },
  rightActionConfirmed: {
    ...StyleSheet.absoluteFill,
    backgroundColor: brandColors.success,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingRight: spacing[4],
  },
});
