import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  assignLedIndices,
  extendWiring,
  groupLedPair,
  ledPairs,
  ledPartner,
  separateLedPair,
  setWiringInitialSkip,
  withLedPartners,
  setWiringSkip,
  traceLedPath,
  MAX_LED_POSITIONS,
  MAX_WIRING_SKIP,
  MAX_WIRING_TOTAL_SKIPS,
  type LedPosition,
  type TnutLayout,
  type TnutPoint,
  type TnutWiring,
} from '@boardsesh/spray-wall-geometry';
import { useTheme } from '../../providers/theme-provider';
import { useConfirm } from '../../providers/dialog-provider';
import type { SprayLookPreviewSource } from '../../lib/spray/spray-look-preview';
import { useSprayLedPreview } from '../../lib/spray/use-spray-led-preview';
import { Button } from '../Button';
import { Text } from '../Text';
import { BuilderTextInput } from '../board-discovery/BoardMetaFields';
import { SprayPhotoStage } from './SprayPhotoStage';
import { SpraySetupOverlay, SPRAY_CABLE_COLOR } from './SpraySetupOverlay';
import { SprayPhotoToolButton, SprayPointToolbar, SprayUndoButton, type SprayPointMode } from './SprayPointToolbar';
import { sprayCableDisplayGeometry } from './spray-cable-display';
import { planCableUnitEdits } from './spray-cable-unit-edits';
import { mapLedPairsById } from './spray-led-units';
import { nearestPhotoPointIndex } from './tnut-corner-viewport';

const NO_LEDS: LedPosition[] = [];
type MapEditorProps = {
  layout: TnutLayout;
  onChange: (update: Partial<TnutLayout>) => void;
  kind: 'positions' | 'wiring' | 'skips';
  wallUuid: string;
  source: SprayLookPreviewSource;
  photoUri: string;
  width: number;
  onInteractionChange: (active: boolean) => void;
};

export function SprayLedMapEditor(props: MapEditorProps) {
  if (props.kind === 'positions') return <LedPositionsEditor {...props} />;
  return props.kind === 'skips' ? <SkipsEditor {...props} /> : <CableEditor {...props} />;
}

// Enough for one Undo per LED on a long cable run.
const HISTORY_LIMIT = 300;
function useEditorHistory(layout: TnutLayout, onChange: MapEditorProps['onChange']) {
  const [history, setHistory] = useState<TnutLayout[]>([]);
  return {
    canUndo: history.length > 0,
    change: (update: Partial<TnutLayout>) => {
      setHistory((previous) => [...previous, layout].slice(-HISTORY_LIMIT));
      onChange(update);
    },
    /** Apply several updates at once, but let Undo step back through each one. */
    changeSteps: (updates: Partial<TnutLayout>[]) => {
      if (!updates.length) return;
      const states = [layout];
      for (const update of updates.slice(0, -1)) states.push({ ...states[states.length - 1], ...update });
      setHistory((previous) => [...previous, ...states].slice(-HISTORY_LIMIT));
      onChange(updates[updates.length - 1]);
    },
    undo: () => {
      const previous = history.at(-1);
      if (!previous) return;
      // The parent merges an update into the layout, so a key the snapshot lacks must be
      // named: otherwise a list added since (ledGroups on a layout whose pairs were
      // implicit) would survive the Undo.
      const restore: Partial<TnutLayout> = { ...previous };
      for (const key of Object.keys(layout)) if (!(key in previous)) Object.assign(restore, { [key]: undefined });
      onChange(restore);
      setHistory((entries) => entries.slice(0, -1));
    },
  };
}

