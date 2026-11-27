import React, { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { BoardArtReadiness } from '../../lib/board-render/ready-board-art';
import { useBoardAccessibilitySummary } from '../../hooks/use-board-accessibility-summary';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { Image, type ImageErrorEventData } from 'expo-image';
import Svg, { Path, Rect } from 'react-native-svg';
import type { QuantumBoardDetails } from '@boardsesh/board-config';
import { useTheme } from '../../providers/theme-provider';
import { useIsAppBackgrounded } from '../../lib/app-visibility';
import type { BackgroundVariant } from '../../lib/bundled-board-art';
import { getQuantumGeometryBoardDetails } from '../../lib/quantum-geometry-store';
import { BoardHoldOverlay } from '../board-renderer/BoardHoldOverlay';
import { useBoardArtVisible } from '../board-art-visibility-context';
import { useParseFrames } from '../board-renderer/use-parse-frames';
import { getQuantumArtworkSource } from './quantum-board-artwork';
import { getQuantumNeutralGridPath, getQuantumRenderPathData } from './quantum-board-paths';
import type { HoldColorOverrides } from '../../lib/hold-color-overrides';

type QuantumBoardImageProps = {
  frames: string;
  layoutId: number;
  sizeId: number;
  style?: ViewStyle;
  overlayTestID?: string;
  backgroundVariant?: BackgroundVariant;
  onArtReadinessChange?: (readiness: BoardArtReadiness) => void;
  onArtDisplayed?: () => void;
  onArtError?: (error: unknown) => void;
  accessible?: boolean;
  underOverlay?: ReactNode;
  holdColorOverride?: HoldColorOverrides;
};

/** Draw the fixed wall artwork and overlays in the same calibrated canvas. */
export const QuantumBoardImage = React.memo(function QuantumBoardImage({
  layoutId,
  sizeId,
  backgroundVariant = 'full',
  ...props
}: QuantumBoardImageProps) {
  const details = getQuantumGeometryBoardDetails(layoutId, sizeId);
  const appBackgrounded = useIsAppBackgrounded();
  const boardArtVisible = useBoardArtVisible();
  const hidden = appBackgrounded || !boardArtVisible;
  const { onArtReadinessChange } = props;
  useLayoutEffect(() => {
    if (!details) onArtReadinessChange?.('failed');
    else if (hidden) onArtReadinessChange?.('loading');
  }, [details, hidden, onArtReadinessChange]);

  if (!details) return <View style={props.style} />;
  if (hidden) {
    // Match photo boards: release the mounted bitmap while the app or tab is hidden.
    return <View style={[{ width: '100%', aspectRatio: details.boardWidth / details.boardHeight }, props.style]} />;
  }
  const source = getQuantumArtworkSource(details.neutralGrid.model, backgroundVariant);
  return (
    <QuantumImageCanvas
      key={`${layoutId}:${sizeId}:${backgroundVariant}`}
      details={details}
      source={source}
      backgroundVariant={backgroundVariant}
      {...props}
    />
  );
});

type QuantumImageCanvasProps = Omit<QuantumBoardImageProps, 'layoutId' | 'sizeId' | 'backgroundVariant'> & {
  details: QuantumBoardDetails;
  source: number | null;
  backgroundVariant: BackgroundVariant;
};

function QuantumImageCanvas({
  details,
  source,
  backgroundVariant,
  frames,
  style,
  overlayTestID,
  onArtReadinessChange,
  onArtDisplayed,
  onArtError,
  accessible = true,
  underOverlay,
  holdColorOverride,
}: QuantumImageCanvasProps) {
  const { chartColors } = useTheme();
  const accessibilitySummary = useBoardAccessibilitySummary('quantum', frames);
  const { holdsData, neutralHoldsPath } = getQuantumRenderPathData(details);
  // Quantum models do not advertise mirroring. Keeping this false also avoids
  // visually plausible but controller-wrong hold swaps on a crafted route.
  const litHolds = useParseFrames(frames, 'quantum', holdsData, false, holdColorOverride);

  // The canvas is keyed by model and variant so a stale image event from a
  // recycled row cannot reveal the replacement board or mark it ready.
  const [readiness, setReadiness] = useState<BoardArtReadiness>(source === null ? 'failed' : 'loading');
  const currentCanvas = useRef(false);
  useLayoutEffect(() => {
    currentCanvas.current = true;
    return () => {
      currentCanvas.current = false;
    };
  }, []);
  const onDisplay = useCallback(() => {
    if (currentCanvas.current) setReadiness('ready');
  }, []);
  const onError = useCallback(
    (event: ImageErrorEventData) => {
      if (!currentCanvas.current) return;
      setReadiness('failed');
      onArtError?.(event);
    },
    [onArtError],
  );
  useLayoutEffect(() => {
    onArtReadinessChange?.(readiness);
    if (readiness === 'ready') onArtDisplayed?.();
  }, [frames, readiness, onArtReadinessChange, onArtDisplayed]);

  const { boardWidth, boardHeight, neutralGrid } = details;
  const containerStyle: ViewStyle = {
    width: '100%',
    aspectRatio: boardWidth / boardHeight,
    backgroundColor: readiness === 'loading' ? 'transparent' : chartColors.secondaryBackground,
    ...style,
  };

  return (
    <View
      style={containerStyle}
      accessible={accessible}
      accessibilityRole={accessible ? 'image' : undefined}
      accessibilityLabel={accessible ? accessibilitySummary : undefined}
    >
      {source !== null ? (
        <Image
          testID="quantum-board-artwork"
          source={source}
          style={styles.artwork}
          contentFit="contain"
          cachePolicy="memory"
          // Expo web can start the play carousel's mounted neighbours before
          // they're visible. Virtualized thumbnails keep lazy loading.
          loading={backgroundVariant === 'full' ? 'eager' : 'lazy'}
          transition={0}
          accessible={false}
          pointerEvents="none"
          onDisplay={onDisplay}
          onError={onError}
        />
      ) : null}
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${boardWidth} ${boardHeight}`}
        preserveAspectRatio="xMidYMid meet"
        style={styles.baseOverlay}
        pointerEvents="none"
        testID={!underOverlay && litHolds.length > 0 ? overlayTestID : undefined}
      >
        {/* Leave a pending bitmap visible as soon as it paints. The neutral
            diagram is only for artwork that is missing or failed to decode. */}
        {readiness === 'failed' ? (
          <>
            <Rect width={boardWidth} height={boardHeight} fill={chartColors.secondaryBackground} />
            <Path
              testID="quantum-neutral-grid"
              d={getQuantumNeutralGridPath(neutralGrid)}
              stroke={chartColors.separator}
              strokeWidth={2}
            />
            <Path
              testID="quantum-neutral-holds"
              d={neutralHoldsPath}
              fill={chartColors.secondaryLabel}
              fillOpacity={0.34}
            />
          </>
        ) : null}
        {!underOverlay ? <BoardHoldOverlay holds={litHolds} /> : null}
      </Svg>
      {underOverlay ? (
        <View style={styles.underOverlay} pointerEvents="none">
          {underOverlay}
        </View>
      ) : null}
      {underOverlay ? (
        <Svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${boardWidth} ${boardHeight}`}
          preserveAspectRatio="xMidYMid meet"
          style={styles.litOverlay}
          pointerEvents="none"
          testID={litHolds.length > 0 ? overlayTestID : undefined}
        >
          <BoardHoldOverlay holds={litHolds} />
        </Svg>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  artwork: { ...StyleSheet.absoluteFill, zIndex: 0 },
  // Keep the SVG in flow to size the board, and position it so it paints
  // above the absolute bitmap in Expo web as well as on native.
  baseOverlay: { position: 'relative', zIndex: 1 },
  underOverlay: { ...StyleSheet.absoluteFill, zIndex: 2 },
  litOverlay: { ...StyleSheet.absoluteFill, zIndex: 3 },
});
