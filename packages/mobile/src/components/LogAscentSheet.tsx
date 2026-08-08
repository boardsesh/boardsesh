// Bottom-sheet wrapper around QuickTickBar. Used by every ticking entry
// point — the play drawer's tick button, the persistent queue bar, the
// climb detail screen — so the form, dismissal model (handle + pan-down +
// native scrim tap), and keyboard handling stay identical across surfaces.
//
// Uses `BottomSheetModal` (not the regular `BottomSheet`) so it presents as
// a native modal above the play drawer's own modal.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { BottomSheetModal } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useManagedSheet } from '../providers/sheet-presentation-provider';
import { useTheme } from '../providers/theme-provider';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing } from '../theme/tokens';
import { track } from '../lib/analytics';
import { Icon } from './Icon';
import { useSheetColumnStyle } from './use-sheet-column-style';
import { QuickTickBar, type QuickTickDismissSnapshot } from './play-drawer/QuickTickBar';

type LogAscentSheetProps = {
  visible: boolean;
  /** Request an animated close (close button, pan-down, tick complete). The
   * parent flips `visible` false; the sheet stays mounted until the animation
   * settles (onFullyDismissed). */
  onClose: () => void;
  /** Fired once the dismiss animation has settled — safe for the parent to clear
   * the climb data / unmount without tearing the native Host down mid-animation.
   * Optional: always-mounted hosts (PlayDrawer) don't unmount, so they omit it. */
  onFullyDismissed?: () => void;
  climbUuid: string;
  boardName: string;
  angle: number;
  isMirror: boolean;
  isBenchmark: boolean;
  baseAscensionistCount: number;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  sessionId?: string | null;
  consensusGradeName?: string;
};

export function LogAscentSheet({
  visible,
  onClose,
  onFullyDismissed,
  climbUuid,
  boardName,
  angle,
  isMirror,
  isBenchmark,
  baseAscensionistCount,
  layoutId,
  sizeId,
  setIds,
  sessionId,
  consensusGradeName,
}: LogAscentSheetProps) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const { systemColors } = useTheme();
  const { t } = useTranslation('session');

  // Tracks whether the open tick got saved, so handleClose below can tell a
  // completed save (QuickTickSaved already covers it) apart from a genuine
  // abandon via the X-button / pan-down / backdrop tap (none of which call
  // back into QuickTickBar, so it can't distinguish these itself).
  const savedRef = useRef(false);
  const fieldSnapshotRef = useRef<QuickTickDismissSnapshot>({
    hasQuality: false,
    hasDifficulty: false,
    hasComment: false,
    attemptCountChanged: false,
  });

  // A fresh present (new climb, or reopening on the same one) must not
  // inherit a stale `true` left over from a previous save-then-dismiss cycle.
  useEffect(() => {
    if (visible) savedRef.current = false;
  }, [visible]);

  const handleClose = useCallback(() => {
    if (!savedRef.current) {
      track(SHARED_EVENTS.QuickTickDismissed, {
        climbUuid,
        layoutId: layoutId ?? null,
        ...fieldSnapshotRef.current,
      });
    }
    onClose();
  }, [climbUuid, layoutId, onClose]);

  // Present/dismiss go through the coordinator (serialized, no overlapping
  // transitions); `onClose` fires on a user pan-down, `onFullyDismissed` after
  // the animation settles.
  const managed = useManagedSheet({ open: visible, sheetRef, onClose: handleClose, onFullyDismissed });

  // Default to 60% so the climb image stays visible above the sheet (the
  // UX review flagged full-cover + carousel-disabled as the wrong
  // tradeoff). The 92% snap is the keyboard-extended state; the native sheet
  // keeps the focused input and save buttons above the keyboard.
  const snapPoints = useMemo(() => ['60%', '92%'], []);

  // The detent the sheet is resting at, tracked from the native onChange so the
  // iOS column bound below follows a drag (or the keyboard extension) between
  // 60% and 92% instead of leaving a dead gap under the save row.
  const [activeIndex, setActiveIndex] = useState(0);

  // QuickTickBar is a scroll body with a pinned save row, which only works if
  // this column is clamped to the detent. On iOS the @expo/ui SwiftUI sheet host
  // can propose an UNBOUNDED height to its RN content, so a flex:1 column sizes
  // to its CONTENT: the scroll body never gains an overflow (nothing scrolls)
  // and the save row lands past the detent, unreachable — the exact #3330
  // failure, and the one a re-present of this always-mounted host (PlayDrawer
  // keeps it alive for the life of the player) is most prone to. The shared hook
  // pins the column to the active detent's height JS-side; Android bounds it
  // natively and keeps flex:1.
  const columnStyle = useSheetColumnStyle(snapPoints, { activeIndex });

  const handleChange = useCallback(
    (index: number) => {
      // -1 is a close. Reset to the shortest detent so the next present of this
      // always-mounted host starts bounded — erring short beats a stale 92%
      // column pushing the save row off-screen for a frame.
      setActiveIndex(index >= 0 ? index : 0);
      managed.onChange(index);
    },
    [managed],
  );

  return (
    <BottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      enablePanDownToClose
      onChange={handleChange}
      onFullyDismissed={managed.onFullyDismissed}
      handleIndicatorStyle={styles.indicator}
      keyboardBehavior="extend"
      keyboardBlurBehavior="restore"
    >
      {/* The sheet's single in-flow child, carrying the detent bound. Handed
          several children instead, the native sheet sizes to content and the
          flex:1 scroll body inside QuickTickBar collapses. */}
      <View testID="log-ascent-column" style={columnStyle}>
        <View style={styles.closeButtonRow}>
          <Pressable
            onPress={handleClose}
            accessibilityRole="button"
            accessibilityLabel={t('playView.tickBar.closeAria')}
            hitSlop={8}
            style={({ pressed }) => [
              styles.closeButton,
              { backgroundColor: systemColors.fill },
              pressed && styles.closeButtonPressed,
            ]}
          >
            <Icon name="chevron.down" size={18} color={systemColors.secondaryLabel} />
          </Pressable>
        </View>
        <QuickTickBar
          climbUuid={climbUuid}
          boardName={boardName}
          angle={angle}
          isMirror={isMirror}
          isBenchmark={isBenchmark}
          baseAscensionistCount={baseAscensionistCount}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          sessionId={sessionId}
          consensusGradeName={consensusGradeName}
          onDismiss={handleClose}
          savedRef={savedRef}
          fieldSnapshotRef={fieldSnapshotRef}
        />
      </View>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  indicator: {
    backgroundColor: iosSystemColors.separator,
    width: 36,
    height: 5,
    borderRadius: 3,
  },
  closeButtonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: spacing[4],
    paddingTop: spacing[1],
  },
  closeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonPressed: {
    opacity: 0.7,
  },
});
