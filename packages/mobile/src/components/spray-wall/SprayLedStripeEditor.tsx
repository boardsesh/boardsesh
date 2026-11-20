import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  addLedStripe,
  addLedStripeLed,
  moveLedStripeEndpoint,
  removeLedStripe,
  removeLedStripeLed,
  setLedStripeCount,
  MAX_LED_POSITIONS,
  MAX_LED_STRIPES,
  type TnutLayout,
  type TnutPoint,
} from '@boardsesh/spray-wall-geometry';
import { useTheme } from '../../providers/theme-provider';
import { useConfirm } from '../../providers/dialog-provider';
import type { SprayLookPreviewSource } from '../../lib/spray/spray-look-preview';
import { Button } from '../Button';
import { SegmentedControl } from '../SegmentedControl';
import { Text } from '../Text';
import { BuilderTextInput } from '../board-discovery/BoardMetaFields';
import { SprayPhotoStage } from './SprayPhotoStage';
import { SpraySetupOverlay } from './SpraySetupOverlay';
import { SprayPhotoToolButton, SprayUndoButton } from './SprayPointToolbar';
import { nearestPhotoPointIndex } from './tnut-corner-viewport';

type Target = 'stripes' | 'leds';
type Mode = 'select' | 'add' | 'move' | 'remove' | null;
type Props = {
  layout: TnutLayout;
  source: SprayLookPreviewSource;
  photoUri: string;
  width: number;
  defaultCount: number;
  onChange: (update: Partial<TnutLayout>) => void;
  onInteractionChange: (active: boolean) => void;
};

