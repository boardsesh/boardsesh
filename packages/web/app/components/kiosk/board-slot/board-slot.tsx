'use client';

// One board on the kiosk: hero board art (contain-fit, nothing overlaid) +
// the identity strip below it.
//
// Art source, in order:
//  - Live feed published data → interactive-free SVG (BoardRenderer) with the
//    lit climb's holds (or bare when the wall is clear).
//  - No live data yet (SSR + pre-subscription) → the server-rendered raster
//    from the Railway /render/board endpoint, seeded from boardRecentClimbs at request
//    time. One cached webp paints far faster on a TV than the multi-image SVG,
//    and it keeps the server-rendered HTML meaningful.

import React, { useMemo } from 'react';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import type { BoardDetails } from '@/app/lib/types';
import BoardRenderer from '../../board-renderer/board-renderer';
import { convertLitUpHoldsStringToMap, toFlatFrames } from '../../board-renderer/util';
import { useKioskBoardPresence } from '../presence/use-kiosk-board-presence';
import BoardIdentity from './board-identity';
import BoardInstallQr from './board-install-qr';
import styles from './board-slot.module.css';

export type BoardSlotProps = {
  boardId: number;
  /** The kiosk board's display name ("Main Kilter", …). */
  boardName: string;
  /** The board's configured angle — the fallback when a climb carries none. */
  angle: number;
  boardDetails: BoardDetails;
  /** Server-seeded latest climb (boardRecentClimbs[0]) or null. */
  initialClimb: BoardPresenceClimb | null;
  /** Raster URL for the initial climb's frames (null when no initial climb). */
  initialClimbImageUrl: string | null;
  /** Raster URL for the bare board (idle placeholder). */
  bareBoardImageUrl: string;
  /**
   * The board's public slug (userBoards.slug) — the install-QR deep-link target.
   * Non-null to match GymKioskBoard.slug (`String!`); the truthy guard below is a
   * belt-and-braces check against an empty slug, not a null one.
   */
  slug: string;
  /** Whether this kiosk shows the per-board install QR (kiosk layout toggle). */
  showInstallQr: boolean;
};

export default function BoardSlot({
  boardId,
  boardName,
  angle,
  boardDetails,
  initialClimb,
  initialClimbImageUrl,
  bareBoardImageUrl,
  slug,
  showInstallQr,
}: BoardSlotProps) {
  const snapshot = useKioskBoardPresence(boardId);

  // Only trust the live feed once it has actually produced data — isLive flips
  // true before the backfill lands, and swapping to an empty wall for that
  // window would flash "Wall's open" under a climb that's really lit.
  const hasLiveData = snapshot !== null && (snapshot.currentClimb !== null || snapshot.history.length > 0);
  const displayClimb = hasLiveData ? snapshot.currentClimb : initialClimb;
  const lastLitClimb = hasLiveData ? (snapshot.history[0] ?? null) : initialClimb;

  const litUpHoldsMap = useMemo(() => {
    if (!hasLiveData || !displayClimb?.frames) return undefined;
    // Collapse a (possibly multi-frame) frames string to its cumulative final
    // lit state — same as what the raster placeholder renders.
    const flatFrames = toFlatFrames(displayClimb.frames, boardDetails.board_name);
    if (flatFrames.length === 0) return undefined;
    return convertLitUpHoldsStringToMap(flatFrames, boardDetails.board_name)[0];
  }, [hasLiveData, displayClimb?.frames, boardDetails.board_name]);

  return (
    <section className={styles.slot}>
      <div className={styles.art}>
        {showInstallQr && slug ? <BoardInstallQr slug={slug} /> : null}
        {hasLiveData ? (
          <BoardRenderer boardDetails={boardDetails} litUpHoldsMap={litUpHoldsMap} mirrored={false} fillHeight />
        ) : (
          <img
            className={styles.raster}
            src={displayClimb !== null && initialClimbImageUrl !== null ? initialClimbImageUrl : bareBoardImageUrl}
            alt=""
          />
        )}
      </div>
      <BoardIdentity boardName={boardName} boardAngle={angle} climb={displayClimb} lastLitClimb={lastLitClimb} />
    </section>
  );
}
