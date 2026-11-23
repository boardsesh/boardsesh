// The one way a screen offers "Report a problem": a host for the report sheet
// and, when the sheet's "Run {{gym}}? Claim it" is tapped, the claim sheet.
//
// The sheets are returned as a node for the caller to mount inside its own
// route (the in-tree opener rule, docs/mobile/mobile-sheets-vs-routes.md): a
// native sheet presents from the view controller it is mounted under, so a
// board picker modal, a pushed edit route and the gym page each host their own.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import type { Gym } from '@boardsesh/shared-schema';
import { ClaimGymSheet } from '../gym-directory/ClaimGymSheet';
import { ReportDirectorySheet, type ReportProblemTarget } from './ReportDirectorySheet';
import { canReportBoard, canReportGym } from './report-problem-model';
import { useAuth } from '../../providers/auth-provider';
import { useDirectoryReportsEnabled } from '../../providers/feature-flags-provider';
import { useViewerUserId } from '../../hooks/use-viewer-user-id';
import type { ManagedSheetHandle } from '../../providers/sheet-presentation-provider';

export type { ReportProblemTarget } from './ReportDirectorySheet';

export type ReportProblemHost = {
  /** Opens the report sheet for this board or gym. Signed out, it opens login instead. */
  openReport: (target: ReportProblemTarget) => void;
  /** Mount this in the route that offers the report. */
  sheet: ReactNode;
};

function targetKey(target: ReportProblemTarget): string {
  return target.kind === 'board' ? `board:${target.board.uuid}` : `gym:${target.gym.uuid}`;
}

/**
 * A report sheet host for a surface with many targets (the board picker's
 * cards). Doesn't decide whether a target may be reported: the caller gates
 * its row with `canReportBoard` / `canReportGym`.
 */
export function useReportProblemHost(): ReportProblemHost {
  const { isAuthenticated } = useAuth();
  const router = useRouter();
  const [target, setTarget] = useState<ReportProblemTarget | null>(null);
  const [claimGym, setClaimGym] = useState<Gym | null>(null);
  const claimSheetRef = useRef<ManagedSheetHandle>(null);

  const openReport = useCallback(
    (next: ReportProblemTarget) => {
      if (!isAuthenticated) {
        router.push('/auth/login');
        return;
      }
      setTarget(next);
    },
    [isAuthenticated, router],
  );
  const closeReport = useCallback(() => setTarget(null), []);
  // The two can't stack: the report sheet goes, then the claim sheet presents.
  const openClaim = useCallback((gym: Gym) => {
    setTarget(null);
    setClaimGym(gym);
  }, []);
  const onClaimClosed = useCallback(() => setClaimGym(null), []);
  useEffect(() => {
    if (claimGym) claimSheetRef.current?.present();
  }, [claimGym]);

  const sheet = useMemo(
    () => (
      <>
        {target ? (
          <ReportDirectorySheet key={targetKey(target)} target={target} onClose={closeReport} onClaim={openClaim} />
        ) : null}
        {claimGym ? (
          <ClaimGymSheet key={claimGym.uuid} sheetRef={claimSheetRef} gym={claimGym} onClosed={onClaimClosed} />
        ) : null}
      </>
    ),
    [target, claimGym, closeReport, openClaim, onClaimClosed],
  );

  return useMemo(() => ({ openReport, sheet }), [openReport, sheet]);
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
 * The gym page (PR 8 of #8043) wires its row with
 * `useReportProblem({ target: gym ? { kind: 'gym', gym } : null })`.
 */
export function useReportProblem({ target }: { target: ReportProblemTarget | null }): ReportProblemAction | null {
  const enabled = useDirectoryReportsEnabled();
  const viewerUserId = useViewerUserId();
  const host = useReportProblemHost();
  const { openReport, sheet } = host;
  const available =
    target !== null &&
    (target.kind === 'board'
      ? canReportBoard(target.board, { enabled, viewerUserId })
      : canReportGym(target.gym, { enabled }));
  const open = useCallback(() => {
    if (target) openReport(target);
  }, [target, openReport]);
  return useMemo(() => (available ? { open, sheet } : null), [available, open, sheet]);
}