/** Physical stripe units and their individual markers share the standard photo editor. */
export function SprayLedStripeEditor({
  layout,
  source,
  photoUri,
  width,
  defaultCount,
  onChange,
  onInteractionChange,
}: Props) {
  const { t } = useTranslation('boards');
  const { spacing, brandColors } = useTheme();
  const confirm = useConfirm();
  const isFocused = useIsFocused();
  const [target, setTarget] = useState<Target>('stripes');
  const [mode, setMode] = useState<Mode>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingStart, setPendingStart] = useState<TnutPoint | null>(null);
  const [countText, setCountText] = useState<string | null>(null);
  const [history, setHistory] = useState<TnutLayout[]>([]);
  const [capacityError, setCapacityError] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const liveLayout = useRef<TnutLayout | null>(layout);
  liveLayout.current = layout;
  useEffect(
    () => () => {
      liveLayout.current = null;
    },
    [],
  );
  const stripes = layout.ledStripes?.stripes ?? [];
  const leds = layout.ledPositions ?? [];
  const selected = stripes.find((stripe) => stripe.id === selectedId);
  const endpointPoints = useMemo(() => stripes.flatMap((stripe) => [stripe.start, stripe.end]), [stripes]);
  const segments = useMemo(() => stripes.map((stripe) => ({ from: stripe.start, to: stripe.end })), [stripes]);
  const ledToStripe = useMemo(
    () => new Map(stripes.flatMap((stripe) => stripe.ledIds.map((id) => [id, stripe.id] as const))),
    [stripes],
  );

  function changeMode(next: Mode) {
    if (pending.current) return;
    setMode(mode === next ? null : next);
    setPendingStart(null);
  }
  function changeTarget(next: Target) {
    if (pending.current) return;
    setTarget(next);
    setMode(null);
    setPendingStart(null);
  }
  function commit(next: TnutLayout) {
    if (next === layout) return;
    setHistory((entries) => [...entries.slice(-49), layout]);
    onChange(next);
    setCapacityError(false);
  }
  async function changeTopology(next: TnutLayout | 'capacity') {
    if (pending.current) return;
    if (next === 'capacity') {
      setCapacityError(true);
      return;
    }
    if (next === layout) return;
    if (
      !layout.wiring ||
      (!layout.wiring.paths.some((path) => path.length) && !layout.wiring.skips.length && !layout.wiring.initialSkip)
    ) {
      commit(next);
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const accepted = await confirm({
        title: t('sprayLedSetup.clearCableTitle'),
        message: t('sprayLedSetup.clearCableBody'),
        cancelLabel: t('sprayLedSetup.keepEditing'),
        confirmLabel: t('sprayLedSetup.clearCable'),
        destructive: true,
      });
      if (accepted && liveLayout.current === layout) commit(next);
    } finally {
      pending.current = false;
      if (liveLayout.current) setBusy(false);
    }
  }
  function nearestStripe(point: TnutPoint, renderWidth: number, renderHeight: number) {
    let selectedStripe: string | null = null;
    let best = 24;
    for (const stripe of stripes) {
      const dx = (stripe.end.x - stripe.start.x) * renderWidth;
      const dy = (stripe.end.y - stripe.start.y) * renderHeight;
      const fromX = (point.x - stripe.start.x) * renderWidth;
      const fromY = (point.y - stripe.start.y) * renderHeight;
      const lengthSquared = dx * dx + dy * dy;
      const fraction = lengthSquared ? Math.max(0, Math.min(1, (fromX * dx + fromY * dy) / lengthSquared)) : 0;
      const distance = Math.hypot(fromX - dx * fraction, fromY - dy * fraction);
      if (distance < best) {
        best = distance;
        selectedStripe = stripe.id;
      }
    }
    return selectedStripe;
  }
  function tap(point: TnutPoint, renderWidth: number, renderHeight: number) {
    if (busy || !mode) return;
    const hitStripe = nearestStripe(point, renderWidth, renderHeight);
    if (target === 'stripes') {
      if (mode === 'add') {
        if (!pendingStart) setPendingStart(point);
        else {
          void changeTopology(addLedStripe(layout, pendingStart, point, defaultCount));
          setPendingStart(null);
        }
      } else if (mode === 'remove' && hitStripe) {
        void changeTopology(removeLedStripe(layout, hitStripe));
      } else if (mode === 'select') setSelectedId(hitStripe);
    } else {
      const ledIndex = nearestPhotoPointIndex(leds, point, renderWidth, renderHeight, 22);
      const led = leds[ledIndex];
      const owner = led ? ledToStripe.get(led.id) : undefined;
      if (mode === 'remove' && led && owner) void changeTopology(removeLedStripeLed(layout, owner, led.id));
      else if (mode === 'add' && (selected?.id ?? hitStripe))
        void changeTopology(addLedStripeLed(layout, selected?.id ?? hitStripe!, point));
      else if (mode === 'select') setSelectedId(owner ?? hitStripe);
    }
  }
  function move(start: TnutPoint, end: TnutPoint, renderWidth: number, renderHeight: number) {
    if (busy || mode !== 'move') return;
    if (target === 'stripes') {
      const endpoint = nearestPhotoPointIndex(endpointPoints, start, renderWidth, renderHeight, 22);
      if (endpoint < 0) return;
      const stripe = stripes[Math.floor(endpoint / 2)];
      setSelectedId(stripe.id);
      commit(moveLedStripeEndpoint(layout, stripe.id, endpoint % 2 ? 'end' : 'start', end));
    } else {
      const ledIndex = nearestPhotoPointIndex(leds, start, renderWidth, renderHeight, 22);
      if (ledIndex < 0) return;
      setSelectedId(ledToStripe.get(leds[ledIndex].id) ?? null);
      commit({ ...layout, ledPositions: leds.map((led, index) => (index === ledIndex ? { ...led, ...end } : led)) });
    }
  }
  function undo() {
    if (busy) return;
    if (pendingStart) {
      setPendingStart(null);
      return;
    }
    const previous = history.at(-1);
    if (!previous) return;
    onChange({
      ...previous,
      wiring: previous.wiring,
      holdLeds: previous.holdLeds,
      holdAboveLeds: previous.holdAboveLeds,
      tnutLeds: previous.tnutLeds,
      ledGroups: previous.ledGroups,
    });
    setHistory((entries) => entries.slice(0, -1));
    setCapacityError(false);
  }
  const actions = [
    { mode: 'select', icon: 'hand.raised', label: t('sprayLedSetup.stripeSelect') },
    { mode: 'add', icon: 'plus', label: t('sprayLedSetup.add') },
    { mode: 'move', icon: 'move', label: t('sprayLedSetup.movePoint') },
    { mode: 'remove', icon: 'minus', label: t('sprayLedSetup.remove') },
  ] as const;
  const countAction = () => {
    if (selected && !busy) setCountText(String(selected.ledIds.length));
  };
  const tools = (
    <View style={{ gap: spacing[2] }}>
      <SegmentedControl
        options={[
          { key: 'stripes' as const, label: t('sprayLedSetup.stripeTarget') },
          { key: 'leds' as const, label: t('sprayLed.title') },
        ]}
        selectedKey={target}
        onSelect={changeTarget}
        accessibilityLabel={t('sprayLedSetup.stripeTargetLabel')}
      />
      <View style={styles.row}>
        {actions.map((action) => (
          <Button
            key={action.mode}
            title={action.label}
            size="small"
            minHeight={44}
            disabled={busy}
            variant={mode === action.mode ? 'filled' : 'outlined'}
            onPress={() => changeMode(action.mode)}
          />
        ))}
        <Button
          title={t('sprayLedSetup.stripeEditCount')}
          variant="outlined"
          disabled={!selected || busy}
          onPress={countAction}
        />
        <SprayUndoButton disabled={busy || (!history.length && !pendingStart)} onPress={undo} />
      </View>
    </View>
  );
  const count = countText !== null && /^\d+$/.test(countText) ? Number(countText) : 0;
  const maxCount = MAX_LED_POSITIONS - leds.length + (selected?.ledIds.length ?? 0);
  const validCount = count >= 1 && count <= maxCount;
  const dialog =
    countText === null ? null : (
      <StripeCountDialog
        countText={countText}
        maxCount={maxCount}
        capacityError={capacityError}
        onChange={(text) => {
          setCountText(text);
          setCapacityError(false);
        }}
        onClose={() => setCountText(null)}
        valid={validCount}
        onApply={() => {
          if (!selected || !validCount) return;
          const next = setLedStripeCount(layout, selected.id, count);
          if (next === 'capacity') {
            setCapacityError(true);
            return;
          }
          setCountText(null);
          void changeTopology(next);
        }}
      />
    );
  return (
    <View style={{ gap: spacing[3] }}>
      <Text>{target === 'stripes' ? t('sprayLedSetup.stripeEditorHint') : t('sprayLedSetup.stripeLedHint')}</Text>
      {tools}
      <SprayPhotoStage
        width={width}
        tools={tools}
        fullScreenDialog={dialog}
        fullScreenRail={
          <>
            <SprayPhotoToolButton
              icon={target === 'stripes' ? 'lightbulb' : 'frames'}
              label={target === 'stripes' ? t('sprayLed.title') : t('sprayLedSetup.stripeTarget')}
              onPress={() => changeTarget(target === 'stripes' ? 'leds' : 'stripes')}
              disabled={busy}
            />
            {actions.map((action) => (
              <SprayPhotoToolButton
                key={action.mode}
                icon={action.icon}
                label={action.label}
                selected={mode === action.mode}
                onPress={() => changeMode(action.mode)}
                disabled={busy}
              />
            ))}
            <SprayPhotoToolButton
              icon="edit"
              label={t('sprayLedSetup.stripeEditCount')}
              onPress={countAction}
              disabled={!selected || busy}
            />
            <SprayUndoButton disabled={busy || (!history.length && !pendingStart)} onPress={undo} />
          </>
        }
        canvas={{
          source,
          photoUri,
          mode:
            busy || !mode ? 'pan' : mode === 'move' ? 'move' : mode === 'add' && target === 'stripes' ? 'draw' : 'tap',
          onTap: tap,
          onMove: move,
          onTrace: (points) => {
            if (mode !== 'add' || target !== 'stripes' || points.length < 2 || busy) return;
            setPendingStart(null);
            void changeTopology(addLedStripe(layout, points[0], points[points.length - 1], defaultCount));
          },
          ignoreTapsOutsidePhoto: mode === 'add',
          dragPoints: mode === 'move' ? (target === 'stripes' ? endpointPoints : leds) : undefined,
          draftColor: brandColors.primary,
          onInteractionChange,
          renderOverlay: (renderWidth, renderHeight, zoom, panX, panY, liveDrag) => (
            <SpraySetupOverlay
              holes={endpointPoints}
              compactHoles
              leds={leds}
              selected={selected?.ledIds ?? []}
              selectedHoles={pendingStart ? [pendingStart] : selected ? [selected.start, selected.end] : []}
              stripeSegments={segments}
              liveDrag={liveDrag}
              liveDragTarget={target === 'stripes' ? 'holes' : 'leds'}
              width={renderWidth}
              height={renderHeight}
              zoom={zoom}
              panX={panX}
              panY={panY}
            />
          ),
        }}
      />
      <Text variant="footnote" accessibilityLiveRegion="polite">
        {selected
          ? t('sprayLedSetup.stripeSelected', { count: selected.ledIds.length })
          : t('sprayLedSetup.stripeNothingSelected')}
      </Text>
      {pendingStart ? <Text variant="footnote">{t('sprayLedSetup.stripePickEnd')}</Text> : null}
      {capacityError ? (
        <Text color={brandColors.error} accessibilityLiveRegion="polite">
          {t('sprayLedSetup.stripeCapacity', { max: MAX_LED_POSITIONS, stripes: MAX_LED_STRIPES })}
        </Text>
      ) : null}
      {isFocused ? dialog : null}
    </View>
  );
}

