'use client';

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { CncArtworkRules } from '@boardsesh/shared-schema';
import styles from '../../build-plans.module.css';
import type { CncArtworkDraft } from '../configurator-state';
import type { CncLayoutKeepout, CncLayoutWall } from '../layout-model';
import type { CncLayoutPanel } from '../layout-summary';
import {
  SQUARE_ART_METRICS,
  estimateLabelMetrics,
  type HoleMm,
  type LabelMetrics,
  type PanelRectMm,
  type SeamLineMm,
} from './geometry';
import {
  initialPlacementState,
  placementReducer,
  type PlacementContext,
  type PlacementValue,
} from './placement-reducer';
import WallSvg, { type WallPanelShape } from './wall-svg';

/**
 * Put the label on the wall by dragging it there.
 *
 * This replaces three number fields. Nobody knows where 1740 mm across and
 * 820 mm up is on their own wall, but everybody can see that a label is sitting
 * on a T-nut — so the picture is the interface and the two fields beside it
 * (width, rotation) are for the times a number really is what you want.
 *
 * The editor owns the placement while it is open: the reducer is the source of
 * truth and every settled placement is pushed up through `onChange`. The
 * generator still has the last word at checkout, and its verdict is what gates
 * Buy; what happens here is the fast local answer that keeps somebody from
 * discovering a collision after they have paid.
 */

/** How different a measurement has to be before it is worth re-rendering for. */
const METRICS_EPSILON = 0.005;

export type PlacementEditorProps = {
  item: CncArtworkDraft;
  panels: readonly CncLayoutPanel[];
  panelRects: readonly PanelRectMm[];
  /** Every hole on the wall; the editor shows the selected panel's. Empty when signed out. */
  holes: readonly HoleMm[];
  /** The panel each hole belongs to, aligned with `holes`. */
  holePanelIndex: readonly number[];
  seams: readonly SeamLineMm[];
  keepout: CncLayoutKeepout;
  wall: CncLayoutWall | null;
  rules: CncArtworkRules;
  /**
   * The buyer's uploaded drawing, ready to draw on the wall. Null for a label,
   * and null for an upload whose object URL did not survive a reload.
   *
   * Handed down rather than fetched here: the URL is made from the buyer's own
   * File in the artwork step, which is the only place that still holds it.
   */
  previewUrl: string | null;
  onChange: (patch: Partial<Omit<CncArtworkDraft, 'id'>>) => void;
  /** Told whenever the local check flips, so Buy can stay shut while a label sits on a hole. */
  onLocalCollisions: (hasCollisions: boolean) => void;
};

function panelLabel(panel: CncLayoutPanel, kickerLabel: string): string {
  const name = panel.id ?? String(panel.index + 1);
  return panel.role === 'kicker' ? `${name} · ${kickerLabel}` : name;
}

/**
 * Read a number out of a field, refusing anything that is not one.
 *
 * A NaN millimetre survives JSON, reaches the generator's geometry and poisons
 * it; refusing it here is far easier than explaining it there. An empty field is
 * left alone for the same reason — somebody clearing a value to retype it has
 * not asked for a width of zero.
 */
