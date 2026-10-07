import React from 'react';
import Box from '@mui/material/Box';
import { themeTokens } from '@/app/theme/theme-config';
import type { SprayOverlayKind, SprayOverlayMark } from '@/app/lib/admin/spray-training-overlay';

type KindStyle = { stroke: string; strokeWidth: number; dashed: boolean };

/**
 * One look per kind. Stroke widths are in PHOTO pixels (the SVG's viewBox), so
 * `vectorEffect="non-scaling-stroke"` keeps them readable at any display size.
 */
export const SPRAY_OVERLAY_STYLES: Record<SprayOverlayKind, KindStyle> = {
  manual: { stroke: themeTokens.colors.primary, strokeWidth: 2, dashed: false },
  auto: { stroke: themeTokens.neutral[700], strokeWidth: 2, dashed: false },
  accepted: { stroke: themeTokens.colors.warning, strokeWidth: 2, dashed: false },
  confirmed: { stroke: themeTokens.colors.success, strokeWidth: 4, dashed: false },
  edited: { stroke: themeTokens.colors.accent, strokeWidth: 2, dashed: false },
  deleted: { stroke: themeTokens.colors.error, strokeWidth: 2, dashed: true },
  notShown: { stroke: themeTokens.neutral[500], strokeWidth: 2, dashed: true },
};

const DASH_PATTERN = '6 4';

type SprayHoldOverlayProps = {
  marks: readonly SprayOverlayMark[];
  photoWidth: number;
  photoHeight: number;
  /** Kinds to leave out. */
  hiddenKinds: ReadonlySet<SprayOverlayKind>;
};

/**
 * Pure SVG layered over the wall photo. Its viewBox is the photo's pixel box
 * and the parent sizes both to the same aspect ratio, so a mark at (cx, cy)
 * lands on the same pixel of the picture at any size.
 */
export default function SprayHoldOverlay({ marks, photoWidth, photoHeight, hiddenKinds }: SprayHoldOverlayProps) {
  return (
    <Box
      component="svg"
      viewBox={`0 0 ${photoWidth} ${photoHeight}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      data-testid="spray-hold-overlay"
      sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    >
      {marks
        .filter((mark) => !hiddenKinds.has(mark.kind))
        .map((mark) => {
          const look = SPRAY_OVERLAY_STYLES[mark.kind];
          const shared = {
            fill: 'none',
            stroke: look.stroke,
            strokeWidth: look.strokeWidth,
            strokeDasharray: look.dashed ? DASH_PATTERN : undefined,
            vectorEffect: 'non-scaling-stroke' as const,
            'data-kind': mark.kind,
          };
          return mark.shape.geometry === 'polygon' ? (
            <polygon key={mark.key} points={mark.shape.points} {...shared} />
          ) : (
            <circle key={mark.key} cx={mark.shape.cx} cy={mark.shape.cy} r={mark.shape.r} {...shared} />
          );
        })}
    </Box>
  );
}
