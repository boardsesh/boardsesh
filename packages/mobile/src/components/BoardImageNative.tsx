import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';
import { isMoonboardBoardName } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import { useNativeClimbRender } from '../hooks/use-native-climb-render';
import type { BackgroundVariant } from '../lib/background-image-cache';
import type { BoardRenderSettings } from '../lib/board-render-settings';
import type { HoldColorOverrides } from '../lib/hold-color-overrides';
import { LayeredClimbImage } from './LayeredClimbImage';
import { MoonBoardGridLabels } from './board/MoonBoardGridLabels';
import { useBoardAccessibilitySummary } from '../hooks/use-board-accessibility-summary';
import { overlayRetainIdentity } from '../lib/overlay-retain-identity';
import { isBoardArtInMemory } from '../lib/board-render/warm-board-art-memory';
import {
  getPrivacyCredentialGeneration,
  getPrivacyRevocationGeneration,
  subscribeToPrivacyRevocations,
} from '../lib/privacy/privacy-cache';
import {
  isReadyBoardArtCurrent,
  type ReadyBoardArtIdentity,
  type ReadyBoardArtSnapshot,
  type BoardArtReadiness,
} from '../lib/board-render/ready-board-art';

type BoardImageNativeProps = {
  readyBoardArt?: ReadyBoardArtSnapshot;
  onReadyArtDisplayed?: (art: ReadyBoardArtIdentity & { overlayUri: string; overlayLoadKey: string | null }) => void;
  onArtReadinessChange?: (readiness: BoardArtReadiness) => void;
  accessible?: boolean;
  frames: string;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  boardWidth: number;
  boardHeight: number;
  mirrored?: boolean;
  /**
   * Render lit holds as filled dots (filled style) instead of the default
   * stroke-only outlines. The full-size play view leaves this false — thin
   * strokes stay legible when large — but small surfaces like the 40×40
   * accessory thumbnail pass true so holds read as solid dots once scaled
   * down. Threaded into the render cache key, so the two styles cache as
   * separate PNGs (see useNativeClimbRender).
   */
  filledStyle?: boolean;
  /**
   * This is THE board the climber is looking at — the play drawer's current
   * card. Sets `surface: 'play'` on render-failure telemetry and turns on the
   * overlay paint watchdog. Every other call site (preview cards and rails, the
   * preview sheet, the reaction menu, the wall kiosk hero, the carousel's
   * off-screen peek) leaves it off: pooling those into one rate would describe
   * nothing anybody experienced.
   */
  playSurface?: boolean;
  /**
   * Target overlay/background width in px for small surfaces (e.g. the
   * 40×40 accessory thumbnail). Forwarded to useNativeClimbRender so the
   * Rust renderer + bundled background resolve at a small size instead of
   * the board's native ~1080px — avoiding a main-thread downscale. Omit
   * for the full-size play view (renders at native board width).
   */
  renderWidth?: number;
  /**
   * Force the bundled board-photo resolution independently of `renderWidth`.
   * The play-drawer carousel passes `renderWidth` (display-sized overlay) +
   * `backgroundVariant="full"` (crisp shared photo). See useNativeClimbRender.
   */
  backgroundVariant?: BackgroundVariant;
  /**
   * Forwarded to the holds-overlay <Image> so expo-image recycles the view and
   * releases the previous climb's decoded overlay when this stays mounted but
   * the climb changes (the play-drawer carousel swapping climbs). Key it on the
   * per-climb `frames`.
   */
  recyclingKey?: string;
  style?: ViewStyle;
  /**
   * Hold the board photo back until the holds have painted, so a board that
   * opens onto a climb nobody has rendered yet appears whole instead of as a bare
   * wall the holds then fade onto. Ignored when the overlay is already rendered
   * or cannot come at all. See `LayeredClimbImage`.
   */
  revealWithOverlay?: 'each-climb' | 'first-paint';
  /**
   * Drop the holds overlay's cross-fade for this render — forwarded to
   * LayeredClimbImage. The play-drawer carousel sets it on the current board while
   * committing a swipe so the new climb's (already-cached) holds swap instantly
   * instead of fading up, which removed the Android end-of-swipe flash.
   */
  suppressOverlayTransition?: boolean;
  /**
   * testID forwarded to the holds-overlay layer, which only mounts once the async
   * overlay render is ready — lets screenshot/e2e flows wait for the lit board to
   * appear. The full-size play-drawer board sets this; thumbnails leave it unset.
   */
  overlayTestID?: string;
  paintedTestID?: string;
  paintedExtraTestID?: string;
  /**
   * Ceiling for the veil — the wash over the unlit wall. Editing surfaces pass
   * `EDITING_VEIL_OPACITY` (none), so the holds a climber still has to find and
   * tap keep the wall they sit on. Only ever lowers; see `useNativeClimbRender`.
   */
  maxVeilOpacity?: number;
  /**
   * Hold the last painted overlay while the next one renders — for surfaces
   * whose frames change on every tap. The board identity the retained frame is
   * scoped to is derived here. See `LayeredClimbImage`.
   */
  retainPreviousOverlay?: boolean;
  /** Preserve this climb's displayed holds during a same-climb size refinement. */
  retainDisplayedOverlay?: boolean;
  /**
   * Drawn above the board photo and below the holds overlay — for marks that
   * belong on the wall rather than on the climb. See `LayeredClimbImage`.
   */
  underOverlay?: ReactNode;
  /**
   * Drawn while no overlay has ever painted, i.e. when the native renderer is
   * unavailable and none is coming. Lets a surface that must show its holds
   * degrade to a JS-drawn layer instead of showing none.
   */
  emptyOverlayFallback?: ReactNode;
  /**
   * Draw the MoonBoard's A-K / row-number labels above the holds, when the
   * climber has them on (Settings › Board). For full-size boards only: at
   * thumbnail size the labels are 1-2 px specks. No effect on other boards.
   */
  showGridLabels?: boolean;
  /**
   * Draw under a different board-render settings bundle than the climber's
   * stored one — the board-look carousel's preview cards. Only the board-render
   * half is substituted: hold colours and marker shapes still come from the
   * global override store, so picking a preset can never be a back door into the
   * accessibility store. To vary the COLOURS of a preview instead, pass
   * `holdColorOverride` below — the two props are the board half and the colour
   * half of the same "draw this card differently" seam, and either can be used
   * without the other. Must be referentially stable; see `useNativeClimbRender`.
   */
  renderSettingsOverride?: BoardRenderSettings;
  /**
   * Draw this preview's four hold roles in a different set of colours than the
   * climber's stored ones — the colour-vision palette rail, whose cards each
   * show the same board under a different palette. Never writes the override
   * store, so previewing a palette cannot reach the physical board's LEDs.
   *
   * `{}` draws the board's own shipped palette; `undefined` reads the store.
   * Must be referentially stable; see `useNativeClimbRender`.
   */
  holdColorOverride?: HoldColorOverrides;
};

