import { useCallback, useEffect, useMemo } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { BlurView } from '@react-native-community/blur';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ListRow } from '../ListRow';
import { GlassSurface } from '../GlassSurface';
import { BoardImageNative } from '../BoardImageNative';
import { ClimbAttributeIcons } from '../ClimbAttributeIcons';
import { getBoardRenderData } from '../../lib/board-details';
import { formatSends, formatQuality } from '../../lib/format-climb-stats';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useTheme } from '../../providers/theme-provider';
import type { BoardConfig } from '../../providers/drawer-host-provider';
import { springs, timing } from '../../theme/animations';
import { spacing, borderRadius } from '../../theme/tokens';
import { useClimbActions } from './use-climb-actions';

type ClimbReactionMenuProps = {
  climb: Climb;
  boardConfig: BoardConfig;
  currentUserId?: string | null;
  isAuthenticated: boolean;
  onEditEntry?: () => void;
  /** Read once at the app root (resolved) and passed in, so the mount-time enter
   *  animation uses the real value rather than useReduceMotion's conservative default. */
  reduceMotion: boolean;
  onClose: () => void;
};

// iOS portals above the persistent queue bar / tab bar via a native window overlay;
// Android uses a transparent Modal (which also gives a hardware-back handler).
function OverlayPortal({ children, onRequestClose }: { children: React.ReactNode; onRequestClose: () => void }) {
  if (Platform.OS === 'ios') return <FullWindowOverlay>{children}</FullWindowOverlay>;
  return (
    <Modal transparent statusBarTranslucent visible animationType="none" onRequestClose={onRequestClose}>
      {children}
    </Modal>
  );
}

function fitBoardArt(boardWidth: number, boardHeight: number, maxSize: number) {
  const aspect = boardWidth / boardHeight;
  if (!Number.isFinite(aspect) || aspect <= 0) return { width: maxSize, height: maxSize };
  return aspect >= 1 ? { width: maxSize, height: maxSize / aspect } : { width: maxSize * aspect, height: maxSize };
}

/**
 * iMessage-style long-press reaction overlay: the climb floats, scaled up, over a
 * blurred background, with the climb-action menu floating beside it. Built with
 * Reanimated + BlurView so we control the enlargement, the animation, and the layout
 * — the native context-menu library can't host a custom enlarged preview on RN's New
 * Architecture (the preview leaks into the row). Used for every list long-press via
 * the provider's `openClimbActions`; PlayDrawer keeps its own bottom sheet.
 *
 * Mounted only while open; the enter animation runs on mount (using the passed
 * `reduceMotion`), and dismissal animates out before calling `onClose`. Actions come
 * from the shared `useClimbActions` hook — the same list the bottom sheet renders.
 */