function LedPositionsEditor({ layout, onChange, source, photoUri, width, onInteractionChange }: MapEditorProps) {
  const { t } = useTranslation('boards');
  const confirm = useConfirm();
  const { brandColors, spacing } = useTheme();
  const [mode, setMode] = useState<SprayPointMode | null>(null);
  // Pair LEDs (#7355 item 8): tap a pair to separate it, or two single LEDs to group them.
  const [pairing, setPairing] = useState(false);
  const [pendingPair, setPendingPair] = useState<string | null>(null);
  const { change, undo, canUndo } = useEditorHistory(layout, onChange);
  const leds = layout.ledPositions ?? NO_LEDS;
  const pairs = useMemo(() => ledPairs(layout), [layout]);
  const pendingClear = useRef(false);
  const liveLayout = useRef<TnutLayout | null>(layout);
  liveLayout.current = layout;
  useEffect(() => {
    liveLayout.current = layout;
    return () => {
      liveLayout.current = null;
    };
  }, [layout]);
  function chooseMode(next: SprayPointMode | null) {
    setPairing(false);
    setPendingPair(null);
    setMode(next);
  }

  async function changePositions(ledPositions: LedPosition[]) {
    const apply = () => {
      const retainedIds = new Set(ledPositions.map((led) => led.id));
      // Prune immediately: a subsequent Add can reuse a removed manual LED id.
      // Keep empty overrides so removal does not restore automatic assignments.
      const holdLeds = layout.holdLeds?.map((link) => ({
        ...link,
        ledIds: link.ledIds.filter((id) => retainedIds.has(id)),
      }));
      // Pairs go with their LEDs; a removed pair must not outlive them in the saved list.
      const ledGroups = layout.ledGroups?.filter((pair) => pair.every((id) => retainedIds.has(id)));
      change({ ledPositions, wiring: undefined, holdLeds, ledGroups });
    };
    if (!layout.wiring?.paths.length) {
      apply();
      return;
    }
    if (pendingClear.current) return;
    pendingClear.current = true;
    try {
      const accepted = await confirm({
        title: t('sprayLedSetup.clearCableTitle'),
        message: t('sprayLedSetup.clearCableBody'),
        cancelLabel: t('sprayLedSetup.keepEditing'),
        confirmLabel: t('sprayLedSetup.clearCable'),
        destructive: true,
      });
      if (accepted && liveLayout.current === layout) apply();
    } finally {
      pendingClear.current = false;
    }
  }

  function tap(point: TnutPoint, renderWidth: number, renderHeight: number) {
    if (pairing) {
      const index = nearestPhotoPointIndex(leds, point, renderWidth, renderHeight, 22);
      if (index < 0) return;
      const id = leds[index].id;
      if (ledPartner(pairs, id)) {
        change({ ledGroups: separateLedPair(layout, id).ledGroups });
        setPendingPair(null);
      } else if (pendingPair && pendingPair !== id) {
        change({ ledGroups: groupLedPair(layout, pendingPair, id).ledGroups });
        setPendingPair(null);
      } else setPendingPair(pendingPair === id ? null : id);
      return;
    }
    if (mode === 'remove') {
      const index = nearestPhotoPointIndex(leds, point, renderWidth, renderHeight, 22);
      // A pair goes as one unit.
      const partner = index >= 0 ? ledPartner(pairs, leds[index].id) : null;
      if (index >= 0) void changePositions(leds.filter((led, entry) => entry !== index && led.id !== partner));
    } else if (
      mode === 'add' &&
      leds.length < MAX_LED_POSITIONS &&
      nearestPhotoPointIndex(leds, point, renderWidth, renderHeight, 8) < 0
    ) {
      const ids = new Set(leds.map((led) => led.id));
      let serial = 0;
      while (ids.has(`manual-${serial}`)) serial++;
      void changePositions([...leds, { ...point, id: `manual-${serial}` }]);
    }
  }

  function move(start: TnutPoint, end: TnutPoint, renderWidth: number, renderHeight: number) {
    if (mode !== 'move') return;
    const index = nearestPhotoPointIndex(leds, start, renderWidth, renderHeight, 22);
    if (index < 0) return;
    const dragged = leds[index];
    const partner = ledPartner(pairs, dragged.id);
    const moving = leds.filter((led, entry) => entry === index || led.id === partner);
    // A pair moves as one unit: one translation, held back so both LEDs stay on the
    // photo, and the offset between them never changes.
    const shift = (delta: number, axis: 'x' | 'y') =>
      Math.max(
        Math.max(...moving.map((led) => -led[axis])),
        Math.min(Math.min(...moving.map((led) => 1 - led[axis])), delta),
      );
    const dx = shift(end.x - dragged.x, 'x'),
      dy = shift(end.y - dragged.y, 'y');
    // The clamp only absorbs rounding: the shift already keeps both LEDs on the photo.
    const moved = (led: TnutPoint) => ({
      x: Math.max(0, Math.min(1, led.x + dx)),
      y: Math.max(0, Math.min(1, led.y + dy)),
    });
    const target = moved(dragged);
    const occupied = nearestPhotoPointIndex(leds, target, renderWidth, renderHeight, 6);
    if (occupied >= 0 && occupied !== index && leds[occupied].id !== partner) return;
    change({
      ledPositions: leds.map((led, entry) => (entry === index || led.id === partner ? { ...led, ...moved(led) } : led)),
    });
  }

  const toolbar = { mode: pairing ? null : mode, onModeChange: chooseMode, onUndo: undo, canUndo };
  function togglePairing() {
    setMode(null);
    setPendingPair(null);
    setPairing(!pairing);
  }
  const pairButton = (
    <Button
      title={t('sprayLedSetup.pairLeds')}
      variant={pairing ? 'filled' : 'outlined'}
      size="small"
      minHeight={44}
      onPress={togglePairing}
    />
  );
  const tools = (
    <View style={{ gap: spacing[2] }}>
      <SprayPointToolbar {...toolbar} />
      {pairButton}
    </View>
  );
  return (
    <>
      <Text>
        {layout.ledPlacement === 'below'
          ? `${t('sprayLedSetup.editLedsHint')} ${t('sprayLedSetup.editLedsBelowHint')}`
          : t('sprayLedSetup.editLedsHint')}
      </Text>
      {tools}
      <SprayPhotoStage
        width={width}
        tools={tools}
        fullScreenRail={
          <>
            <SprayPointToolbar {...toolbar} icons />
            <SprayPhotoToolButton
              icon="link"
              label={t('sprayLedSetup.pairLeds')}
              selected={pairing}
              onPress={togglePairing}
            />
          </>
        }
        canvas={{
          source,
          photoUri,
          onInteractionChange,
          mode: pairing ? 'tap' : mode === 'move' ? 'move' : mode ? 'tap' : 'pan',
          onTap: tap,
          ignoreTapsOutsidePhoto: !pairing && mode === 'add',
          onMove: move,
          dragPoints: leds,
          draftColor: brandColors.primary,
          renderOverlay: (renderWidth, renderHeight, zoom, panX, panY, liveDrag) => (
            <SpraySetupOverlay
              holes={layout.holes}
              leds={leds}
              ledPairs={pairs}
              showPairConnectors
              selected={pendingPair ? [pendingPair] : []}
              compactHoles
              liveDrag={liveDrag}
              liveDragTarget="leds"
              width={renderWidth}
              height={renderHeight}
              zoom={zoom}
              panX={panX}
              panY={panY}
            />
          ),
        }}
      />
      {pairing ? (
        <Text variant="footnote" accessibilityLiveRegion="polite">
          {t(pendingPair ? 'sprayLedSetup.pairLedsSecond' : 'sprayLedSetup.pairLedsHint')}
        </Text>
      ) : null}
      <Text variant="footnote">{t(pairs.length ? 'sprayLedSetup.legendPairs' : 'sprayLedSetup.legend')}</Text>
      <Text>{t('sprayLedSetup.ledCount', { count: leds.length })}</Text>
      {pairs.length ? <Text>{t('sprayLedSetup.ledPairCount', { count: pairs.length })}</Text> : null}
    </>
  );
}

