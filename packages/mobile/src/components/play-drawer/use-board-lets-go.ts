import { useCallback, useContext, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { BoardPresenceCurrentContext } from '@boardsesh/board-presence-react';
import type { BoardConnectionHolder } from '@boardsesh/shared-schema';
import { useViewerUserId } from '../../hooks/use-viewer-user-id';
import { announceQueued } from '../../lib/announce-queued';
import { takeLinkEnd } from '../../lib/ble/link-end-store';
import { hapticWarning } from '../../lib/haptics';
import {
  LETS_GO_STALE_MS,
  LETS_GO_TAKER_WAIT_MS,
  clearLetsGo,
  formatLetsGo,
  resolveLetsGoTaker,
  showLetsGo,
  takenByOf,
  type LetsGoNotice,
} from './board-lets-go-store';
import { exitDriveMode, getDriveMode, sendHeldDriveEndedReport, type DriveModeState } from './drive-mode-store';
import { spokenCaption } from './track-label-text';

/** A link that dropped on its own, while waiting for confirmed takeover evidence. */
type LostLink = {
  droppedAt: number;
  /** The board presence was bound to at the drop: another board drops the notice. */
  boardId: number | null;
  sessionId: string | null;
  viewerUserId: string | null;
  signedIn: boolean;
  /** Presence progress when the drive (or idle connection) started, and at the drop. */
  driveStartSeq: number;
  dropSeq: number;
  /** A wall with no lights another climber took: never "disconnected". */
  takenByPeer: boolean;
  /** An idle link only announces confirmed takeovers, and has no drive report to settle. */
  endedDrive: boolean;
};

/**
 * Say so when the board lets go mid-drive (board plan item 8). Mounted once,
 * in `DriveModeWatcher`, which also hands it links dropped after driving ended
 * (`endDriveForLinkDrop`). Those idle links only announce confirmed takeovers.
 *
 * A drop this phone made (a hang-up, a board switch, a new connect replacing
 * the link: `link-end-store.ts`) ends the drive as before, and says nothing.
 * A drop it didn't make holds Drive Mode Ended back and waits up to
 * `LETS_GO_TAKER_WAIT_MS` to hear from board presence who has the board now,
 * then says it once: a warning buzz, one screen-reader line, and the caption
 * on the player's top bar (`board-lets-go-store.ts`).
 *
 * - Presence names a holder who took it during the drive: "Sam took the
 *   board", or "Another phone has the board" when it can't name them (an
 *   anonymous holder, or a wall with no lights another climber took).
 * - No taker is confirmed by the end of the wait: a dropped drive says "Board
 *   disconnected · Put on board reconnects"; an idle link stays silent.
 * - The link came back, a connect is on its way, a new drive started, or the
 *   board changed before then: nothing is said.
 *
 * Drive Mode Ended goes once it is settled, with `takenBy`. Nothing else is
 * ever said for this end: once per link drop, never per retry. Idle links do
 * not invent a drive-ended report. Stopping a drive alone says nothing.
 */
export function useBoardLetsGo({
  linked,
  pending,
  boardId,
  sessionId,
  drive,
  signedIn,
}: {
  /** This phone's Bluetooth link, or its hold on a wall with no lights. */
  linked: boolean;
  /** A connect or disconnect is in flight. */
  pending: boolean;
  boardId: number | null;
  sessionId: string | null;
  drive: DriveModeState | null;
  signedIn: boolean;
}): () => void {
  const { t } = useTranslation('session');
  // Non-throwing: outside the provider there is no holder to name.
  const presence = useContext(BoardPresenceCurrentContext);
  const holder = presence?.holder ?? null;
  // Freeze connection progress at drive/drop boundaries, then compare only
  // actual holder changes against them. A delayed pre-boundary event must not
  // name a taker, and a later stats-only repair must not invent one either.
  const connectionProgressSeq = presence?.lastConnectionSeq ?? 0;
  const holderChangeSeq = presence?.lastHolderChangeSeq ?? 0;
  const viewerUserId = useViewerUserId();
  const latestRef = useRef<{
    holder: BoardConnectionHolder | null;
    holderChangeSeq: number;
    connectionProgressSeq: number;
    viewerUserId: string | null;
    signedIn: boolean;
    linked: boolean;
    pending: boolean;
    boardId: number | null;
    sessionId: string | null;
    t: TFunction<'session'>;
  }>({
    holder,
    holderChangeSeq,
    connectionProgressSeq,
    viewerUserId,
    signedIn,
    linked,
    pending,
    boardId,
    sessionId,
    t,
  });
  latestRef.current = {
    holder,
    holderChangeSeq,
    connectionProgressSeq,
    viewerUserId,
    signedIn,
    linked,
    pending,
    boardId,
    sessionId,
    t,
  };

  // Connection progress when each drive started: an earlier holder took nothing.
  const startSeqRef = useRef<{ startedAt: number; seq: number } | null>(null);
  const linkStartRef = useRef({ linked, boardId, sessionId, viewerUserId, signedIn, seq: connectionProgressSeq });
  useEffect(() => {
    const previous = linkStartRef.current;
    if (!linked) {
      linkStartRef.current = { ...previous, linked: false };
      return;
    }
    linkStartRef.current = {
      linked,
      boardId,
      sessionId,
      viewerUserId,
      signedIn,
      seq:
        linked &&
        (!previous.linked ||
          previous.boardId !== boardId ||
          previous.sessionId !== sessionId ||
          previous.viewerUserId !== viewerUserId ||
          previous.signedIn !== signedIn)
          ? connectionProgressSeq
          : previous.seq,
    };
  }, [linked, boardId, sessionId, viewerUserId, signedIn, connectionProgressSeq]);
  const driveStartedAt = drive?.startedAt ?? null;
  useEffect(() => {
    if (driveStartedAt === null || startSeqRef.current?.startedAt === driveStartedAt) return;
    startSeqRef.current = { startedAt: driveStartedAt, seq: latestRef.current.connectionProgressSeq };
  }, [driveStartedAt]);

  const lostRef = useRef<LostLink | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finish = useCallback((notice: LetsGoNotice | null) => {
    const lost = lostRef.current;
    if (!lost) return;
    lostRef.current = null;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (lost.endedDrive) sendHeldDriveEndedReport({ takenBy: takenByOf(notice) });
    if (!notice || Date.now() - lost.droppedAt > LETS_GO_STALE_MS) return;
    const { t: translate } = latestRef.current;
    showLetsGo(notice, lost.boardId);
    hapticWarning();
    announceQueued(spokenCaption(formatLetsGo(notice, translate)));
  }, []);

  // `waitOver`: the wait's own timer, which settles the drop whatever the clock
  // reads. A timer that fires a beat early, or a clock stepped back during the
  // wait, would otherwise leave it unsaid with nothing to finish it.
  const settle = useCallback(
    ({ waitOver = false }: { waitOver?: boolean } = {}) => {
      const lost = lostRef.current;
      if (!lost) return;
      const now = latestRef.current;
      // Back, on its way back, driving again, or on another board: nothing to say.
      if (
        now.linked ||
        now.pending ||
        getDriveMode() !== null ||
        now.boardId !== lost.boardId ||
        now.sessionId !== lost.sessionId ||
        now.viewerUserId !== lost.viewerUserId ||
        now.signedIn !== lost.signedIn
      ) {
        finish(null);
        return;
      }
      const taker = resolveLetsGoTaker({
        holder: now.holder,
        holderChangeSeq: now.holderChangeSeq,
        driveStartSeq: lost.driveStartSeq,
        dropSeq: lost.dropSeq,
        viewerUserId: now.viewerUserId,
        signedIn: now.signedIn,
      });
      if (taker) finish(taker);
      else if (lost.takenByPeer) finish({ kind: 'taken' });
      else if (waitOver || Date.now() - lost.droppedAt >= LETS_GO_TAKER_WAIT_MS) {
        finish(lost.endedDrive ? { kind: 'dropped' } : null);
      }
    },
    [finish],
  );

  const endDriveForLinkDrop = useCallback(() => {
    const end = takeLinkEnd();
    const link = linkStartRef.current;
    const current = latestRef.current;
    // This phone let go (or the end went unnoted): the drive ends as before, quietly.
    if (
      !end ||
      end.deliberate ||
      link.boardId !== current.boardId ||
      link.sessionId !== current.sessionId ||
      link.viewerUserId !== current.viewerUserId ||
      link.signedIn !== current.signedIn
    ) {
      exitDriveMode('link_dropped');
      return;
    }
    const ended = exitDriveMode('link_dropped', { holdReport: true });
    const { connectionProgressSeq: dropSeq, boardId: droppedOn } = latestRef.current;
    const start = startSeqRef.current;
    lostRef.current = {
      droppedAt: Date.now(),
      boardId: droppedOn,
      sessionId: latestRef.current.sessionId,
      viewerUserId: latestRef.current.viewerUserId,
      signedIn: latestRef.current.signedIn,
      // An unseen drive only trusts post-drop changes; idle links use their own start.
      driveStartSeq: ended ? (start?.startedAt === ended.startedAt ? start.seq : dropSeq) : linkStartRef.current.seq,
      dropSeq,
      takenByPeer: end.takenByPeer,
      endedDrive: ended !== null,
    };
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => settle({ waitOver: true }), LETS_GO_TAKER_WAIT_MS);
    settle();
  }, [settle]);

  // Each change presence or the link brings can settle a waiting drop.
  useEffect(() => {
    settle();
  }, [holder, holderChangeSeq, linked, pending, boardId, sessionId, viewerUserId, signedIn, drive, settle]);

  // The caption and temporary button label describe the lost link: clear them
  // when a retry starts, the link returns, a drive starts, or the board changes.
  const driving = drive !== null;
  useEffect(() => {
    if (linked || pending || driving) clearLetsGo();
  }, [linked, pending, driving]);
  const identityRef = useRef({ boardId, sessionId, viewerUserId, signedIn });
  useEffect(() => {
    const previous = identityRef.current;
    if (
      previous.boardId === boardId &&
      previous.sessionId === sessionId &&
      previous.viewerUserId === viewerUserId &&
      previous.signedIn === signedIn
    )
      return;
    identityRef.current = { boardId, sessionId, viewerUserId, signedIn };
    clearLetsGo();
  }, [boardId, sessionId, viewerUserId, signedIn]);

  // Unmounting sends a held Drive Mode Ended as it stands, and says nothing.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      clearLetsGo();
      if (!lostRef.current) return;
      const endedDrive = lostRef.current.endedDrive;
      lostRef.current = null;
      if (endedDrive) sendHeldDriveEndedReport({ takenBy: null });
    },
    [],
  );

  return endDriveForLinkDrop;
}
