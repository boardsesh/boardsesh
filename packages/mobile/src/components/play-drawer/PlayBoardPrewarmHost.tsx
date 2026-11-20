import React, { useEffect, useSyncExternalStore } from 'react';
import { useNativeClimbRender } from '../../hooks/use-native-climb-render';
import { usePlayDrawerSurface } from '../../hooks/use-play-drawer-surface';
import { backgroundImageUri } from '../LayeredClimbImage';
import { warmBoardArtMemory } from '../../lib/board-render/warm-board-art-memory';
import { usePlayerGpuBoard } from './use-player-gpu-board';
import { climbOverlayGpuApiVersion } from '../../lib/board-render/gpu-native-capability';
import {
  clearPlayBoardPrewarm,
  getPlayBoardPrewarmTarget,
  subscribeToPlayBoardPrewarm,
  type PlayBoardPrewarmTarget,
} from '../../lib/board-render/play-board-prewarm';

/** Far longer than a drawer takes to open and measure (~150ms); see the host. */
const ABANDONED_TARGET_MS = 5000;

/**
 * The render for the climb that was just tapped. Draws nothing.
 *
 * Not `prefetch`: somebody IS about to look at this board, so it must not wait
 * for the renderer to go idle. Not `playSurface` either — that arms the paint
 * watchdog, and nothing here ever paints. Left at neither, the request ranks as
 * `full`, ahead of every list thumbnail, and the play board that mounts next
 * joins it (and raises it to `play`) if it is still running.
 */
const TappedBoardRender = React.memo(function TappedBoardRender({
  frames,
  boardName,
  layoutId,
  sizeId,
  setIds,
  renderWidth,
  playerGpuBoard,
}: PlayBoardPrewarmTarget & { playerGpuBoard: boolean }) {
  const { fieldColor } = usePlayDrawerSurface();
  const { overlayUri, overlayLoadKey, backgroundPaths } = useNativeClimbRender({
    frames,
    boardName,
    layoutId,
    sizeId,
    setIds,
    // Has to match the carousel's current board exactly — stroke style (the
    // default), its measured width, the full-size photo — or this renders a PNG
    // the drawer never looks up.
    renderWidth,
    backgroundVariant: 'full',
    fieldColorOverride: fieldColor,
    // Names the play board's GPU drawing exactly as the board does, so the
    // render is skipped only once that drawing is warm in this process.
    gpuCatalogueNative: climbOverlayGpuApiVersion >= 5,
    cachedOnlyOnceGpuWarm: playerGpuBoard,
  });
  // Decode what the drawer is about to show, so its images come out of memory
  // on the frame they mount.
  useEffect(() => {
    if (overlayUri) warmBoardArtMemory([overlayUri], overlayLoadKey?.split(':')[0]);
  }, [overlayUri, overlayLoadKey]);
  useEffect(() => {
    warmBoardArtMemory(backgroundPaths.map(backgroundImageUri));
  }, [backgroundPaths]);
  return null;
});

/**
 * Mount once beside a climb list. Renders the tapped climb's play-size board the
 * moment `requestPlayBoardPrewarm` names it; see `play-board-prewarm.ts`.
 */
export function PlayBoardPrewarmHost() {
  const target = useSyncExternalStore(subscribeToPlayBoardPrewarm, getPlayBoardPrewarmTarget);
  return target ? <PlayBoardPrewarm target={target} /> : null;
}

/**
 * Once the live GPU drawing is warm in this process it draws the player's first
 * holds itself (docs/rendering/gpu-climb-overlay-experiment.md), so the tap renders no new
 * PNG; the photo and any cached PNG are still decoded ahead. While it is cold
 * (the first open after a launch) the tap renders the PNG as it always did.
 */
function PlayBoardPrewarm({ target }: { target: PlayBoardPrewarmTarget }) {
  const playerGpuBoard = usePlayerGpuBoard(target.boardName, target.layoutId);
  // The carousel drops the target when it has measured. A tap that never gets
  // that far (the drawer dismissed mid-open) would leave the hidden render
  // mounted until the next tap, so let go of it after a while regardless.
  useEffect(() => {
    const timer = setTimeout(clearPlayBoardPrewarm, ABANDONED_TARGET_MS);
    return () => clearTimeout(timer);
  }, [target]);
  return <TappedBoardRender {...target} playerGpuBoard={playerGpuBoard} />;
}