export function ClimbReactionMenu({
  climb,
  boardConfig,
  currentUserId,
  isAuthenticated,
  onEditEntry,
  reduceMotion,
  onClose,
}: ClimbReactionMenuProps) {
  const { colorScheme } = useTheme();
  const { t } = useTranslation('climbs');
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const { formatGrade } = useGradeFormat();

  const progress = useSharedValue(0);

  const finishClose = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    progress.value = reduceMotion ? 1 : withSpring(1, springs.gentle);
  }, [progress, reduceMotion]);

  const dismiss = useCallback(() => {
    if (reduceMotion) {
      finishClose();
      return;
    }
    progress.value = withTiming(0, { duration: timing.fast }, (finished) => {
      if (finished) runOnJS(finishClose)();
    });
  }, [progress, reduceMotion, finishClose]);

  const actions = useClimbActions({
    climb,
    boardConfig,
    currentUserId,
    isAuthenticated,
    onEditEntry,
    onAfterAction: dismiss,
  });

  const gradeColor = getGradeColor(climb.difficulty) ?? DEFAULT_GRADE_COLOR;
  const formattedGrade = formatGrade(climb.difficulty);

  // Subtle byline under the name: sends · quality★ · setter (each dropped when
  // absent). Mirrors the climb-list row's primary subtitle.
  const byline = useMemo(() => {
    const parts: string[] = [];
    if (!climb.is_draft && climb.ascensionist_count) parts.push(formatSends(climb.ascensionist_count, t));
    if (parseFloat(climb.quality_average) > 0) parts.push(`${formatQuality(climb.quality_average)}★`);
    if (climb.setter_username) parts.push(climb.setter_username);
    return parts.join(' · ');
  }, [climb.is_draft, climb.ascensionist_count, climb.quality_average, climb.setter_username, t]);

  // Enlarged board art, reusing the list thumbnail's cache (filledStyle + renderWidth
  // 400) so no new render is needed. Sized to the screen so it stays "blown up" but
  // leaves room for the menu (~20% larger than the first pass).
  const artMaxSize = Math.min(235, Math.round(windowHeight * 0.31), Math.round(windowWidth * 0.66));
  const boardRenderData = useMemo(() => {
    const setIdValues = boardConfig.setIds
      .split(',')
      .map((setIdText) => Number(setIdText))
      .filter((setIdValue) => Number.isFinite(setIdValue));
    if (setIdValues.length === 0) return null;
    return getBoardRenderData({
      boardName: boardConfig.boardName as BoardName,
      layoutId: boardConfig.layoutId,
      sizeId: boardConfig.sizeId,
      setIds: setIdValues,
    });
  }, [boardConfig]);

  const artStyle = useMemo<ViewStyle | null>(() => {
    if (!boardRenderData) return null;
    const fitted = fitBoardArt(boardRenderData.boardWidth, boardRenderData.boardHeight, artMaxSize);
    return { width: fitted.width, height: fitted.height, borderRadius: borderRadius.lg, overflow: 'hidden' };
  }, [boardRenderData, artMaxSize]);

  // Cap the menu so preview + menu always fit; it scrolls internally if the action
  // list is long on a short screen.
  const menuMaxHeight = Math.max(180, windowHeight - insets.top - insets.bottom - artMaxSize - 140 - spacing[5] * 2);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const previewStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.9 + progress.value * 0.1 }],
  }));
  const menuStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * 18 }, { scale: 0.96 + progress.value * 0.04 }],
  }));

  const scrimColor = colorScheme === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.35)';

  return (
    <OverlayPortal onRequestClose={dismiss}>
      <View style={StyleSheet.absoluteFill}>
        {/* Blurred / dimmed backdrop, tap to dismiss. */}
        <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
          {Platform.OS === 'ios' ? (
            <BlurView
              blurType={colorScheme === 'dark' ? 'dark' : 'light'}
              blurAmount={12}
              reducedTransparencyFallbackColor={scrimColor}
              style={StyleSheet.absoluteFill}
            />
          ) : null}
          <View style={[StyleSheet.absoluteFill, { backgroundColor: scrimColor }]} />
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={dismiss}
            accessibilityRole="button"
            accessibilityLabel={climb.name}
          />
        </Animated.View>

        {/* Floating content: enlarged climb + action menu. box-none so empty space
            falls through to the backdrop Pressable. */}
        <View
          pointerEvents="box-none"
          // Contain VoiceOver focus to the floating content (don't let it wander into
          // the screen behind), and let the VO escape gesture dismiss the overlay.
          accessibilityViewIsModal={Platform.OS === 'ios'}
          onAccessibilityEscape={dismiss}
          style={[styles.content, { paddingTop: insets.top + spacing[5], paddingBottom: insets.bottom + spacing[5] }]}
        >
          <Animated.View pointerEvents="box-none" style={[styles.preview, previewStyle]}>
            {boardRenderData && artStyle ? (
              <BoardImageNative
                frames={climb.frames}
                boardName={boardConfig.boardName as BoardName}
                layoutId={boardConfig.layoutId}
                sizeId={boardConfig.sizeId}
                setIds={boardConfig.setIds}
                boardWidth={boardRenderData.boardWidth}
                boardHeight={boardRenderData.boardHeight}
                mirrored={climb.mirrored === true}
                filledStyle
                renderWidth={400}
                style={artStyle}
              />
            ) : null}
            <View style={styles.previewText}>
              <View style={styles.nameRow}>
                <Text variant="headline" numberOfLines={1} style={styles.name}>
                  {climb.name}
                </Text>
                <ClimbAttributeIcons
                  isNoMatch={climb.is_no_match}
                  benchmarkDifficulty={climb.benchmark_difficulty}
                  characteristics={climb.characteristics}
                />
                {formattedGrade || climb.difficulty ? (
                  <Text variant="headline" numberOfLines={1} style={[styles.grade, { color: gradeColor }]}>
                    {formattedGrade ?? climb.difficulty}
                  </Text>
                ) : null}
              </View>
              {byline ? (
                <Text variant="footnote" numberOfLines={1} style={styles.byline}>
                  {byline}
                </Text>
              ) : null}
            </View>
          </Animated.View>

          <Animated.View style={[styles.menuWrap, menuStyle]}>
            <GlassSurface role="base" level="level2" borderRadius={borderRadius.xl} style={styles.menuCard}>
              <ScrollView
                style={{ maxHeight: menuMaxHeight }}
                bounces={false}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.menuContent}
              >
                {actions.map((action, index) => (
                  <ListRow
                    key={action.id}
                    title={action.title}
                    leading={<Icon name={action.icon} size={22} color={action.color} />}
                    onPress={action.run}
                    showSeparator={index < actions.length - 1}
                    separatorInset={56}
                  />
                ))}
              </ScrollView>
            </GlassSurface>
          </Animated.View>
        </View>
      </View>
    </OverlayPortal>
  );
}

const styles = StyleSheet.create({
  content: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[6],
    gap: spacing[5],
  },
  preview: {
    alignItems: 'center',
    gap: spacing[3],
    width: '100%',
    maxWidth: 320,
  },
  previewText: {
    alignItems: 'center',
    gap: 2,
    width: '100%',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    width: '100%',
  },
  name: {
    fontWeight: '700',
    flexShrink: 1,
  },
  byline: {
    opacity: 0.6,
    textAlign: 'center',
  },
  grade: {
    fontWeight: '800',
  },
  menuWrap: {
    width: '100%',
    maxWidth: 320,
    alignSelf: 'center',
  },
  menuCard: {
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
  },
  menuContent: {
    paddingVertical: spacing[1],
  },
});