function readNumberField(raw: string): number | null {
  if (raw.trim().length === 0) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function PlacementEditor({
  item,
  panels,
  panelRects,
  holes,
  holePanelIndex,
  seams,
  keepout,
  wall,
  rules,
  previewUrl,
  onChange,
  onLocalCollisions,
}: PlacementEditorProps) {
  const { t } = useTranslation('cnc');
  const isUpload = item.kind !== 'text';
  // An upload starts square and a label starts at a guess from its characters.
  // Either way the browser replaces this with a real measurement, and the
  // reducer re-settles the placement against whatever comes back — so the
  // collision check is always run against the shape actually on the wall, not
  // against the one it was assumed to be on the first frame.
  const [metrics, setMetrics] = useState<LabelMetrics>(() =>
    isUpload ? SQUARE_ART_METRICS : estimateLabelMetrics(item.text),
  );

  // A cut-through takes more material out than an engrave, so the generator
  // holds it further off every hole. Checking against the wrong clearance would
  // pass a placement the order then fails on.
  const keepoutScale = item.mode === 'cut_through' ? keepout.cutThroughMultiplier : 1;

  // The generator checks a placement against every hole on the wall, not just
  // the panel it sits on: a cut-through keep-out is wide enough to reach across
  // a seam into a neighbouring panel's holes. Filtering to the selected panel
  // here would pass a placement the order then fails on, so the check runs
  // against the whole list; `panelHoles` below narrows it back down, but only
  // for what gets drawn.
  //
  // `rules` sits in this dependency array as the whole object, not the two
  // numbers pulled out of it below — the parent must hand it down as a stable
  // reference. A new object every render would give `context` a new identity
  // every render too, which re-fires the `reset` effect further down and drops
  // whatever gesture is mid-drag.
  const context: PlacementContext = useMemo(
    () => ({
      panels: panelRects,
      holes,
      seams,
      panelEdgeMarginMm: keepout.panelEdgeMarginMm,
      keepoutScale,
      aspect: metrics.aspect,
      minWidthMm: rules.minWidthMm,
      maxWidthMm: rules.maxWidthMm,
    }),
    [panelRects, holes, seams, keepout.panelEdgeMarginMm, keepoutScale, metrics.aspect, rules],
  );

  const [state, dispatch] = useReducer(placementReducer, { placement: toPlacementValue(item), context }, (start) =>
    initialPlacementState(start.placement, start.context),
  );

  // Only the selected panel's holes are worth drawing — the rest are not
  // reachable and would only be noise. Read off `state.placement.panelIndex`
  // rather than the parent draft's `item.panelIndex`: the reducer's `setPanel`
  // settles a new panel locally before the round trip through `onChange` and
  // back updates `item`, and drawing the panel it just left would be wrong for
  // however many frames that takes.
  const panelHoles = useMemo(
    () => holes.filter((_hole, index) => holePanelIndex[index] === state.placement.panelIndex),
    [holes, holePanelIndex, state.placement.panelIndex],
  );

  const currentPlacementRef = useRef(state.placement);
  currentPlacementRef.current = state.placement;

  // Re-settle when the wall itself changes: the layout arriving, the label
  // being measured, a switch to cut-through. Each of those can make a placement
  // that was fine a moment ago illegal, and the buyer should see that happen
  // rather than find out at checkout.
  useEffect(() => {
    dispatch({ type: 'reset', placement: currentPlacementRef.current, context });
  }, [context]);

  // Push settled placements up. Guarded on the value rather than on identity:
  // the parent hands back a new `onChange` every render, and an unguarded
  // effect would report the same placement on every one of them.
  const emittedRef = useRef('');
  useEffect(() => {
    const key = JSON.stringify(state.placement);
    if (key === emittedRef.current) return;
    emittedRef.current = key;
    onChange(state.placement);
  }, [state.placement, onChange]);

  const hasCollisions =
    state.collisions.offPanel || state.collisions.holes.length > 0 || state.collisions.seams.length > 0;
  useEffect(() => {
    onLocalCollisions(hasCollisions);
  }, [hasCollisions, onLocalCollisions]);

  const handleMetrics = useCallback((measured: LabelMetrics) => {
    setMetrics((previous) =>
      Math.abs(previous.aspect - measured.aspect) < METRICS_EPSILON &&
      Math.abs(previous.fontSizePerHeightMm - measured.fontSizePerHeightMm) < METRICS_EPSILON
        ? previous
        : measured,
    );
  }, []);

  // What the rectangle says when there is no drawing in it: the buyer's own
  // words, the placeholder before they have typed any, or — for an upload whose
  // preview URL died with the tab — the name the artwork step gives it.
  const artworkLabel = isUpload
    ? t('configurator.artwork.upload.stored')
    : item.text.length > 0
      ? item.text
      : t('configurator.artwork.editor.placeholder');

  const shapes: WallPanelShape[] = useMemo(
    () =>
      panelRects.map((rect) => ({
        ...rect,
        role: panels.find((panel) => panel.index === rect.index)?.role ?? null,
      })),
    [panelRects, panels],
  );

  const isReady = wall !== null && panelRects.length > 0;

  return (
    <Stack spacing={2}>
      {isReady ? (
        <Box className={styles.wallCanvasFrame}>
          <WallSvg
            wall={wall}
            panels={shapes}
            seams={seams}
            holes={panelHoles}
            placement={state.placement}
            metrics={metrics}
            text={artworkLabel}
            imageUrl={isUpload ? previewUrl : null}
            isImage={isUpload}
            collisions={state.collisions}
            ariaLabel={t('configurator.artwork.editor.canvasLabel')}
            onPointerDownArt={(kind, handle, pointerId, pointerMm) => {
              dispatch({ type: 'pointerDown', kind, handle, pointerId, pointerMm });
            }}
            onPointerMoveArt={(pointerId, pointerMm, snap) => {
              dispatch({ type: 'pointerMove', pointerId, pointerMm, snap });
            }}
            onPointerUpArt={(pointerId) => {
              dispatch({ type: 'pointerUp', pointerId });
            }}
            onNudge={(dxMm, dyMm) => {
              dispatch({ type: 'nudge', dxMm, dyMm });
            }}
            onRotateBy={(degrees) => {
              dispatch({ type: 'setRotation', rotationDeg: state.placement.rotationDeg + degrees });
            }}
            onWidthBy={(deltaMm) => {
              dispatch({ type: 'setWidth', widthMm: state.placement.widthMm + deltaMm });
            }}
            onMetrics={handleMetrics}
          />
        </Box>
      ) : (
        <Alert severity="info">{t('configurator.artwork.panelLoading')}</Alert>
      )}

      <Typography variant="caption" color="text.secondary" component="p">
        {t('configurator.artwork.editor.keyboardHelp')}
      </Typography>

      <Box className={styles.optionGrid}>
        <FormControl fullWidth size="small" disabled={panels.length === 0}>
          <InputLabel id={`cnc-artwork-panel-${item.id}`}>{t('configurator.artwork.panel')}</InputLabel>
          <Select
            labelId={`cnc-artwork-panel-${item.id}`}
            label={t('configurator.artwork.panel')}
            value={panels.length === 0 ? '' : String(state.placement.panelIndex)}
            onChange={(event) => {
              dispatch({ type: 'setPanel', panelIndex: Number(event.target.value) });
            }}
          >
            {panels.map((panel) => (
              <MenuItem key={panel.index} value={String(panel.index)}>
                {panelLabel(panel, t('configurator.artwork.kickerPanel'))}
              </MenuItem>
            ))}
          </Select>
          <FormHelperText>{t('configurator.artwork.panelHelp')}</FormHelperText>
        </FormControl>

        <TextField
          label={t('configurator.artwork.editor.width')}
          type="number"
          size="small"
          fullWidth
          value={String(Math.round(state.placement.widthMm))}
          onChange={(event) => {
            const value = readNumberField(event.target.value);
            if (value !== null) dispatch({ type: 'setWidth', widthMm: value });
          }}
          slotProps={{ htmlInput: { min: rules.minWidthMm, max: rules.maxWidthMm, step: 10 } }}
        />

        <TextField
          label={t('configurator.artwork.editor.rotation')}
          type="number"
          size="small"
          fullWidth
          value={String(Math.round(state.placement.rotationDeg))}
          onChange={(event) => {
            const value = readNumberField(event.target.value);
            if (value !== null) dispatch({ type: 'setRotation', rotationDeg: value });
          }}
          slotProps={{ htmlInput: { min: -180, max: 180, step: 5 } }}
        />
      </Box>

      {holes.length === 0 && isReady && (
        <Alert severity="info">{t('configurator.artwork.editor.holesUnavailable')}</Alert>
      )}

      {state.collisions.offPanel && <Alert severity="error">{t('configurator.artwork.editor.offPanel')}</Alert>}
      {state.collisions.holes.length > 0 && (
        <Alert severity="error">
          {t('configurator.artwork.editor.holesInTheWay', { count: state.collisions.holes.length })}
        </Alert>
      )}
      {state.collisions.seams.length > 0 && (
        <Alert severity="error">{t('configurator.artwork.editor.crossesSeam')}</Alert>
      )}
      {!hasCollisions && isReady && holes.length > 0 && (
        <Alert severity="success">{t('configurator.artwork.editor.clear')}</Alert>
      )}
    </Stack>
  );
}

function toPlacementValue(item: CncArtworkDraft): PlacementValue {
  return {
    panelIndex: item.panelIndex,
    xMm: item.xMm,
    yMm: item.yMm,
    widthMm: item.widthMm,
    rotationDeg: item.rotationDeg,
  };
}
