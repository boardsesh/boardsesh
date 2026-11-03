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

/** A drive's link that dropped on its own, until it is said. */
type LostLink = {
  droppedAt: number;
  /** The board presence was bound to at the drop: another board drops the notice. */
  boardId: number | null;
  /** Presence's last holder change when the drive started, and at the drop. */
  driveStartSeq: number;
  dropSeq: number;
  /** A wall with no lights another climber took: never "disconnected". */
  takenByPeer: boolean;
};

/**
 * Say so when the board lets go mid-drive (board plan item 8). Mounted once,
 * in `DriveModeWatcher`, which hands it every drive end that is a dropped link
 * (`endDriveForLinkDrop`).
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
 * - No one took it by the end of the wait: "Board disconnected · Put on board
 *   reconnects".
 * - The link came back, a connect is on its way, a new drive started, or the
 *   board changed before then: nothing is said.
 *
 * Drive Mode Ended goes once it is settled, with `takenBy`. Nothing else is
 * ever said for this end: once per drive end, never per retry, and never with
 * nobody driving or when the climber stopped the drive themselves (those end
 * as `stopped`, not as a dropped link).
 */
export function useBoardLetsGo({
  linked,
  pending,
  boardId,
  drive,
  signedIn,
}: {
  /** This phone's Bluetooth link, or its hold on a wall with no lights. */
  linked: boolean;
  /** A connect or disconnect is in flight. */
  pending: boolean;
  boardId: number | null;
  drive: DriveModeState | null;
  signedIn: boolean;
}): () => void {
  const { t } = useTranslation('session');
  // Non-throwing: outside the provider there is no holder to name.
  const presence = useContext(BoardPresenceCurrentContext);
  const holder = presence?.holder ?? null;
  // Not `lastConnectionSeq`: a catch-up moves that past every event it repaired
  // through, stats and history included, even when it reads back the same
  // holder. Only a real change of holder moves this (`resolveLetsGoTaker`).
  const holderChangeSeq = presence?.lastHolderChangeSeq ?? 0;
  const viewerUserId = useViewerUserId();
  const latestRef = useRef<{
    holder: BoardConnectionHolder | null;
    holderChangeSeq: number;
    viewerUserId: string | null;
    signedIn: boolean;
    linked: boolean;
    pending: boolean;
    boardId: number | null;
    t: TFunction<'session'>;
  }>({ holder, holderChangeSeq, viewerUserId, signedIn, linked, pending, boardId, t });
  latestRef.current = { holder, holderChangeSeq, viewerUserId, signedIn, linked, pending, boardId, t };

  // The holder change seen when each drive started: a holder from before it took nothing.
  const startSeqRef = useRef<{ startedAt: number; seq: number } | null>(null);
  const driveStartedAt = drive?.startedAt ?? null;
  useEffect(() => {
    if (driveStartedAt === null || startSeqRef.current?.startedAt === driveStartedAt) return;
    startSeqRef.current = { startedAt: driveStartedAt, seq: latestRef.current.holderChangeSeq };
  }, [driveStartedAt]);

  const lostRef = useRef<LostLink | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finish = useCallback((notice: LetsGoNotice | null) => {
    const lost = lostRef.current;
    if (!lost) return;
    lostRef.current = null;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    sendHeldDriveEndedReport({ takenBy: takenByOf(notice) });
    if (!notice || Date.now() - lost.droppedAt > LETS_GO_STALE_MS) return;
    const { t: translate } = latestRef.current;
    showLetsGo(notice);
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
      if (now.linked || now.pending || getDriveMode() !== null || now.boardId !== lost.boardId) {
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
      else if (waitOver || Date.now() - lost.droppedAt >= LETS_GO_TAKER_WAIT_MS) finish({ kind: 'dropped' });
    },
    [finish],
  );

  const endDriveForLinkDrop = useCallback(() => {
    const end = takeLinkEnd();
    // This phone let go (or the end went unnoted): the drive ends as before, quietly.
    if (!end || end.deliberate) {
      exitDriveMode('link_dropped');
      return;
    }
    const ended = exitDriveMode('link_dropped', { holdReport: true });
    if (!ended) return;
    const { holderChangeSeq: dropSeq, boardId: droppedOn } = latestRef.current;
    const start = startSeqRef.current;
    lostRef.current = {
      droppedAt: Date.now(),
      boardId: droppedOn,
      // A drive this hook never saw start only trusts what changes after the drop.
      driveStartSeq: start?.startedAt === ended.startedAt ? start.seq : dropSeq,
      dropSeq,
      takenByPeer: end.takenByPeer,
    };
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => settle({ waitOver: true }), LETS_GO_TAKER_WAIT_MS);
    settle();
  }, [settle]);

  // Each change presence or the link brings can settle a waiting drop.
  useEffect(() => {
    settle();
  }, [holder, holderChangeSeq, linked, pending, boardId, drive, settle]);

  // The caption is about a link that is gone: it goes when the link is back,
  // a drive starts, or the board changes.
  const driving = drive !== null;
  useEffect(() => {
    if (linked || driving) clearLetsGo();
  }, [linked, driving]);
  const boardIdRef = useRef(boardId);
  useEffect(() => {
    if (boardIdRef.current === boardId) return;
    boardIdRef.current = boardId;
    clearLetsGo();
  }, [boardId]);

  // Unmounting sends a held Drive Mode Ended as it stands, and says nothing.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      if (!lostRef.current) return;
      lostRef.current = null;
      sendHeldDriveEndedReport({ takenBy: null });
    },
    [],
  );

  return endDriveForLinkDrop;
}