/**
 * Full-size layered board image, suited for the PlayView drawer and the
 * climb detail page. Wraps the shared LayeredClimbImage stack in an
 * aspect-ratio-locked container so the bundled board background and
 * holds-only overlay line up perfectly regardless of native source
 * dimensions.
 *
 * Mirrors via CSS to match the SVG renderer's behavior (background +
 * holds flipped together) — the Rust `mirrored` flag is intentionally
 * not used here, so a single cached PNG serves both orientations.
 */
const BoardImageNative = React.memo(function BoardImageNative({
  readyBoardArt,
  onReadyArtDisplayed,
  onArtReadinessChange,
  accessible = true,
  frames,
  boardName,
  layoutId,
  sizeId,
  setIds,
  boardWidth,
  boardHeight,
  mirrored,
  filledStyle = false,
  playSurface = false,
  renderWidth,
  backgroundVariant,
  recyclingKey,
  style,
  revealWithOverlay,
  suppressOverlayTransition,
  overlayTestID,
  paintedTestID,
  paintedExtraTestID,
  renderSettingsOverride,
  holdColorOverride,
  maxVeilOpacity,
  retainPreviousOverlay,
  retainDisplayedOverlay,
  underOverlay,
  emptyOverlayFallback,
  showGridLabels = false,
}: BoardImageNativeProps) {
  const {
    overlayUri,
    overlayLoadKey,
    overlayImmediate,
    overlayUnavailable,
    overlayFailed,
    onOverlayLoad,
    onOverlayError,
    onOverlayMounted,
    backgroundPaths,
    missingBackgroundCount,
    backgroundBaseColor,
    rendererUnavailable,
    artworkIdentity,
  } = useNativeClimbRender({
    frames,
    boardName,
    layoutId,
    sizeId,
    setIds,
    filledStyle,
    playSurface,
    renderWidth,
    backgroundVariant,
    renderSettingsOverride,
    holdColorOverride,
    maxVeilOpacity,
  });

  // Already rendered when the board took this climb AND decoded into memory, so
  // it is on the layer the frame the board mounts. Rendered alone is not enough:
  // the view would show the bare wall for the frames its own decode takes.
  const overlayPaintsWithBoard = overlayImmediate && isBoardArtInMemory(overlayUri);
  const openingArt = isReadyBoardArtCurrent(readyBoardArt, { ...artworkIdentity, mirrored: mirrored ?? false })
    ? readyBoardArt
    : undefined;
  const currentArtIdentity = JSON.stringify(
    paintedTestID === undefined
      ? [artworkIdentity, overlayUri, overlayLoadKey, backgroundPaths]
      : [artworkIdentity, overlayUri, overlayLoadKey, backgroundPaths, paintedTestID, mirrored ?? false],
  );
  const [displayedArtIdentity, setDisplayedArtIdentity] = useState<string | null>(null);
  const openingArtIsCurrent =
    openingArt?.quality === 'full' &&
    openingArt.overlayUri === overlayUri &&
    openingArt.overlayLoadKey === overlayLoadKey;
  const bridging =
    openingArt !== undefined &&
    !openingArtIsCurrent &&
    !overlayUnavailable &&
    displayedArtIdentity !== currentArtIdentity;
  const handleArtReadinessChange = useCallback(
    (ready: boolean) => onArtReadinessChange?.(overlayFailed ? 'failed' : ready && !bridging ? 'ready' : 'loading'),
    [onArtReadinessChange, overlayFailed, bridging],
  );
  const liveArtRef = useRef({ identity: currentArtIdentity, bridging, onReadyArtDisplayed });
  liveArtRef.current = { identity: currentArtIdentity, bridging, onReadyArtDisplayed };
  const pendingVisibleArtRef = useRef<{
    identity: string;
    art: ReadyBoardArtIdentity & { overlayUri: string; overlayLoadKey: string | null };
  } | null>(null);
  useEffect(() => {
    const pending = pendingVisibleArtRef.current;
    if (bridging || !pending || pending.identity !== currentArtIdentity) return;
    // onDisplay beneath an opacity-zero bridge means the replacement is ready,
    // not yet visible. Report after the visibility commit reaches a frame.
    const frame = requestAnimationFrame(() => {
      if (liveArtRef.current.identity !== pending.identity || liveArtRef.current.bridging) return;
      pendingVisibleArtRef.current = null;
      liveArtRef.current.onReadyArtDisplayed?.(pending.art);
    });
    return () => cancelAnimationFrame(frame);
  }, [bridging, currentArtIdentity]);

  const containerStyle: ViewStyle = {
    width: '100%',
    aspectRatio: boardWidth / boardHeight,
    ...style,
  };

  const accessibilitySummary = useBoardAccessibilitySummary(boardName, frames);

  // Every credential bump also bumps the revocation generation, so one
  // subscription covers both. Reading through the store keeps the value stable
  // for the whole render and re-renders this board when either moves, which is
  // what drops a displayed overlay that belonged to the previous account.
  const privacyGenerations = useSyncExternalStore(subscribeToPrivacyRevocations, readPrivacyGenerations);
  const retainedOverlayIdentity = useMemo(
    () =>
      retainDisplayedOverlay && frames
        ? JSON.stringify([overlayRetainIdentity(boardName, layoutId, sizeId, setIds), frames, privacyGenerations])
        : undefined,
    [retainDisplayedOverlay, frames, boardName, layoutId, sizeId, setIds, privacyGenerations],
  );

  // One element for both stacks (the bridge and the live board), memoised so
  // `LayeredClimbImage`'s memo still holds across this component's renders.
  // Never on a mirrored board: the art's letters would read backwards.
  // `ReadyBoardArtIdentity` keeps the scheme as a plain string.
  const artColorScheme = artworkIdentity.colorScheme === 'dark' ? 'dark' : 'light';
  const gridLabels = useMemo(
    () =>
      showGridLabels && isMoonboardBoardName(boardName) && !mirrored ? (
        <MoonBoardGridLabels layoutId={layoutId} colorScheme={artColorScheme} />
      ) : null,
    [showGridLabels, boardName, layoutId, mirrored, artColorScheme],
  );

  return (
    <View
      accessible={accessible}
      accessibilityRole="image"
      accessibilityLabel={accessibilitySummary}
      style={containerStyle}
    >
      {bridging && (
        <LayeredClimbImage
          overlayUri={openingArt.overlayUri}
          overlayLoadKey={openingArt.overlayLoadKey}
          backgroundPaths={[...openingArt.backgroundPaths]}
          baseColor={openingArt.backgroundBaseColor}
          mirrored={openingArt.mirrored}
          suppressOverlayTransition
          aboveOverlay={gridLabels}
        />
      )}
      <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, opacity: bridging ? 0 : 1 }}>
        <LayeredClimbImage
          overlayUri={overlayUri}
          overlayLoadKey={overlayLoadKey}
          onOverlayLoad={onOverlayLoad}
          onOverlayError={onOverlayError}
          onOverlayMounted={onOverlayMounted}
          displayIdentity={currentArtIdentity}
          onArtReadinessChange={handleArtReadinessChange}
          overlayRequired={!!frames && !overlayUnavailable}
          onArtDisplayed={(loadKey) => {
            if (!overlayUri || loadKey !== overlayLoadKey) return;
            const displayedArt = { ...artworkIdentity, overlayUri, overlayLoadKey: loadKey };
            if (bridging) pendingVisibleArtRef.current = { identity: currentArtIdentity, art: displayedArt };
            if (openingArt) setDisplayedArtIdentity(currentArtIdentity);
            if (!bridging) onReadyArtDisplayed?.(displayedArt);
          }}
          backgroundPaths={backgroundPaths}
          baseColor={backgroundBaseColor}
          missingBackgroundCount={missingBackgroundCount}
          mirrored={mirrored}
          recyclingKey={recyclingKey}
          // Nothing to wait for when the holds are already rendered and decoded,
          // when there are none to draw, or when no overlay is coming.
          revealWithOverlay={
            frames && !bridging && !overlayPaintsWithBoard && !overlayUnavailable ? revealWithOverlay : undefined
          }
          // An overlay that paints with the board has nothing to fade from.
          suppressOverlayTransition={suppressOverlayTransition || overlayPaintsWithBoard || bridging}
          overlayTestID={overlayTestID}
          paintedTestID={bridging ? undefined : paintedTestID}
          paintedExtraTestID={bridging ? undefined : paintedExtraTestID}
          // A bridge only makes sense while a replacement is on its way. Empty
          // frames render nothing at all — `useNativeClimbRender` returns before
          // it draws — so retaining there would leave the holds the climber just
          // cleared painted on the board with nothing ever coming to replace them.
          //
          // `overlayRetainIdentity` folds the spray wall version in, so a reset is a
          // different board as far as bridging goes.
          retainPreviousOverlayFor={
            retainPreviousOverlay && frames ? overlayRetainIdentity(boardName, layoutId, sizeId, setIds) : undefined
          }
          retainDisplayedOverlayFor={retainedOverlayIdentity}
          underOverlay={underOverlay}
          aboveOverlay={gridLabels}
          // Only once the loader has given up: a null overlay during an ordinary
          // cold render is "not yet", and showing the fallback there would flash
          // JS-drawn holds before the real ones on every capable device.
          emptyOverlayFallback={rendererUnavailable ? emptyOverlayFallback : undefined}
        />
      </View>
    </View>
  );
});

const readPrivacyGenerations = (): string => `${getPrivacyRevocationGeneration()}:${getPrivacyCredentialGeneration()}`;

export { BoardImageNative };
