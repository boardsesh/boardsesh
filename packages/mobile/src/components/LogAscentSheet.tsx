import type { TickClimbIdentity } from '@boardsesh/board-config';
import { useCallback, useEffect, useRef } from 'react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../lib/analytics';
import type { PresenterGroup } from '../providers/sheet-presentation-provider';
import { QuickTickBar, type QuickTickBarProps } from './play-drawer/QuickTickBar';
import { useQuickTickForm, type QuickTickDismissSnapshot } from './play-drawer/use-quick-tick-form';
import { LogAscentSheetView } from './LogAscentSheetView';

type LogAscentSheetProps = {
  /** Only set when this host is physically inside another native sheet. */
  presenterGroup?: PresenterGroup;
  parentSheetId?: string;
  stacked?: boolean;
  climb?: TickClimbIdentity;
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
  /** Shown in the sheet header so the climber sees what they are logging. */
  climbName?: string;
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

export function LogAscentSheet(props: LogAscentSheetProps) {
  const snapshot = useRef(props);
  const wasVisible = useRef(false);
  if (props.visible && !wasVisible.current) snapshot.current = props;
  wasVisible.current = props.visible;
  return (
    <LogAscentSheetContent
      {...snapshot.current}
      visible={props.visible}
      onClose={props.onClose}
      onFullyDismissed={props.onFullyDismissed}
      presenterGroup={props.presenterGroup}
      parentSheetId={props.parentSheetId}
      stacked={props.stacked}
    />
  );
}

function LogAscentSheetContent({
  presenterGroup,
  parentSheetId,
  stacked,
  climb,
  visible,
  onClose,
  onFullyDismissed,
  climbUuid,
  climbName,
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
  // Tracks whether the open tick got saved, so handleClose below can tell a
  // completed save (TickLogged already covers it) apart from a genuine
  // abandon via the close button / pan-down / backdrop tap (none of which call
  // back into the form, so it can't distinguish these itself).
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
    if (visible) {
      savedRef.current = false;
    }
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

  const form = useQuickTickForm({
    visible,
    climb,
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
    onDismiss: handleClose,
    savedRef,
    fieldSnapshotRef,
  });

  const renderFields = useCallback(
    (options: Omit<QuickTickBarProps, 'form'>) => <QuickTickBar form={form} {...options} />,
    [form],
  );
  return (
    <LogAscentSheetView
      presenterGroup={presenterGroup}
      parentSheetId={parentSheetId}
      stacked={stacked}
      visible={visible}
      onClose={handleClose}
      onFullyDismissed={onFullyDismissed}
      climbName={climbName}
      angle={angle}
      consensusGradeName={consensusGradeName}
      baseAscensionistCount={baseAscensionistCount}
      form={form}
      renderFields={renderFields}
    />
  );
}
