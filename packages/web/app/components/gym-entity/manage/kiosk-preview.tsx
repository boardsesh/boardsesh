'use client';

// Live kiosk preview for the editor: the REAL kiosk component tree
// (KioskThemeScope → header → preset grid with BoardSlot/LeaderboardRail),
// driven by the LOCAL unsaved editor state and scaled from 1920×1080 logical
// pixels into a 16:9 box. The presence hub is mounted for real, so assigned
// boards light up live while the owner edits. Unlike the TV — which runs the
// login-less `KioskPresenceHub` — the preview mounts `ViewerKioskPresenceHub`
// and carries the editor's ws auth token, because `gymKiosk`'s edit branch
// hands back PRIVATE gym boards that an anonymous presence read would mask as
// NOT_FOUND. Network cost is one ws connection + the presence subscriptions
// for the assigned boards (plus the period-leaderboard query when the rail is
// in a day/week/month mode).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { kioskPresetForBoardCount } from '@boardsesh/kiosk';
import type { Gym, GymKioskBoard, UserBoard } from '@boardsesh/shared-schema';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { getBackendHttpUrl } from '@/app/lib/backend-url';
import type { BoardDetails } from '@/app/lib/types';
import { buildBoardRenderUrl } from '../../board-renderer/util';
import KioskThemeScope from '../../kiosk/kiosk-theme-scope';
import KioskHeader from '../../kiosk/kiosk-header';
import KioskLayout from '../../kiosk/kiosk-layout';
import KioskAttribution from '../../kiosk/kiosk-attribution';
import { ViewerKioskPresenceHub } from '../../kiosk/presence/viewer-kiosk-presence-hub';
import BoardSlot from '../../kiosk/board-slot/board-slot';
import LeaderboardRail from '../../kiosk/leaderboard-rail/leaderboard-rail';
import { buildKioskViewModel } from '../../kiosk/kiosk-view-model';
import layoutStyles from '../../kiosk/kiosk-layout.module.css';
import { resolveGymLogoDisplayUrl } from '@/app/lib/gym-logo-display-url';
import { serializeKioskLayout, type KioskEditorState } from './kiosk-editor-state';
import styles from './kiosk-preview.module.css';

/** The kiosk's logical TV width (the 1920×1080 canvas lives in the CSS module). */
const KIOSK_LOGICAL_WIDTH = 1920;

type PreviewSlot =
  | {
      kind: 'board';
      board: GymKioskBoard;
      boardDetails: BoardDetails;
      bareBoardImageUrl: string;
    }
  | {
      /**
       * Guard tile: the slot's board has no presence id for this viewer or an
       * unresolvable config. Shouldn't occur for editors (gymBoards populates
       * boardId per the edit-access gate), but a placeholder beats a crash.
       */
      kind: 'missing';
      boardUuid: string;
      name: string | null;
    };

function toGymKioskBoard(board: UserBoard): GymKioskBoard | null {
  if (board.boardId === null || board.boardId === undefined) return null;
  return {
    boardId: board.boardId,
    boardUuid: board.uuid,
    slug: board.slug,
    name: board.name,
    boardType: board.boardType,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
    angle: board.angle,
  };
}

function resolvePreviewSlot(boardUuid: string, gymBoards: UserBoard[]): PreviewSlot {
  const userBoard = gymBoards.find((board) => board.uuid === boardUuid);
  if (!userBoard) {
    return { kind: 'missing', boardUuid, name: null };
  }
  const kioskBoard = toGymKioskBoard(userBoard);
  if (kioskBoard === null) {
    return { kind: 'missing', boardUuid, name: userBoard.name };
  }
  try {
    const boardDetails = getBoardDetailsForBoard({
      board_name: kioskBoard.boardType,
      layout_id: kioskBoard.layoutId,
      size_id: kioskBoard.sizeId,
      set_ids: kioskBoard.setIds.split(',').map(Number),
    });
    return {
      kind: 'board',
      board: kioskBoard,
      boardDetails,
      bareBoardImageUrl: buildBoardRenderUrl(boardDetails, '', { includeBackground: true }),
    };
  } catch {
    return { kind: 'missing', boardUuid, name: userBoard.name };
  }
}

