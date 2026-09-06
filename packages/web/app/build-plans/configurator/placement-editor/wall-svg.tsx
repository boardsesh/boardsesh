'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@mui/material/styles';
import styles from '../../build-plans.module.css';
import type { CncLayoutWall } from '../layout-model';
import {
  PLACEMENT_GRID_MM,
  clientToWallMm,
  rotatedRectCorners,
  type HoleMm,
  type LabelMetrics,
  type PanelRectMm,
  type PlacementCollisions,
  type PointMm,
  type ResizeHandle,
  type SeamLineMm,
} from './geometry';
import type { PlacementValue } from './placement-reducer';

/**
 * The wall, drawn at one SVG user unit per millimetre.
 *
 * Millimetres all the way down is the whole trick: the `viewBox` is the wall's
 * real size, so panels, holes and the label are drawn with the numbers the
 * generator sent, and the browser handles fitting that into whatever width the
 * card has. There is no pixel-per-mm scale to keep in sync, no ResizeObserver,
 * and a phone and a laptop draw the same picture at different sizes.
 *
 * Wall space measures y upward and SVG measures it down, so everything except
 * the label sits inside one flipped group. The label is drawn outside it,
 * because a mirrored group mirrors the letters too — and would mirror an
 * uploaded logo just as happily.
 *
 * A typed label and an uploaded one are the same rectangle with different
 * contents: an item carrying an `imageUrl` draws the buyer's own drawing where
 * the letters would go, and the outline, the handles, the drag and the keyboard
 * do not know the difference.
 */

/** A panel plus the one thing the geometry does not care about: whether it is a kicker. */
export type WallPanelShape = PanelRectMm & { role: string | null };

export type WallSvgProps = {
  wall: CncLayoutWall;
  panels: readonly WallPanelShape[];
  seams: readonly SeamLineMm[];
  /** Only the selected panel's holes; the rest are not reachable and only add noise. */
  holes: readonly HoleMm[];
  placement: PlacementValue;
  /** The label's drawn width over its drawn height. */
  metrics: LabelMetrics;
  text: string;
  /**
   * The buyer's uploaded drawing, when this item is one. Null for a text label.
   *
   * An object URL that only lives as long as the tab, so it can be null for an
   * upload too — a restored draft points at bytes in the bucket that the
   * browser has never seen. That item keeps its outline and its handles and
   * stays draggable; there is simply nothing to draw inside it.
   */
  imageUrl: string | null;
  /**
   * True when this item routes an upload, whether or not its preview survived.
   *
   * Separate from `imageUrl` because the two disagree for exactly the case that
   * matters: a restored upload has no URL to draw but must not be measured like
   * a label either, or the words standing in for it would set the shape the
   * collision check runs against.
   */
  isImage: boolean;
  collisions: PlacementCollisions;
  ariaLabel: string;
  onPointerDownArt: (
    kind: 'move' | 'resize' | 'rotate',
    handle: ResizeHandle | undefined,
    pointerId: number,
    pointerMm: PointMm,
  ) => void;
  onPointerMoveArt: (pointerId: number, pointerMm: PointMm, snap: boolean) => void;
  onPointerUpArt: (pointerId: number) => void;
  onNudge: (dxMm: number, dyMm: number) => void;
  onRotateBy: (degrees: number) => void;
  onWidthBy: (deltaMm: number) => void;
  /** Fired once the browser has measured the label for real. */
  onMetrics: (metrics: LabelMetrics) => void;
};

/** Breathing room around the wall so a label near an edge is not clipped by the frame. */
const VIEWBOX_PADDING_MM = 120;

/** Keyboard steps, from the plan: an arrow moves a grid step, shift moves a millimetre. */
const FINE_NUDGE_MM = 1;
const ROTATE_STEP_DEG = 5;
const WIDTH_STEP_MM = 10;

/** Font size the hidden measuring text is drawn at. Anything works; this keeps the maths obvious. */
const MEASURE_FONT_SIZE = 100;

