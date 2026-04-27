'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getImageUrl } from './util';
import type { BoardDetails } from '@/app/lib/types';
import type { HeatmapData, LitUpHoldsMap } from './types';
import { scaleLog } from 'd3-scale';
import useHeatmapData from '../search-drawer/use-heatmap';
import { usePathname } from 'next/navigation';
import { useUISearchParams } from '@/app/components/queue-control/ui-searchparams-provider';
import MuiSelect from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import MuiSwitch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import MuiButton from '@mui/material/Button';
import { track } from '@/app/lib/analytics';
import BoardRenderer from './board-renderer';

const LEGEND_HEIGHT = 96; // Increased from 80
const BLUR_RADIUS = 10; // Increased blur radius
const HEAT_RADIUS_MULTIPLIER = 2; // Increased radius multiplier

// Updated color constants with more yellow/orange for middle values
const HEATMAP_COLORS = [
  '#4caf50', // Light green
  '#8bc34a', // Lime green
  '#cddc39', // Lime
  '#ffeb3b', // Yellow
  '#ffc107', // Amber
  '#ff9800', // Orange
  '#ff7043', // Deep Orange
  '#ff5722', // Darker Orange
  '#f44336', // Light Red
  '#d32f2f', // Deep Red
];

// Helper function to extract angle from pathname
const getAngleFromPath = (pathname: string): number => {
  const path = pathname.split('/');
  const angle = Number(path[path.length - 2]);
  return isNaN(angle) ? 40 : angle; // Default to 40 if not valid
};

type BoardHeatmapProps = {
  boardDetails: BoardDetails;
  litUpHoldsMap?: LitUpHoldsMap;
  onHoldClick?: (holdId: number) => void;
};

// Define the color mode type including user-specific modes
type ColorMode =
  | 'total'
  | 'starting'
  | 'hand'
  | 'foot'
  | 'finish'
  | 'difficulty'
  | 'ascents'
  | 'userAscents'
  | 'userAttempts';