type KioskPreviewProps = {
  gym: Gym;
  kioskName: string;
  state: KioskEditorState;
  gymBoards: UserBoard[];
};

export default function KioskPreview({ gym, kioskName, state, gymBoards }: KioskPreviewProps) {
  const { t } = useTranslation('kiosk');
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const updateScale = () => setScale(frame.clientWidth / KIOSK_LOGICAL_WIDTH);
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  // Split memos: slot resolution rebuilds BoardDetails (hundreds of hold
  // objects per board) and new bareBoardImageUrl identities, which would
  // defeat React.memo(BoardRenderer) — so it's keyed on the boardUuids array,
  // whose identity survives leaderboard-only edits (the pure state transitions
  // spread the state but keep the untouched boardUuids array).
  const slots = useMemo(
    () => state.boardUuids.map((boardUuid) => resolvePreviewSlot(boardUuid, gymBoards)),
    [state.boardUuids, gymBoards],
  );

  // The same derivation the TV runs: lenient layout parse + leaderboard-scope
  // widening against the boards that actually render.
  const viewModel = useMemo(() => {
    const renderableBoards = slots
      .filter((slot): slot is Extract<PreviewSlot, { kind: 'board' }> => slot.kind === 'board')
      .map((slot) => slot.board);
    return buildKioskViewModel({ layout: serializeKioskLayout(state), boards: renderableBoards });
  }, [slots, state]);

  // Preset over ALL slots (missing ones included) so the grid shape always
  // matches what the owner configured, with guard tiles filling the gaps —
  // unlike the TV, which degrades the preset when a board drops out.
  const preset = kioskPresetForBoardCount(slots.length);
  const distinctBoardIds = Array.from(new Set(viewModel.boards.map((board) => board.boardId)));

  const rail =
    viewModel.leaderboard === null ? null : (
      <LeaderboardRail leaderboard={viewModel.leaderboard} boards={viewModel.boards} refetchInBackground={false} />
    );

  const logoDisplayUrl = resolveGymLogoDisplayUrl(gym.logoUrl ?? null, getBackendHttpUrl());

  return (
    <div ref={frameRef} className={styles.frame}>
      {scale > 0 && (
        <div className={styles.stage} style={{ transform: `scale(${scale})` }}>
          <KioskThemeScope gym={gym}>
            <ViewerKioskPresenceHub boardIds={distinctBoardIds}>
              <div className={styles.chrome}>
                <KioskHeader gymName={gym.name} logoUrl={logoDisplayUrl} kioskName={kioskName} />
                {preset === null ? (
                  <div className={layoutStyles.setupPlaceholder}>
                    <h2 className={layoutStyles.setupTitle}>{t('setup.title')}</h2>
                    <p className={layoutStyles.setupBody}>{t('setup.body')}</p>
                  </div>
                ) : (
                  <KioskLayout preset={preset} rail={rail}>
                    {slots.map((slot, slotIndex) =>
                      slot.kind === 'board' ? (
                        <BoardSlot
                          key={slot.board.boardUuid}
                          boardId={slot.board.boardId}
                          boardName={slot.board.name}
                          angle={slot.board.angle}
                          boardDetails={slot.boardDetails}
                          initialClimb={null}
                          initialClimbImageUrl={null}
                          bareBoardImageUrl={slot.bareBoardImageUrl}
                          slug={slot.board.slug}
                          showInstallQr={state.showInstallQr}
                        />
                      ) : (
                        <div key={`${slot.boardUuid}-${slotIndex}`} className={styles.missingSlot}>
                          {slot.name === null
                            ? t('manage.editor.previewMissingBoard')
                            : t('manage.editor.previewUnavailable', { name: slot.name })}
                        </div>
                      ),
                    )}
                  </KioskLayout>
                )}
              </div>
              <KioskAttribution hasRail={rail !== null && preset !== null} />
            </ViewerKioskPresenceHub>
          </KioskThemeScope>
        </div>
      )}
    </div>
  );
}