function CableEditor({ layout, onChange, wallUuid, source, photoUri, width, onInteractionChange }: MapEditorProps) {
  const { t } = useTranslation('boards');
  const { spacing, brandColors } = useTheme();
  const [chosenMode, setMode] = useState<'draw' | 'select' | 'light' | null>(null);
  // "Light and tap": physical LEDs counted as not on the photo since the last tap.
  const [pendingSkip, setPendingSkip] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const { change, changeSteps, undo, canUndo } = useEditorHistory(layout, onChange);
  const pairs = useMemo(() => ledPairs(layout), [layout]);
  const pairsById = useMemo(() => mapLedPairsById(pairs), [pairs]);
  const [previewWiring, setPreviewWiring] = useState<TnutWiring | null>(null);
  const leds = layout.ledPositions ?? NO_LEDS;
  const wiring = layout.wiring;
  const indices = useMemo(
    () => new Map(wiring ? assignLedIndices(wiring).map(({ id, index }) => [id, index]) : []),
    [wiring],
  );
  // Light and tap must stop once there is no unwired marker left to assign.
  // Lay cable stays available, and extending it only adds unwired LEDs.
  const cableComplete = leds.length > 0 && leds.every((point) => indices.has(point.id));
  const mode = cableComplete && chosenMode === 'light' ? null : chosenMode;
  const preview = useSprayLedPreview(wallUuid);
  const { available, show, stop } = preview;

  // The physical LED "Light and tap" asks about: the one after the last wired LED,
  // plus any the climber said are not on the wall.
  const lastWired = useMemo(() => (wiring ? assignLedIndices(wiring).at(-1) : undefined), [wiring]);
  const litIndex = (lastWired ? lastWired.index + 1 : (wiring?.initialSkip ?? 0)) + pendingSkip;
  const acknowledgedIndex = useRef<number | null>(null);
  const validatingPair = useRef<object | null>(null);
  const [pairPreviewFailed, setPairPreviewFailed] = useState(false);
  const skipBudget = Math.max(
    0,
    Math.min(
      MAX_WIRING_SKIP - (lastWired ? 0 : (wiring?.initialSkip ?? 0)),
      MAX_WIRING_TOTAL_SKIPS -
        (wiring?.initialSkip ?? 0) -
        (wiring?.skips.reduce((total, skip) => total + skip.count, 0) ?? 0),
    ),
  );
  useEffect(() => {
    let active = true;
    acknowledgedIndex.current = null;
    setPairPreviewFailed(false);
    if (mode === 'light' && available)
      void show([litIndex]).then((completed) => {
        if (active && completed) acknowledgedIndex.current = litIndex;
      });
    return () => {
      active = false;
      acknowledgedIndex.current = null;
      validatingPair.current = null;
    };
  }, [mode, available, litIndex, show, wiring]);
  // The last tap of Light and tap completes the cable: switch its LED off.
  useEffect(() => {
    if (cableComplete && chosenMode === 'light') void stop();
  }, [cableComplete, chosenMode, stop]);

  function chooseMode(next: typeof mode) {
    validatingPair.current = null;
    acknowledgedIndex.current = null;
    if (mode === 'light' && next !== 'light') void stop();
    setPendingSkip(0);
    setMode(next);
  }

  function changePendingSkip(delta: number) {
    const next = Math.max(0, Math.min(skipBudget, pendingSkip + delta));
    if (next === pendingSkip) return;
    validatingPair.current = null;
    acknowledgedIndex.current = null;
    setPendingSkip(next);
  }

  /** Assign the next physical index to the tapped LED and keep a pair in one Undo step. */
  function assignLit(id: string) {
    if (
      !wiring ||
      !available ||
      preview.state !== 'lit' ||
      preview.error ||
      validatingPair.current ||
      acknowledgedIndex.current !== litIndex
    )
      return;
    const additions = withLedPartners([id], pairs, new Set(indices.keys())).filter((member) => !indices.has(member));
    let next = extendWiring(wiring, additions);
    if (next === wiring) return;
    if (pendingSkip) {
      next = lastWired
        ? setWiringSkip(next, lastWired.id, additions[0], pendingSkip)
        : setWiringInitialSkip(next, (wiring.initialSkip ?? 0) + pendingSkip);
    }
    // Setters reject out-of-budget skips as no-ops. Never save a different LED
    // from the one the controller acknowledged, even after a rejected edit.
    const appended = assignLedIndices(next).slice(indices.size);
    if (appended.length !== additions.length || appended.some(({ index }, offset) => index !== litIndex + offset))
      return;
    const commit = () => {
      change({ wiring: next });
      setPendingSkip(0);
    };
    acknowledgedIndex.current = null;
    if (additions.length === 1) {
      commit();
      return;
    }

    // Let the controller validate both consecutive indices before saving the pair.
    const attempt = {};
    validatingPair.current = attempt;
    setPairPreviewFailed(false);
    void (async () => {
      const received = await preview.showPair(litIndex);
      if (validatingPair.current !== attempt) return;
      validatingPair.current = null;
      if (received === 'pair') {
        commit();
      } else if (received === 'single') {
        acknowledgedIndex.current = litIndex;
        setPairPreviewFailed(true);
      }
    })();
  }

  const selectedUnits = mode === 'select' ? selected.map((id) => pairsById.get(id) ?? ([id] as const)) : [];
  const twoUnits = selectedUnits.length === 2;
  const { cut, joined } =
    wiring && twoUnits
      ? planCableUnitEdits(wiring, selectedUnits[0], selectedUnits[1])
      : { cut: wiring, joined: wiring };
  const edge = Boolean(cut && cut !== wiring);
  const lightError = preview.error
    ? t(preview.error === 'invalid-indices' ? 'sprayLedSetup.lightAndTapEnd' : 'sprayLed.lightFailed')
    : pairPreviewFailed
      ? t('sprayLedSetup.lightAndTapPairFailed')
      : null;

  function extend(ids: string[]) {
    setPreviewWiring(null);
    if (mode !== 'draw' || !wiring) return;
    // One history step per LED, so Undo removes only the last connection.
    const steps: Partial<TnutLayout>[] = [];
    let current = wiring;
    for (const id of withLedPartners(ids, pairs, new Set(indices.keys()))) {
      const next = extendWiring(current, [id]);
      if (next === current) continue;
      steps.push({ wiring: next });
      current = next;
    }
    changeSteps(steps);
  }

  function previewTrace(points: TnutPoint[], tolerance: number) {
    if (mode !== 'draw' || !wiring) return;
    const next = extendWiring(
      wiring,
      withLedPartners(traceLedPath(leds, points, tolerance), pairs, new Set(indices.keys())),
    );
    setPreviewWiring(next === wiring ? null : next);
  }

  function tap(point: TnutPoint, renderWidth: number, renderHeight: number) {
    const index = nearestPhotoPointIndex(leds, point, renderWidth, renderHeight, 22);
    if (index < 0) return;
    const id = leds[index].id;
    if (mode === 'draw') extend([id]);
    else if (mode === 'light') assignLit(id);
    else if (mode === 'select') {
      const unitId = pairsById.get(id)?.[0] ?? id;
      setSelected((previous) =>
        previous.includes(unitId) ? previous.filter((entry) => entry !== unitId) : [...previous.slice(-1), unitId],
      );
    }
  }

  const tools = (
    <View style={[styles.row, { gap: spacing[2] }]}>
      <Button
        title={t('sprayLedSetup.drawCable')}
        variant={mode === 'draw' ? 'filled' : 'outlined'}
        onPress={() => chooseMode(mode === 'draw' ? null : 'draw')}
      />
      {cableComplete ? null : (
        <Button
          title={t('sprayLedSetup.lightAndTap')}
          variant={mode === 'light' ? 'filled' : 'outlined'}
          onPress={() => chooseMode(mode === 'light' ? null : 'light')}
        />
      )}
      <Button
        title={t('sprayLedSetup.selectLeds')}
        variant={mode === 'select' ? 'filled' : 'outlined'}
        onPress={() => chooseMode(mode === 'select' ? null : 'select')}
      />
    </View>
  );
  const accessoryTools = (
    <View style={{ gap: spacing[2] }}>
      <Text variant="footnote">{t('sprayLedSetup.wiringLegend')}</Text>
      <Text>
        {t('sprayLedSetup.wiringStatus', { wired: indices.size, total: leds.length, count: wiring?.paths.length ?? 0 })}
      </Text>
      {mode === 'light' ? (
        <>
          {available ? (
            <Text accessibilityLiveRegion="polite">{t('sprayLedSetup.lightAndTapHint', { index: litIndex })}</Text>
          ) : (
            <Text variant="footnote">{t('sprayLedSetup.lightingUnavailable')}</Text>
          )}
          {pendingSkip ? (
            <Text variant="footnote" accessibilityLiveRegion="polite">
              {t('sprayLedSetup.lightAndTapSkipped', { skipped: pendingSkip })}
            </Text>
          ) : null}
          <View style={[styles.row, { gap: spacing[2] }]}>
            <Button
              title={t('sprayLedSetup.lightAndTapSkip')}
              variant="outlined"
              disabled={!available || pendingSkip >= skipBudget}
              onPress={() => changePendingSkip(1)}
            />
            <Button
              title={t('sprayLedSetup.lightAndTapUnskip')}
              variant="text"
              disabled={!pendingSkip}
              onPress={() => changePendingSkip(-1)}
            />
          </View>
          {lightError ? (
            <Text variant="footnote" color={brandColors.error} accessibilityLiveRegion="polite">
              {lightError}
            </Text>
          ) : null}
        </>
      ) : null}
      {mode === 'select' ? (
        <>
          <Text variant="footnote">{t('sprayLedSetup.wiringHint')}</Text>
          {selected.length ? (
            <Text accessibilityLiveRegion="polite">
              {t('sprayLedSetup.selectedLeds', {
                ids: selectedUnits.map((unit) => unit.map((id) => indices.get(id) ?? '—').join(' + ')).join(' → '),
              })}
            </Text>
          ) : null}
          {twoUnits ? (
            <>
              <View style={[styles.row, { gap: spacing[2] }]}>
                <Button
                  title={t('sprayLedSetup.cutCable')}
                  disabled={!edge}
                  onPress={() => {
                    if (cut && edge) change({ wiring: cut });
                  }}
                />
                <Button
                  title={t('sprayLedSetup.connectCable')}
                  disabled={joined === wiring}
                  onPress={() => {
                    if (joined && joined !== wiring) change({ wiring: joined });
                  }}
                />
              </View>
            </>
          ) : null}
        </>
      ) : null}
    </View>
  );
  const rail = (
    <>
      <SprayPhotoToolButton
        icon="pencil.tip"
        label={t('sprayLedSetup.drawCable')}
        selected={mode === 'draw'}
        onPress={() => chooseMode(mode === 'draw' ? null : 'draw')}
      />
      {!cableComplete ? (
        <SprayPhotoToolButton
          icon="lightbulb"
          label={t('sprayLedSetup.lightAndTap')}
          selected={mode === 'light'}
          onPress={() => chooseMode(mode === 'light' ? null : 'light')}
        />
      ) : null}
      <SprayPhotoToolButton
        icon="select-two-leds"
        label={t('sprayLedSetup.selectLeds')}
        selected={mode === 'select'}
        onPress={() => chooseMode(mode === 'select' ? null : 'select')}
      />
      {mode === 'light' ? (
        <>
          {!available || lightError ? (
            <Text
              variant="caption2"
              color={brandColors.error}
              accessibilityLiveRegion="polite"
              style={styles.railStatus}
            >
              {!available ? t('sprayLedSetup.lightingUnavailable') : lightError}
            </Text>
          ) : (
            <Text variant="footnote" accessibilityLabel={t('sprayLedSetup.lightAndTapHint', { index: litIndex })}>
              {litIndex}
            </Text>
          )}
          <SprayPhotoToolButton
            icon="plus"
            label={t('sprayLedSetup.lightAndTapSkip')}
            disabled={!available || pendingSkip >= skipBudget}
            onPress={() => changePendingSkip(1)}
          />
          <SprayPhotoToolButton
            icon="minus"
            label={t('sprayLedSetup.lightAndTapUnskip')}
            disabled={!pendingSkip}
            onPress={() => changePendingSkip(-1)}
          />
        </>
      ) : null}
      {twoUnits ? (
        <>
          <SprayPhotoToolButton
            icon="scissors"
            label={t('sprayLedSetup.cutCable')}
            disabled={!edge}
            onPress={() => {
              if (cut && edge) change({ wiring: cut });
            }}
          />
          <SprayPhotoToolButton
            icon="link"
            label={t('sprayLedSetup.connectCable')}
            disabled={joined === wiring}
            onPress={() => {
              if (joined && joined !== wiring) change({ wiring: joined });
            }}
          />
        </>
      ) : null}
    </>
  );
  return (
    <>
      <Text>{t(cableComplete ? 'sprayLedSetup.cableComplete' : 'sprayLedSetup.cableEditorHint')}</Text>
      {tools}
      <SprayPhotoStage
        width={width}
        tools={tools}
        fullScreenRail={rail}
        accessoryTools={accessoryTools}
        overlayTools={
          <SprayUndoButton
            disabled={!canUndo}
            onPress={() => {
              validatingPair.current = null;
              acknowledgedIndex.current = null;
              undo();
              setSelected([]);
              setPendingSkip(0);
            }}
          />
        }
        canvas={{
          source,
          photoUri,
          onInteractionChange: (active) => {
            // A trace cancelled by a pinch never commits; drop its preview.
            if (!active) setPreviewWiring(null);
            onInteractionChange(active);
          },
          mode: mode === 'draw' ? 'draw' : mode === 'select' || mode === 'light' ? 'tap' : 'pan',
          onTap: tap,
          onTrace: (points, tolerance) => extend(traceLedPath(leds, points, tolerance)),
          onTraceProgress: previewTrace,
          dragPoints: leds,
          draftColor: SPRAY_CABLE_COLOR,
          renderOverlay: (renderWidth, renderHeight, zoom, panX, panY) => (
            <SpraySetupOverlay
              holes={layout.holes}
              leds={leds}
              wiring={previewWiring ?? wiring}
              showSkips={false}
              ledPairs={pairs}
              selected={mode === 'select' ? selectedUnits.flat() : undefined}
              width={renderWidth}
              height={renderHeight}
              zoom={zoom}
              panX={panX}
              panY={panY}
            />
          ),
        }}
      />
      {accessoryTools}
    </>
  );
}

