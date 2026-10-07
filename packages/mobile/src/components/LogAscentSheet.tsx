// Bottom-sheet wrapper around the create-tick form. Used by every ticking entry
// point — the play drawer's tick button, the persistent queue bar, the climb
// detail screen — so the form, dismissal model (handle + pan-down + native
// scrim tap), and keyboard handling stay identical across surfaces.
//
// The chrome is `ModalSheet`: it presents as a native modal above the play
// drawer's own modal, supplies the scroll body (`scrollable`), pins the action
// bar (`footer`), and clamps its single column to the active detent via the
// same `useSheetColumnStyle` this file used to wire by hand (#3330).
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { getGradeColor } from '@boardsesh/board-constants/grade-colors';
import type { TickStatus } from '@boardsesh/play-view';
import { track } from '../lib/analytics';
import { ModalSheet } from './ModalSheet';
import { TickActionBar, TickSheetHeader, CREATE_TICK_SNAP_POINTS } from './tick';
import { QuickTickBar } from './play-drawer/QuickTickBar';
import { useQuickTickForm, type QuickTickDismissSnapshot } from './play-drawer/use-quick-tick-form';

const SAVE_ICON = 'tick.outline' as const;

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

export function LogAscentSheet({
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
  const { t } = useTranslation('climbs');

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

  const form = useQuickTickForm({
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

  // The identity bar follows the picked grade the moment the climber picks one,
  // and falls back to the community consensus before that.
  const gradeColor = useMemo(
    () => getGradeColor(form.resolvedGradeName ?? consensusGradeName ?? ''),
    [form.resolvedGradeName, consensusGradeName],
  );

  // `logAscentAria` interpolates a *noun*, so the status has to be resolved to
  // localised copy first — interpolating the raw `'send'` / `'flash'` enum left
  // Spanish, French and German screen-reader users hearing English.
  // Spelled out per key because the i18n linter rejects `t(variable)`.
  const statusNouns: Record<TickStatus, string> = useMemo(
    () => ({
      flash: t('mobile.tick.status.flash'),
      send: t('mobile.tick.status.send'),
      attempt: t('mobile.tick.status.attempt'),
    }),
    [t],
  );

  const subtitle = consensusGradeName
    ? t('mobile.tick.consensusMeta', { grade: consensusGradeName, angle })
    : t('mobile.tick.angleMeta', { angle });

  return (
    <ModalSheet
      visible={visible}
      onClose={handleClose}
      onFullyDismissed={onFullyDismissed}
      snapPoints={CREATE_TICK_SNAP_POINTS}
      scrollable
      surface="solid"
      footerSurface="flush"
      // Android's ~50% partial state can't fit this form under a pinned footer
      // (#4723), and a near-full single detent leaves ~310 dp of void below it
      // (#4720). Size the sheet to the form on Android instead — see
      // `androidContentSized` on `ModalSheet`.
      androidContentSized
      header={
        <TickSheetHeader
          title={climbName ?? t('mobile.tick.fallbackTitle')}
          subtitle={subtitle}
          gradeColor={gradeColor}
          onClose={handleClose}
          closeAccessibilityLabel={t('mobile.tick.closeAria')}
        />
      }
      footer={
        <TickActionBar
          error={form.lastError}
          secondary={{
            title: t('mobile.tick.attempt'),
            onPress: form.onAttempt,
            disabled: form.isPending,
            accessibilityLabel: t('mobile.tick.logAscentAria', { status: statusNouns.attempt }),
          }}
          primary={{
            title: form.saveLabel,
            onPress: form.onSave,
            loading: form.isPending,
            icon: SAVE_ICON,
            accessibilityLabel: t('mobile.tick.logAscentAria', { status: statusNouns[form.ascentType] }),
          }}
        />
      }
    >
      <QuickTickBar form={form} />
    </ModalSheet>
  );
}