const BoardHeatmap: React.FC<BoardHeatmapProps> = ({ boardDetails, litUpHoldsMap, onHoldClick }) => {
  const pathname = usePathname();
  const { uiSearchParams } = useUISearchParams();

  const [colorMode, setColorMode] = useState<ColorMode>('ascents');
  const [showNumbers, setShowNumbers] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [excludeFootHolds, setExcludeFootHolds] = useState(false);

  // Get angle from pathname - derived directly without needing state
  const angle = useMemo(() => getAngleFromPath(pathname), [pathname]);

  // Only fetch heatmap data when heatmap is enabled
  const { data: heatmapData, loading: heatmapLoading } = useHeatmapData({
    boardName: boardDetails.board_name,
    layoutId: boardDetails.layout_id,
    sizeId: boardDetails.size_id,
    setIds: boardDetails.set_ids.join(','),
    angle,
    filters: uiSearchParams,
    enabled: showHeatmap,
  });

  const [threshold, setThreshold] = useState(1);
  const [animationFrame, setAnimationFrame] = useState(0);
  const { boardWidth, boardHeight, holdsData } = boardDetails;

  const heatmapMap = useMemo(() => new Map(heatmapData?.map((data) => [data.holdId, data]) || []), [heatmapData]);

  // Animated holds map for the mini loading board (radial sweep like clock hands)
  const animatedHoldsMap = useMemo<LitUpHoldsMap>(() => {
    if (!holdsData) return {};

    // Calculate center of board
    const centerX = (boardDetails.edge_left + boardDetails.edge_right) / 2;
    const centerY = (boardDetails.edge_top + boardDetails.edge_bottom) / 2;

    // Current sweep angle (0-360), advances each frame
    const sweepAngle = (animationFrame * 7.2) % 360; // Full rotation over 50 frames
    const sweepWidth = 60; // 60 degree sweep arc

    const holdsMap: LitUpHoldsMap = {};
    const colors = ['#4ECDC4', '#45B7D1', '#96CEB4'];

    for (const hold of holdsData) {
      // Calculate angle from center (in degrees, 0-360)
      let angle = Math.atan2(hold.cy - centerY, hold.cx - centerX) * (180 / Math.PI);
      angle = (angle + 360) % 360; // Normalize to 0-360

      // Check if hold is within the sweep arc
      const diff = Math.abs(angle - sweepAngle);
      const withinSweep = diff < sweepWidth / 2 || diff > 360 - sweepWidth / 2;

      if (withinSweep) {
        // Color based on distance from sweep center for gradient effect
        const normalizedDiff = Math.min(diff, 360 - diff) / (sweepWidth / 2);
        const colorIndex = Math.floor(normalizedDiff * 3);

        holdsMap[hold.id] = {
          state: 'HAND',
          color: colors[colorIndex] || colors[0],
          displayColor: colors[colorIndex] || colors[0],
        };
      }
    }

    return holdsMap;
  }, [holdsData, boardDetails, animationFrame]);

  // Animation frame update for hold movement when loading
  useEffect(() => {
    if (!heatmapLoading) return;

    const animationInterval = setInterval(() => {
      setAnimationFrame((prev) => (prev + 1) % 100);
    }, 80); // Faster rotation

    return () => clearInterval(animationInterval);
  }, [heatmapLoading]);

  // Helper to check if a hold is exclusively used as a foot hold
  const isFootOnlyHold = useCallback((data: HeatmapData | undefined): boolean => {
    if (!data) return false;
    return data.footUses > 0 && data.handUses === 0 && data.startingUses === 0 && data.finishUses === 0;
  }, []);

  // Updated getValue function to handle user-specific data
  const getValue = useCallback(
    (data: HeatmapData | undefined): number => {
      if (!data) return 0;
      switch (colorMode) {
        case 'starting':
          return data.startingUses;
        case 'hand':
          return data.handUses;
        case 'foot':
          return data.footUses;
        case 'finish':
          return data.finishUses;
        case 'difficulty':
          return data.averageDifficulty || 0;
        case 'ascents':
          return data.totalAscents || 0;
        case 'userAscents':
          return data.userAscents || 0;
        case 'userAttempts':
          return data.userAttempts || 0;
        default:
          return data.totalUses;
      }
    },
    [colorMode],
  );

  // Pre-filter and memoize holds that need rendering to avoid repeated filtering
  const holdsToRender = useMemo(() => {
    return holdsData
      .map((hold) => {
        const data = heatmapMap.get(hold.id);
        const value = getValue(data);
        return { hold, data, value };
      })
      .filter(({ value, data }) => {
        if (!value || value < threshold) return false;
        if (excludeFootHolds && isFootOnlyHold(data)) return false;
        return true;
      });
  }, [holdsData, heatmapMap, getValue, threshold, excludeFootHolds, isFootOnlyHold]);

  // Create scales for better distribution of colors
  const { colorScale, opacityScale } = useMemo(() => {
    const values = holdsToRender
      .map(({ value }) => value)
      .filter((val) => val > 0)
      .sort((a, b) => a - b);

    if (values.length === 0) {
      return {
        colorScale: () => 'transparent',
        opacityScale: () => 0,
      };
    }

    const min = Math.max(1, values[0]);
    const max = values[values.length - 1];

    // Use log scale for better distribution of values
    const logScale = scaleLog()
      .domain([min, max])
      .range([0, HEATMAP_COLORS.length - 1])
      .clamp(true);

    const getColorScale = () => {
      return (value: number) => {
        if (!value || value < threshold) return 'transparent';
        const index = Math.floor(logScale(value));
        return HEATMAP_COLORS[index];
      };
    };

    const getOpacityScale = () => {
      return (value: number) => {
        if (!value || value < threshold) return 0;
        return Math.max(0.3, Math.min(0.8, logScale(value) / HEATMAP_COLORS.length));
      };
    };

    return {
      colorScale: getColorScale(),
      opacityScale: getOpacityScale(),
    };
  }, [holdsToRender, threshold]);

  const ColorLegend = () => {
    const gradientId = 'heatmap-gradient';
    const legendWidth = boardWidth * 0.8; // Make legend 80% of board width
    const legendHeight = 36; // Increased from 30
    const x = (boardWidth - legendWidth) / 2;
    const y = boardHeight + 24; // Increased spacing

    // Get the min, max, and middle values from the heatmap data
    const values = heatmapData
      .map((data) => getValue(data))
      .filter((val) => val > 0)
      .sort((a, b) => a - b);

    const minValue = values[0] || 0;
    const maxValue = values[values.length - 1] || 0;
    const midValue = values[Math.floor(values.length / 2)] || 0;

    return (
      <g transform={`translate(${x}, ${y})`}>
        <defs>
          <linearGradient id={gradientId}>
            {HEATMAP_COLORS.map((color, index) => (
              <stop key={color} offset={`${(index / (HEATMAP_COLORS.length - 1)) * 100}%`} stopColor={color} />
            ))}
          </linearGradient>
        </defs>
        <rect width={legendWidth} height={legendHeight} fill={`url(#${gradientId})`} rx={8} />
        <text x="0" y="-10" fontSize="28" textAnchor="start" fontWeight="500">
          Low ({minValue})
        </text>
        <text x={legendWidth / 2} y="-10" fontSize="28" textAnchor="middle" fontWeight="500">
          Mid ({midValue})
        </text>
        <text x={legendWidth} y="-10" fontSize="28" textAnchor="end" fontWeight="500">
          High ({maxValue})
        </text>
      </g>
    );
  };

  // Updated color mode options to include user-specific options
  const colorModeOptions = [
    { value: 'ascents', label: 'Ascents' },
    { value: 'total', label: 'Total Problems' },
    { value: 'starting', label: 'Starting Holds' },
    { value: 'hand', label: 'Hand Holds' },
    { value: 'foot', label: 'Foot Holds' },
    { value: 'finish', label: 'Finish Holds' },
    { value: 'difficulty', label: 'Difficulty' },
    // Always include user options since auth is handled server-side
    { value: 'userAscents', label: 'Your Ascents' },
    { value: 'userAttempts', label: 'Your Attempts' },
  ];

  const thresholdOptions = [
    { value: 1, label: 'All' },
    { value: 2, label: 'Min 2' },
    { value: 5, label: 'Min 5' },
    { value: 10, label: 'Min 10' },
  ];

  return (
    <div className="w-full">
      <div className="relative">
        {/* Loading overlay with mini animated board */}
        {showHeatmap && heatmapLoading && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 10,
              background: 'rgba(0, 0, 0, 0.85)',
              borderRadius: '12px',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <div style={{ width: '120px', height: '120px' }}>
              <BoardRenderer litUpHoldsMap={animatedHoldsMap} mirrored={false} boardDetails={boardDetails} thumbnail />
            </div>
            <span style={{ fontSize: '14px', color: 'var(--semantic-surface)', fontWeight: 500 }}>
              Loading heatmap...
            </span>
          </div>
        )}
        <svg
          viewBox={`0 0 ${boardWidth} ${boardHeight + LEGEND_HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
          className="w-full h-auto max-h-[55vh]"
        >
          <defs>
            <filter id="blur">
              <feGaussianBlur stdDeviation={BLUR_RADIUS} />
            </filter>
          </defs>

          <g>
            {/* Board background images */}
            {Object.keys(boardDetails.images_to_holds).map((imageUrl) => (
              <image
                key={imageUrl}
                href={getImageUrl(imageUrl, boardDetails.board_name)}
                width="100%"
                height={boardHeight}
              />
            ))}

            {/* Heat overlay with blur effect */}
            {showHeatmap && !heatmapLoading && (
              <>
                {/* Blurred background layer */}
                <g filter="url(#blur)">
                  {holdsToRender.map(({ hold, value }) => (
                    <circle
                      key={`heat-blur-${hold.id}`}
                      cx={hold.cx}
                      cy={hold.cy}
                      r={hold.r * HEAT_RADIUS_MULTIPLIER}
                      fill={colorScale(value)}
                      opacity={opacityScale(value) * 0.5}
                    />
                  ))}
                </g>
                <filter id="blurMe">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="20" />
                </filter>

                {/* Sharp circles with numbers */}
                {holdsToRender.map(({ hold, value }) => (
                  <g key={`heat-sharp-${hold.id}`}>
                    <circle
                      cx={hold.cx}
                      cy={hold.cy}
                      r={hold.r}
                      fill={colorScale(value)}
                      opacity={opacityScale(value)}
                      filter="url(#blurMe)"
                    />
                    {showNumbers && (
                      <text
                        x={hold.cx}
                        y={hold.cy}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={Math.max(8, hold.r * 0.6)}
                        fontWeight="bold"
                        fill="#000"
                        style={{ userSelect: 'none' }}
                      >
                        {value}
                      </text>
                    )}
                  </g>
                ))}
              </>
            )}

            {/* Interaction layer - only render when click handler exists */}
            {onHoldClick &&
              holdsData.map((hold) => (
                <circle
                  key={`click-${hold.id}`}
                  cx={hold.cx}
                  cy={hold.cy}
                  r={hold.r}
                  fill="transparent"
                  className="cursor-pointer"
                  onClick={() => {
                    onHoldClick(hold.id);
                    track('Heatmap Hold Clicked', {
                      hold_id: hold.id,
                      boardLayout: `${boardDetails.layout_name}`,
                    });
                  }}
                />
              ))}

            {/* Selected holds overlay */}
            {holdsData.map((hold) => {
              const litUpHold = litUpHoldsMap?.[hold.id];
              if (!litUpHold) return null;
              return (
                <circle
                  key={`selected-${hold.id}`}
                  cx={hold.cx}
                  cy={hold.cy}
                  r={hold.r}
                  stroke={litUpHold.color}
                  strokeWidth="4"
                  fill="none"
                  className="transition-colors duration-200"
                />
              );
            })}

            {showHeatmap && !heatmapLoading && <ColorLegend />}
          </g>
        </svg>
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px',
          alignItems: 'center',
          marginTop: '8px',
        }}
      >
        <MuiButton
          variant={showHeatmap ? 'contained' : 'outlined'}
          size="small"
          onClick={() => {
            setShowHeatmap(!showHeatmap);
            track(`Heatmap ${showHeatmap ? 'Shown' : 'Hidden'}`, {
              boardLayout: boardDetails.layout_name || '',
            });
          }}
        >
          {showHeatmap ? 'Hide Heatmap' : 'Show Heatmap'}
        </MuiButton>

        {showHeatmap && (
          <>
            <MuiSelect
              value={colorMode}
              onChange={(e) => {
                const value = e.target.value as ColorMode;
                setColorMode(value);
                track('Heatmap Mode Changed', {
                  mode: value,
                  board: boardDetails.layout_name || '',
                });
              }}
              size="small"
              sx={{ width: 130 }}
            >
              {colorModeOptions.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  {opt.label}
                </MenuItem>
              ))}
            </MuiSelect>
            <MuiSelect
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              size="small"
              sx={{ width: 100 }}
            >
              {thresholdOptions.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  {opt.label}
                </MenuItem>
              ))}
            </MuiSelect>
            <FormControlLabel
              control={
                <MuiSwitch checked={showNumbers} onChange={(_, checked) => setShowNumbers(checked)} size="small" />
              }
              label="#"
            />
            <FormControlLabel
              control={
                <MuiSwitch
                  checked={excludeFootHolds}
                  onChange={(_, checked) => {
                    setExcludeFootHolds(checked);
                    track('Heatmap Foot Holds Toggle', {
                      excluded: checked,
                      board: boardDetails.layout_name || '',
                    });
                  }}
                  size="small"
                />
              }
              label={excludeFootHolds ? 'No Feet' : 'Feet'}
            />
          </>
        )}
      </div>
    </div>
  );
};

export default BoardHeatmap;