/** Shortest screen distance from a tap to a cable connection, in render pixels. */
function distanceToConnection(point: TnutPoint, from: TnutPoint, to: TnutPoint, width: number, height: number): number {
  const ax = from.x * width,
    ay = from.y * height,
    bx = to.x * width,
    by = to.y * height,
    px = point.x * width,
    py = point.y * height;
  const lengthSquared = (bx - ax) ** 2 + (by - ay) ** 2;
  const along = lengthSquared
    ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / lengthSquared))
    : 0;
  return Math.hypot(px - (ax + along * (bx - ax)), py - (ay + along * (by - ay)));
}

type Connection = { from: string; to: string };

/**
 * Skipped LEDs (#7355 item 10): after the cable is laid, pick a connection on it
 * and say how many LEDs the strip has there that are not on the wall. The wall
 * lights the wired LEDs or LED pairs at the ends of the connection to check the count.
 */
function SkipsEditor({ layout, onChange, wallUuid, source, photoUri, width, onInteractionChange }: MapEditorProps) {
  const { t } = useTranslation('boards');
  const isFocused = useIsFocused();
  const { spacing, brandColors } = useTheme();
  const { change, undo, canUndo } = useEditorHistory(layout, onChange);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [skipText, setSkipText] = useState<string | null>(null);
  const [endsLit, setEndsLit] = useState(true);
  const leds = layout.ledPositions ?? NO_LEDS;
  const wiring = layout.wiring;
  const pairs = useMemo(() => ledPairs(layout), [layout]);
  const indices = useMemo(
    () => new Map(wiring ? assignLedIndices(wiring).map(({ id, index }) => [id, index]) : []),
    [wiring],
  );
  const connections = useMemo(() => sprayCableDisplayGeometry(leds, wiring, pairs).edges, [leds, wiring, pairs]);
  // Undo, or a cable changed on the previous step, can remove the selected connection.
  const selected = connection
    ? connections.find(({ fromId, toId }) => fromId === connection.from && toId === connection.to)
    : undefined;
  // A stored skip may name the connection's ends in the other order.
  const gapCount = selected?.skip ?? 0;
  const endLedIds = selected
    ? [
        ...new Set([
          selected.fromId,
          ledPartner(pairs, selected.fromId),
          selected.toId,
          ledPartner(pairs, selected.toId),
        ]),
      ].filter((id) => id !== null)
    : [];
  const ends = endLedIds
    .map((id) => indices.get(id))
    .filter((index) => index !== undefined)
    .sort((first, second) => first - second);
  const endsKey = endsLit ? ends.join(',') : '';

  const preview = useSprayLedPreview(wallUuid);
  const { available, show, stop } = preview;
  const lastLit = useRef('');
  useEffect(() => {
    if (!available || endsKey === lastLit.current) return;
    lastLit.current = endsKey;
    if (endsKey) void show(endsKey.split(',').map(Number));
    else void stop();
  }, [available, endsKey, show, stop]);

  const newSkip = skipText === null ? NaN : Number(skipText);
  const validSkip = skipText !== null && /^\d+$/.test(skipText) && newSkip <= MAX_WIRING_SKIP;
  const skipped =
    wiring && selected && validSkip ? setWiringSkip(wiring, selected.fromId, selected.toId, newSkip) : wiring;
  const canApplySkip = Boolean(selected) && validSkip && (newSkip === gapCount || skipped !== wiring);
  const dialog =
    skipText === null ? null : (
      <SkipCountDialog
        value={skipText}
        onChange={setSkipText}
        onClose={() => setSkipText(null)}
        canApply={canApplySkip}
        onApply={() => {
          if (!canApplySkip) return;
          if (skipped && newSkip !== gapCount) change({ wiring: skipped });
          setSkipText(null);
        }}
      />
    );
  const insertSkips = () => setSkipText(String(gapCount || 1));
  const toggleEnds = () => setEndsLit((lit) => !lit);
  const previewEnds = endsLit && Boolean(selected);
  const endsLabel = t(previewEnds ? 'sprayLedSetup.skipsEndsOff' : 'sprayLedSetup.skipsLightEnds');

  function tap(point: TnutPoint, renderWidth: number, renderHeight: number) {
    let best: Connection | null = null;
    let bestDistance = 24;
    for (const candidate of connections) {
      const distance = distanceToConnection(point, candidate.from, candidate.to, renderWidth, renderHeight);
      if (distance < bestDistance) {
        best = { from: candidate.fromId, to: candidate.toId };
        bestDistance = distance;
      }
    }
    setConnection(best);
  }

  const tools = (
    <View style={[styles.row, { gap: spacing[2] }]}>
      <Button title={t('sprayLedSetup.insertSkips')} variant="outlined" disabled={!selected} onPress={insertSkips} />
      <Button
        title={endsLabel}
        variant={previewEnds ? 'filled' : 'outlined'}
        disabled={!available || !selected}
        onPress={toggleEnds}
      />
    </View>
  );
  return (
    <>
      <Text>{t('sprayLedSetup.skipsHint')}</Text>
      {tools}
      <SprayPhotoStage
        width={width}
        tools={tools}
        fullScreenDialog={dialog}
        fullScreenRail={
          <>
            <SprayPhotoToolButton
              icon="insert-skipped-leds"
              label={t('sprayLedSetup.insertSkips')}
              disabled={!selected}
              onPress={insertSkips}
            />
            <SprayPhotoToolButton
              icon={previewEnds ? 'lightbulb.fill' : 'lightbulb'}
              label={endsLabel}
              selected={previewEnds}
              disabled={!available || !selected}
              onPress={toggleEnds}
            />
          </>
        }
        overlayTools={<SprayUndoButton disabled={!canUndo} onPress={undo} />}
        canvas={{
          source,
          photoUri,
          onInteractionChange,
          mode: 'tap',
          onTap: tap,
          renderOverlay: (renderWidth, renderHeight, zoom, panX, panY) => (
            <SpraySetupOverlay
              holes={layout.holes}
              compactHoles
              leds={leds}
              wiring={wiring}
              ledPairs={pairs}
              distinguishSkips
              selected={endLedIds}
              width={renderWidth}
              height={renderHeight}
              zoom={zoom}
              panX={panX}
              panY={panY}
            />
          ),
        }}
      />
      <Text accessibilityLiveRegion="polite">
        {selected
          ? t('sprayLedSetup.skipsSelected', {
              from: indices.get(selected.fromId) ?? '—',
              to: indices.get(selected.toId) ?? '—',
            })
          : t('sprayLedSetup.skipsNoConnection')}
      </Text>
      {selected ? (
        <Text>{gapCount ? t('sprayLedSetup.gapLabel', { count: gapCount }) : t('sprayLedSetup.skipsNone')}</Text>
      ) : null}
      {!available ? <Text variant="footnote">{t('sprayLedSetup.lightingUnavailable')}</Text> : null}
      {preview.error ? (
        <Text variant="footnote" color={brandColors.error} accessibilityLiveRegion="polite">
          {preview.error === 'invalid-indices' ? t('sprayLedSetup.lightingRangeError') : t('sprayLed.lightFailed')}
        </Text>
      ) : null}
      {isFocused ? dialog : null}
    </>
  );
}