/**
 * The font the generator cuts a label with. `getBBox` measures whatever font
 * actually resolves in the browser rendering this element, and a system-default
 * sans varies by OS and browser — a shape that never matches Liberation Sans
 * throws the measured width and aspect off by enough to nudge a placement that
 * reads "clear" here into a collision once the backend actually cuts it.
 * Liberation Sans is metric-compatible with Arial, so pinning both the drawn
 * label and the hidden measuring text to the same stack keeps the measurement
 * close to the real outline. Must match the drawn `<text>` below exactly, or
 * the two would measure two different shapes.
 */
const LABEL_FONT_FAMILY = "'Liberation Sans', Arial, Helvetica, sans-serif";

const RESIZE_HANDLES: readonly ResizeHandle[] = ['bottomLeft', 'bottomRight', 'topRight', 'topLeft'];

/** How far above the label the rotate handle floats, as a fraction of the label's height. */
const ROTATE_HANDLE_GAP = 0.9;

/**
 * Keep the drag/resize/rotate handles a usable size across the catalogue's
 * whole width range. A fixed fraction of the WALL (the old `wall.widthMm / 70`)
 * draws a handle the size of a dinner plate on a small logo and swamps it, so
 * this scales with the ITEM instead, clamped so neither a tiny nor a huge item
 * gets a silly-sized handle.
 */
const HANDLE_RADIUS_MIN_MM = 6;
const HANDLE_RADIUS_MAX_MM = 30;
const HANDLE_RADIUS_WIDTH_DIVISOR = 8;

/** Corner-to-cursor mapping: the diagonal a corner actually sits on. */
function resizeHandleClassName(handle: ResizeHandle): string {
  return handle === 'topLeft' || handle === 'bottomRight' ? styles.wallHandleNwse : styles.wallHandleNesw;
}

