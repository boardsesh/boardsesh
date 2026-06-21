import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAnimatedStyle, useSharedValue, withSequence, withSpring } from 'react-native-reanimated';
import type { Climb } from '@boardsesh/queue';
import { useOptionalBoardProvider } from '@boardsesh/board-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { useQueueSessionId } from '../../providers/queue-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { springs } from '../../theme/animations';
import { hapticSelection } from '../../lib/haptics';
import { countSentAscents } from '../../lib/ascent-status-utils';

export function useLogAscentAction(climb: Climb) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { boardConfig, openLogAscent } = useDrawerHost();
  const { sessionId } = useQueueSessionId();
  const board = useOptionalBoardProvider();
  const reduceMotion = useReduceMotion();

  const angle = climb.angle;
  const isMirror = climb.mirrored === true;

  // Count of send/flash ticks for this climb at this angle — the same logbook
  // selector the climb-row status glyph uses, so the toolbar and the list
  // marker agree.
  const sentCount = useMemo(
    () => (board ? countSentAscents(board.logbook, climb.uuid, angle) : 0),
    [board, climb.uuid, angle],
  );
  const isLogged = sentCount > 0;

  // Make sure the current climb's ticks are loaded, even when it isn't one of
  // the visible list rows the screen already fetched, so the ticked-state is
  // accurate on every tab.
  useEffect(() => {
    if (board && climb.uuid) void board.getLogbook([climb.uuid]);
  }, [board, climb.uuid]);

  // Success burst: pop once when a fresh send/flash lands for the climb the user
  // just ticked. `pendingRef` (armed on press) gates out the false positive of
  // the logbook simply finishing its initial load for an already-logged climb,
  // and the baseline resets per climb so switching to a logged climb never pops.
  const pop = useSharedValue(1);
  const pendingRef = useRef(false);
  const baselineRef = useRef<{ uuid: string; count: number } | null>(null);
  useEffect(() => {
    const baseline = baselineRef.current;
    if (!baseline || baseline.uuid !== climb.uuid) {
      baselineRef.current = { uuid: climb.uuid, count: sentCount };
      pendingRef.current = false;
      return;
    }
    if (sentCount > baseline.count) {
      if (pendingRef.current && !reduceMotion) {
        pop.value = withSequence(withSpring(1.18, springs.bouncy), withSpring(1, springs.snappy));
      }
      pendingRef.current = false;
    }
    baselineRef.current = { uuid: climb.uuid, count: sentCount };
  }, [climb.uuid, sentCount, reduceMotion, pop]);

  const popStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));

  const handleLogAscentPress = useCallback(() => {
    if (!boardConfig) return;
    pendingRef.current = true;
    hapticSelection();
    openLogAscent({
      climbUuid: climb.uuid,
      boardName: boardConfig.boardName,
      angle,
      isMirror,
      isBenchmark: climb.benchmark_difficulty != null,
      layoutId: boardConfig.layoutId,
      sizeId: boardConfig.sizeId,
      setIds: boardConfig.setIds,
      sessionId,
      consensusGradeName: climb.difficulty,
    });
  }, [openLogAscent, boardConfig, sessionId, climb, angle, isMirror]);

  // Always neutral glass — no coloured background. The "you sent this" signal
  // rides the glyph instead: a green tick when logged, the system label otherwise
  // (colour on the icon, suitable for a glass element), keeping the action
  // readable over whatever scrolls behind it.
  const iconColor = isLogged ? brandColors.success : systemColors.label;

  const baseLabel = t('mobile.queue.logAscent');
  const accessibilityLabel = isLogged ? `${baseLabel}, ${t('mobile.queue.alreadyLogged')}` : baseLabel;

  return {
    accessibilityLabel,
    disabled: !boardConfig,
    fallbackColor: systemColors.fill,
    handleLogAscentPress,
    iconColor,
    popStyle,
  };
}
