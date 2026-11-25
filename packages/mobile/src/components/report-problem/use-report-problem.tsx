// The one way a screen offers "Report a problem": a host for the report sheet
// and, when the sheet's "Run {{gym}}? Claim it" is tapped, the claim sheet.
//
// The sheets are returned as a node for the caller to mount inside its own
// route (the in-tree opener rule, docs/mobile/mobile-sheets-vs-routes.md): a
// native sheet presents from the view controller it is mounted under, so a
// board picker modal, a pushed edit route and the gym page each host their own.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { openSignIn } from '../../lib/routing/open-sign-in';
import { useGymRouteStack } from '../gym-page/use-gym-route-stack';
import type { Gym } from '@boardsesh/shared-schema';
import { ClaimGymSheet } from '../gym-directory/ClaimGymSheet';
import { ReportDirectorySheet, type ReportInitialSetup, type ReportProblemTarget } from './ReportDirectorySheet';
import type { BoardReportReason } from '@boardsesh/directory-moderation';
import { canReportBoard, canReportGym } from './report-problem-model';
import { useAuth } from '../../providers/auth-provider';
import { useDirectoryReportsEnabled } from '../../providers/feature-flags-provider';
import { useViewerUserId } from '../../hooks/use-viewer-user-id';
import type { ManagedSheetHandle } from '../../providers/sheet-presentation-provider';

export type { ReportProblemTarget } from './ReportDirectorySheet';

/**
 * How a report opens, for a caller that already knows what's wrong: the
 * builder's near-miss "Use it and fix its setup" (#8151).
 */
export type OpenReportOptions = {
  /** The reason already picked. */
  initialReason?: BoardReportReason;
  /** The setup the climber says the board has ("Set up wrong"). */
  initialSetup?: ReportInitialSetup;
  /** Off hides the done step's "Climb it now": the caller has bound the board already. */
  climbNowOffered?: boolean;
  /**
   * Called once the report is done with: its sheet has fully slid away, or the
   * claim sheet it handed over to has closed. Also called straight away when
   * no sheet opens (signed out: login opens instead), so a caller waiting on it
   * never hangs. Not called when a later `openReport` replaces it.
   */
  onClosed?: () => void;
};

export type ReportProblemHost = {
  /** Opens the report sheet for this board or gym. Signed out, it opens login instead. */
  openReport: (target: ReportProblemTarget, options?: OpenReportOptions) => void;
  /** Mount this in the route that offers the report. */
  sheet: ReactNode;
  /** The report sheet or the claim sheet it handed over to is up. */
  isOpen: boolean;
};

function targetKey(target: ReportProblemTarget): string {
  return target.kind === 'board' ? `board:${target.board.uuid}` : `gym:${target.gym.uuid}`;
}

/**
 * A report sheet host for a surface with many targets (the board picker's
 * cards). Doesn't decide whether a target may be reported: the caller gates
 * its row with `canReportBoard` / `canReportGym`.
 *
 * The open sheet's target is a snapshot held here, not the caller's prop, so a
 * caller whose own target goes away mid-report (a detail sheet the report sheet
 * displaced clears its board) does not tear the report sheet down with it.
 */
export function useReportProblemHost(): ReportProblemHost {
  const { isAuthenticated } = useAuth();
  const router = useRouter();
  // From inside the board picker, sign-in replaces it rather than stacking on it.
  const stack = useGymRouteStack();
  const [opened, setOpened] = useState<{ target: ReportProblemTarget; options: OpenReportOptions } | null>(null);
  const target = opened?.target ?? null;
  const [claimGym, setClaimGym] = useState<Gym | null>(null);
  const claimSheetRef = useRef<ManagedSheetHandle>(null);
  // The open report's `onClosed`, held until the report or the claim it handed
  // over to has gone.
  const onClosedRef = useRef<(() => void) | null>(null);
  const settleClosed = useCallback(() => {
    const onClosed = onClosedRef.current;
    onClosedRef.current = null;
    onClosed?.();
  }, []);

  const openReport = useCallback(
    (next: ReportProblemTarget, options: OpenReportOptions = {}) => {
      if (!isAuthenticated) {
        openSignIn(router, stack);
        options.onClosed?.();
        return;
      }
      onClosedRef.current = options.onClosed ?? null;
      setOpened({ target: next, options });
    },
    [isAuthenticated, router, stack],
  );
  const closeReport = useCallback(() => {
    setOpened(null);
    settleClosed();
  }, [settleClosed]);
  // The two can't stack. The report sheet has already dismissed itself and
  // waited for it to settle (ReportDirectorySheet), so this only swaps them.
  const openClaim = useCallback((gym: Gym) => {
    setOpened(null);
    setClaimGym(gym);
  }, []);
  const onClaimClosed = useCallback(() => {
    setClaimGym(null);
    settleClosed();
  }, [settleClosed]);
  useEffect(() => {
    if (claimGym) claimSheetRef.current?.present();
  }, [claimGym]);

  const sheet = useMemo(
    () => (
      <>
        {opened ? (
          <ReportDirectorySheet
            key={targetKey(opened.target)}
            target={opened.target}
            onClose={closeReport}
            onClaim={openClaim}
            initialReason={opened.options.initialReason ?? null}
            initialSetup={opened.options.initialSetup ?? null}
            climbNowOffered={opened.options.climbNowOffered ?? true}
            closeAfterDismissed={opened.options.onClosed !== undefined}
          />
        ) : null}
        {claimGym ? (
          <ClaimGymSheet key={claimGym.uuid} sheetRef={claimSheetRef} gym={claimGym} onClosed={onClaimClosed} />
        ) : null}
      </>
    ),
    [opened, claimGym, closeReport, openClaim, onClaimClosed],
  );

  const isOpen = target !== null || claimGym !== null;
  return useMemo(() => ({ openReport, sheet, isOpen }), [openReport, sheet, isOpen]);
}

/** "Report a problem" for one board or gym: open it, and mount `sheet` beside the row. */
export type ReportProblemAction = {
  open: () => void;
  sheet: ReactNode;
};

/**
 * "Report a problem" for one board or gym, or null when the surface should not
 * offer it: the `directory-reports` flag is off (fail closed), or the viewer
 * can fix the thing themselves (they added it, or they edit, remove or delete
 * it as staff), who get the fix actions instead.
 *
 * Signed out, `open` sends the climber to log in.
 *
 * Stays non-null while a report or claim sheet it opened is still up, even if
 * the target has gone in the meantime: the board detail sheet clears its board
 * when the report sheet displaces it, and dropping `sheet` then would unmount
 * the report sheet the climber is filling in.
 *
 * The gym page (PR 8 of #8043) wires its row with
 * `useReportProblem({ target: gym ? { kind: 'gym', gym } : null })`.
 */
export function useReportProblem({ target }: { target: ReportProblemTarget | null }): ReportProblemAction | null {
  const enabled = useDirectoryReportsEnabled();
  const viewerUserId = useViewerUserId();
  const { openReport, sheet, isOpen } = useReportProblemHost();
  const available =
    target !== null &&
    (target.kind === 'board'
      ? canReportBoard(target.board, { enabled, viewerUserId })
      : canReportGym(target.gym, { enabled }));
  const open = useCallback(() => {
    if (target) openReport(target);
  }, [target, openReport]);
  return useMemo(() => (available || isOpen ? { open, sheet } : null), [available, isOpen, open, sheet]);
}