function SkipCountDialog({
  value,
  onChange,
  onClose,
  onApply,
  canApply,
}: {
  value: string;
  onChange: (text: string) => void;
  onClose: () => void;
  onApply: () => void;
  canApply: boolean;
}) {
  const { t } = useTranslation('boards');
  const { systemColors, spacing } = useTheme();
  const count = /^\d+$/.test(value) ? Number(value) : 0;
  return (
    <Modal
      transparent
      animationType="fade"
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}
    >
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.scrim}>
        <View
          accessibilityViewIsModal
          style={[styles.dialog, { backgroundColor: systemColors.background, padding: spacing[4], gap: spacing[3] }]}
        >
          <Text variant="headline">{t('sprayLedSetup.skipCount')}</Text>
          <View style={[styles.row, { alignItems: 'center', flexWrap: 'nowrap', gap: spacing[2] }]}>
            <View style={styles.skipInput}>
              <BuilderTextInput
                accessibilityLabel={t('sprayLedSetup.skipCount')}
                value={value}
                onChangeText={onChange}
                keyboardType="number-pad"
                maxLength={5}
                selectTextOnFocus
              />
            </View>
            <Button
              title="−"
              accessibilityLabel={t('sprayLedSetup.decrease', { label: t('sprayLedSetup.skipCount') })}
              variant="outlined"
              disabled={count <= 0}
              onPress={() => onChange(String(Math.max(0, Math.min(MAX_WIRING_SKIP, count - 1))))}
            />
            <Button
              title="+"
              accessibilityLabel={t('sprayLedSetup.increase', { label: t('sprayLedSetup.skipCount') })}
              variant="outlined"
              disabled={count >= MAX_WIRING_SKIP}
              onPress={() => onChange(String(Math.max(0, Math.min(MAX_WIRING_SKIP, count + 1))))}
            />
          </View>
          <Text variant="footnote">{t('sprayLedSetup.skipCountRange', { max: MAX_WIRING_SKIP })}</Text>
          <View style={[styles.row, { gap: spacing[2] }]}>
            <Button title={t('sprayLedSetup.cancelSkip')} variant="text" onPress={onClose} />
            <Button title={t('sprayLed.confirm')} disabled={!canApply} onPress={onApply} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap' },
  railStatus: { width: 96, textAlign: 'center' },
  scrim: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 16, backgroundColor: 'rgba(0,0,0,0.5)' },
  dialog: { width: '100%', maxWidth: 360, borderRadius: 16 },
  skipInput: { flex: 1 },
});
