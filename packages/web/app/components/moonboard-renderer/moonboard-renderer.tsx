'use client';

import React, { useMemo } from 'react';
import { getGridPosition, getMoonBoardGeometryByFolder, MOONBOARD_HOLD_STATES } from '@/app/lib/moonboard-config';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import type { MoonBoardRendererProps } from './types';

const MoonBoardRenderer: React.FC<MoonBoardRendererProps> = ({
  layoutFolder,
  holdSetImages,
  litUpHoldsMap = {},
  mirrored = false,
  thumbnail = false,
  fillHeight = false,
  onHoldClick,
}) => {
  // Geometry differs between the standard 11×18 board (650×1000) and the Mini
  // boards (650×694, rows 1–12). Derived from the layout's board-art folder.
  const geometry = useMemo(() => getMoonBoardGeometryByFolder(layoutFolder), [layoutFolder]);
  const { width, height } = geometry;

  // Calculate hold circle radius based on grid cell size
  const cellWidth = width / geometry.numColumns;
  const cellHeight = height / geometry.numRows;
  const holdRadius = Math.min(cellWidth, cellHeight) * 0.35;

  // Background image for this layout (.webp; thumbs/ variant in thumbnail mode).
  const backgroundHref = useMemo(() => {
    const webp = geometry.backgroundImage.replace(/\.png$/, '.webp');
    return resolveStaticAssetUrl(thumbnail ? `/images/moonboard/thumbs/${webp}` : `/images/moonboard/${webp}`);
  }, [geometry, thumbnail]);

  // Generate all grid positions for the layout (198 standard, 132 Mini).
  const gridHolds = React.useMemo(() => {
    const holds = [];
    for (let row = 1; row <= geometry.rowTop; row++) {
      for (let colIdx = 0; colIdx < geometry.numColumns; colIdx++) {
        const holdId = (row - 1) * geometry.numColumns + colIdx + 1;
        const pos = getGridPosition(holdId, geometry);

        holds.push({
          id: holdId,
          cx: pos.x * width,
          cy: pos.y * height,
        });
      }
    }
    return holds;
  }, [geometry]);

  const getHoldColor = (holdId: number): string => {
    const hold = litUpHoldsMap[holdId];
    if (!hold) return 'transparent';

    // Use displayColor from the hold if available, otherwise map state to Moonboard colors
    if (hold.displayColor) return hold.displayColor;

    switch (hold.state) {
      case 'STARTING':
        return MOONBOARD_HOLD_STATES.start.displayColor;
      case 'HAND':
        return MOONBOARD_HOLD_STATES.hand.displayColor;
      case 'FINISH':
        return MOONBOARD_HOLD_STATES.finish.displayColor;
      default:
        return 'transparent';
    }
  };

  // Memoize SVG style object to prevent recreation on every render.
  // fillHeight: SVG fills container height; preserveAspectRatio="xMidYMid meet" letterboxes the
  // image so the full board is always visible regardless of container aspect.
  const svgStyle = useMemo(
    () =>
      fillHeight
        ? {
            width: '100%',
            height: '100%',
            display: 'block' as const,
            transform: mirrored ? 'scaleX(-1)' : undefined,
          }
        : {
            width: '100%',
            height: 'auto',
            display: 'block' as const,
            maxHeight: thumbnail ? '10vh' : '55vh',
            transform: mirrored ? 'scaleX(-1)' : undefined,
          },
    [thumbnail, mirrored, fillHeight],
  );

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" style={svgStyle}>
      {/* Render MoonBoard background first. The Fetch Priority API does not
          apply to inline SVG images; LCP-critical cards should be preloaded
          via `<link rel="preload">` from the page-level server component. */}
      <image href={backgroundHref} width="100%" height="100%" />

      {/* Render hold set images as overlay layers */}
      {holdSetImages.map((imageFile) => (
        <image
          key={imageFile}
          href={resolveStaticAssetUrl(
            `/images/moonboard/${layoutFolder}/${thumbnail ? 'thumbs/' : ''}${imageFile.replace(/\.png$/, '.webp')}`,
          )}
          width="100%"
          height="100%"
        />
      ))}

      {/* Render hold circles - skip transparent ones when they serve no purpose */}
      {gridHolds.map((hold) => {
        const color = getHoldColor(hold.id);
        const isLitUp = color !== 'transparent';

        // Skip transparent circles in thumbnail mode or when there's no click handler
        if (!isLitUp && (thumbnail || !onHoldClick)) return null;

        return (
          <circle
            key={hold.id}
            id={`hold-${hold.id}`}
            cx={hold.cx}
            cy={hold.cy}
            r={holdRadius}
            stroke={color}
            strokeWidth={thumbnail ? 8 : 6}
            fillOpacity={thumbnail && isLitUp ? 1 : 0}
            fill={thumbnail && isLitUp ? color : 'transparent'}
            style={{ cursor: onHoldClick ? 'pointer' : 'default' }}
            onClick={onHoldClick ? (event) => onHoldClick(hold.id, event.currentTarget) : undefined}
          />
        );
      })}
    </svg>
  );
};

export default MoonBoardRenderer;