function StripeCountDialog({
  countText,
  maxCount,
  capacityError,
  onChange,
  onClose,
  onApply,
  valid,
}: {
  countText: string;
  maxCount: number;
  capacityError: boolean;
  onChange: (text: string) => void;
  onClose: () => void;
  onApply: () => void;
  valid: boolean;
}) {
  const { t } = useTranslation('boards');
  const { spacing, systemColors } = useTheme();
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
          <Text variant="headline">{t('sprayLedSetup.stripeCount')}</Text>
          <BuilderTextInput
            accessibilityLabel={t('sprayLedSetup.stripeCount')}
            value={countText}
            onChangeText={onChange}
            keyboardType="number-pad"
            maxLength={5}
            selectTextOnFocus
          />
          <Text variant="footnote" accessibilityLiveRegion="polite">
            {t('sprayLedSetup.stripeCountRange', { max: maxCount })}
          </Text>
          {capacityError ? (
            <Text accessibilityLiveRegion="polite">
              {t('sprayLedSetup.stripeCapacity', { max: MAX_LED_POSITIONS, stripes: MAX_LED_STRIPES })}
            </Text>
          ) : null}
          <View style={styles.row}>
            <Button title={t('sprayLedSetup.cancelSkip')} variant="text" onPress={onClose} />
            <Button title={t('sprayLed.confirm')} disabled={!valid} onPress={onApply} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  scrim: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 16, backgroundColor: 'rgba(0,0,0,0.5)' },
  dialog: { width: '100%', maxWidth: 360, borderRadius: 16 },
});