export default function WallSvg({
  wall,
  panels,
  seams,
  holes,
  placement,
  metrics,
  text,
  imageUrl,
  isImage,
  collisions,
  ariaLabel,
  onPointerDownArt,
  onPointerMoveArt,
  onPointerUpArt,
  onNudge,
  onRotateBy,
  onWidthBy,
  onMetrics,
}: WallSvgProps) {
  const { t } = useTranslation('cnc');
  const theme = useTheme();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const measureRef = useRef<SVGTextElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  // The one pointer a gesture captured. `isDragging` alone is not enough: an
  // unrelated pointer lifting (a second finger, or a stray pointerup bubbling
  // through) must not end a gesture it never started, or a two-finger touch
  // would drop a drag mid-move the instant the other finger lifts.
  const activePointerIdRef = useRef<number | null>(null);

  const viewBox = {
    minXMm: -VIEWBOX_PADDING_MM,
    minYMm: -(wall.heightMm + VIEWBOX_PADDING_MM),
    widthMm: wall.widthMm + 2 * VIEWBOX_PADDING_MM,
    heightMm: wall.heightMm + wall.kickerHeightMm + 2 * VIEWBOX_PADDING_MM,
  };

  // Measure the label for real once it is on screen. `getBBox` does not exist
  // on the server or in jsdom, so the estimate stands wherever it is missing
  // rather than the component refusing to render.
  useEffect(() => {
    if (isImage) return;
    const node = measureRef.current;
    if (!node || typeof node.getBBox !== 'function') return;
    const box = node.getBBox();
    if (box.width <= 0 || box.height <= 0) return;
    onMetrics({ aspect: box.width / box.height, fontSizePerHeightMm: MEASURE_FONT_SIZE / box.height });
  }, [text, isImage, onMetrics]);

  // The same measurement for an upload, taken off the decoded image rather than
  // off a glyph box. An `Image()` off-screen rather than the drawn `<image>`'s
  // own `onLoad`: SVG image elements do not report a natural size, and the
  // constructor is missing on the server and in some test environments, so a
  // guard keeps the square fallback standing wherever it cannot run.
  useEffect(() => {
    if (!imageUrl || typeof window === 'undefined' || typeof window.Image !== 'function') return;
    const probe = new window.Image();
    let isCurrent = true;
    probe.onload = () => {
      const { naturalWidth, naturalHeight } = probe;
      if (!isCurrent || naturalWidth <= 0 || naturalHeight <= 0) return;
      onMetrics({ aspect: naturalWidth / naturalHeight, fontSizePerHeightMm: 0 });
    };
    probe.src = imageUrl;
    return () => {
      isCurrent = false;
      probe.onload = null;
    };
  }, [imageUrl, onMetrics]);

  // The viewBox changes with the wall, and a converter that changed with it
  // would hand every pointer handler a new identity on each layout response. A
  // ref keeps one stable function without letting it go stale.
  const viewBoxRef = useRef(viewBox);
  viewBoxRef.current = viewBox;

  const toWallMm = useCallback((clientX: number, clientY: number): PointMm => {
    const bounds = svgRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 };
    return clientToWallMm(bounds, viewBoxRef.current, clientX, clientY);
  }, []);

  const heightMm = metrics.aspect > 0 ? placement.widthMm / metrics.aspect : placement.widthMm;
  const fontSize = heightMm * metrics.fontSizePerHeightMm;
  const handleRadiusMm = Math.min(
    Math.max(placement.widthMm / HANDLE_RADIUS_WIDTH_DIVISOR, HANDLE_RADIUS_MIN_MM),
    HANDLE_RADIUS_MAX_MM,
  );
  const hasCollision = collisions.offPanel || collisions.holes.length > 0 || collisions.seams.length > 0;
  const artColour = hasCollision ? theme.palette.error.main : theme.palette.primary.main;
  const collidingHoles = new Set(collisions.holes);

  // Corner handles are placed in wall space and then flipped like the label, so
  // they follow a rotated item without a second rotation transform.
  const corners = rotatedRectCorners(
    { xMm: placement.xMm, yMm: placement.yMm },
    placement.widthMm,
    heightMm,
    placement.rotationDeg,
  );
  const rotateAnchor = rotatedRectCorners(
    { xMm: placement.xMm, yMm: placement.yMm },
    0,
    heightMm * (1 + ROTATE_HANDLE_GAP) * 2,
    placement.rotationDeg,
  )[2];

  const startGesture = (
    event: React.PointerEvent,
    kind: 'move' | 'resize' | 'rotate',
    handle: ResizeHandle | undefined,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const node = svgRef.current;
    // Capture on the root, not on the handle: a fast drag leaves a small circle
    // behind within a frame, and without capture the gesture would die there.
    // Guarded because pointer capture is missing in jsdom, and a gesture that
    // only works where the API exists is a gesture nobody can test.
    if (node && typeof node.setPointerCapture === 'function') node.setPointerCapture(event.pointerId);
    activePointerIdRef.current = event.pointerId;
    setIsDragging(true);
    onPointerDownArt(kind, handle, event.pointerId, toWallMm(event.clientX, event.clientY));
  };

  /** True only for the pointer a gesture actually captured. */
  const endGesture = (pointerId: number) => {
    if (pointerId !== activePointerIdRef.current) return;
    activePointerIdRef.current = null;
    setIsDragging(false);
    onPointerUpArt(pointerId);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? FINE_NUDGE_MM : PLACEMENT_GRID_MM;
    switch (event.key) {
      case 'ArrowLeft':
        onNudge(-step, 0);
        break;
      case 'ArrowRight':
        onNudge(step, 0);
        break;
      case 'ArrowUp':
        onNudge(0, step);
        break;
      case 'ArrowDown':
        onNudge(0, -step);
        break;
      case '[':
        onRotateBy(-ROTATE_STEP_DEG);
        break;
      case ']':
        onRotateBy(ROTATE_STEP_DEG);
        break;
      case '+':
      case '=':
        onWidthBy(WIDTH_STEP_MM);
        break;
      case '-':
      case '_':
        onWidthBy(-WIDTH_STEP_MM);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <svg
      ref={svgRef}
      className={styles.wallCanvas}
      viewBox={`${String(viewBox.minXMm)} ${String(viewBox.minYMm)} ${String(viewBox.widthMm)} ${String(viewBox.heightMm)}`}
      role="application"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerMove={(event) => {
        if (!isDragging) return;
        onPointerMoveArt(event.pointerId, toWallMm(event.clientX, event.clientY), event.shiftKey);
      }}
      onPointerUp={(event) => endGesture(event.pointerId)}
      onPointerCancel={(event) => endGesture(event.pointerId)}
    >
      {/* Everything measured from the wall, drawn upside down once. */}
      <g transform="scale(1 -1)">
        {panels.map((panel) => (
          <rect
            key={panel.index}
            x={panel.xMm}
            y={panel.yMm}
            width={panel.widthMm}
            height={panel.heightMm}
            fill={panel.index === placement.panelIndex ? theme.palette.action.selected : theme.palette.action.hover}
            stroke={panel.role === 'kicker' ? theme.palette.text.secondary : theme.palette.divider}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {seams.map((seam, index) => (
          <line
            key={`${seam.kind}-${String(seam.valueMm)}-${String(index)}`}
            x1={seam.kind === 'vertical' ? seam.valueMm : seam.extent[0]}
            y1={seam.kind === 'vertical' ? seam.extent[0] : seam.valueMm}
            x2={seam.kind === 'vertical' ? seam.valueMm : seam.extent[1]}
            y2={seam.kind === 'vertical' ? seam.extent[1] : seam.valueMm}
            stroke={collisions.seams.includes(index) ? theme.palette.error.main : theme.palette.text.secondary}
            strokeWidth={collisions.seams.includes(index) ? 3 : 1}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {holes.map((hole) => (
          <circle
            key={hole.id}
            data-testid="cnc-hole"
            cx={hole.xMm}
            cy={hole.yMm}
            r={hole.keepoutRadiusMm}
            fill={collidingHoles.has(hole.id) ? theme.palette.error.main : theme.palette.action.disabledBackground}
            fillOpacity={collidingHoles.has(hole.id) ? 0.55 : 0.35}
          />
        ))}
      </g>

      {/* The label, drawn the right way up: SVG's y flip would mirror the glyphs. */}
      <g
        data-testid="cnc-art"
        transform={`translate(${String(placement.xMm)} ${String(-placement.yMm)}) rotate(${String(-placement.rotationDeg)})`}
        onPointerDown={(event) => startGesture(event, 'move', undefined)}
        className={styles.wallDragTarget}
      >
        <rect
          x={-placement.widthMm / 2}
          y={-heightMm / 2}
          width={placement.widthMm}
          height={heightMm}
          fill="transparent"
          stroke={artColour}
          strokeDasharray="6 6"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {imageUrl ? (
          // `meet` rather than a stretch: the rectangle is already the measured
          // ratio, and on the frame before the measurement lands the drawing
          // should letterbox inside a square instead of being squashed into it.
          <image
            data-testid="cnc-art-image"
            href={imageUrl}
            x={-placement.widthMm / 2}
            y={-heightMm / 2}
            width={placement.widthMm}
            height={heightMm}
            preserveAspectRatio="xMidYMid meet"
          >
            <title>{t('configurator.artwork.upload.previewAlt')}</title>
          </image>
        ) : (
          <text
            x={0}
            y={0}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={fontSize}
            fontFamily={LABEL_FONT_FAMILY}
            fill={artColour}
          >
            {text}
          </text>
        )}
      </g>

      {RESIZE_HANDLES.map((handle, index) => (
        <circle
          key={handle}
          data-testid={`cnc-handle-${handle}`}
          cx={corners[index].xMm}
          cy={-corners[index].yMm}
          r={handleRadiusMm}
          fill={theme.palette.background.paper}
          stroke={artColour}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          onPointerDown={(event) => startGesture(event, 'resize', handle)}
          className={resizeHandleClassName(handle)}
        >
          <title>{t('configurator.artwork.editor.resizeHandle')}</title>
        </circle>
      ))}

      <circle
        data-testid="cnc-handle-rotate"
        cx={rotateAnchor.xMm}
        cy={-rotateAnchor.yMm}
        r={handleRadiusMm}
        fill={artColour}
        onPointerDown={(event) => startGesture(event, 'rotate', undefined)}
        className={styles.wallRotateHandle}
      >
        <title>{t('configurator.artwork.editor.rotateHandle')}</title>
      </circle>

      {/* Measured, never seen: the label at a known font size, so the drawn one
          can be scaled to the millimetre width the buyer asked for. An upload
          has no glyphs to measure and gets its ratio from the image instead. */}
      {!isImage && (
        <text
          ref={measureRef}
          x={0}
          y={0}
          fontSize={MEASURE_FONT_SIZE}
          fontFamily={LABEL_FONT_FAMILY}
          visibility="hidden"
          aria-hidden="true"
        >
          {text}
        </text>
      )}
    </svg>
  );
}
