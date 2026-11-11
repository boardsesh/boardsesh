import { useEffect, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  assignLedIndices,
  connectWiring,
  cutWiring,
  extendWiring,
  setWiringSkip,
  traceLedPath,
  MAX_LED_POSITIONS,
  MAX_WIRING_SKIP,
  type LedPosition,
  type TnutLayout,
  type TnutPoint,
} from '@boardsesh/spray-wall-geometry';
import { useTheme } from '../../providers/theme-provider';
import type { SprayLookPreviewSource } from '../../lib/spray/spray-look-preview';
import { useSprayLedPreview } from '../../lib/spray/use-spray-led-preview';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { BuilderTextInput } from '../board-discovery/BoardMetaFields';
import { SprayPhotoStage } from './SprayPhotoStage';
import { SpraySetupOverlay, SPRAY_CABLE_COLOR } from './SpraySetupOverlay';
import { SprayPointToolbar, SprayUndoButton, type SprayPointMode } from './SprayPointToolbar';
import { nearestPhotoPointIndex } from './tnut-corner-viewport';

const NO_LEDS: LedPosition[] = [];
type MapEditorProps = {
  layout: TnutLayout;
  onChange: (update: Partial<TnutLayout>) => void;
  kind: 'positions' | 'wiring';
  wallUuid: string;
  source: SprayLookPreviewSource;
  photoUri: string;
  width: number;
  onInteractionChange: (active: boolean) => void;
};

export function SprayLedMapEditor(props: MapEditorProps) {
  return props.kind === 'positions' ? <LedPositionsEditor {...props} /> : <CableEditor {...props} />;
}

function useEditorHistory(layout: TnutLayout, onChange: MapEditorProps['onChange']) {
  const [history, setHistory] = useState<TnutLayout[]>([]);
  return {
    canUndo: history.length > 0,
    change: (update: Partial<TnutLayout>) => {
      setHistory((previous) => [...previous.slice(-29), layout]);
      onChange(update);
    },
    undo: () => {
      const previous = history.at(-1);
      if (!previous) return;
      onChange(previous);
      setHistory((entries) => entries.slice(0, -1));
    },
  };
}

function LedPositionsEditor({ layout, onChange, source, photoUri, width, onInteractionChange }: MapEditorProps) {
  const { t } = useTranslation('boards');
  const { brandColors } = useTheme();
  const [mode, setMode] = useState<SprayPointMode | null>(null);
  const { change, undo, canUndo } = useEditorHistory(layout, onChange);
  const leds = layout.ledPositions ?? NO_LEDS;

  function changePositions(ledPositions: LedPosition[]) {
    const apply = () => change({ ledPositions, wiring: undefined });
    if (!layout.wiring?.paths.length) {
      apply();
      return;
    }
    Alert.alert(t('sprayLedSetup.clearCableTitle'), t('sprayLedSetup.clearCableBody'), [
      { text: t('sprayLedSetup.keepEditing'), style: 'cancel' },
      { text: t('sprayLedSetup.clearCable'), style: 'destructive', onPress: apply },
    ]);
  }

  function tap(point: TnutPoint, renderWidth: number, renderHeight: number) {
    if (mode === 'remove') {
      const index = nearestPhotoPointIndex(leds, point, renderWidth, renderHeight, 22);
      if (index >= 0) changePositions(leds.filter((_, entry) => entry !== index));
    } else if (
      mode === 'add' &&
      leds.length < MAX_LED_POSITIONS &&
      nearestPhotoPointIndex(leds, point, renderWidth, renderHeight, 8) < 0
    ) {
      const ids = new Set(leds.map((led) => led.id));
      let serial = 0;
      while (ids.has(`manual-${serial}`)) serial++;
      changePositions([...leds, { ...point, id: `manual-${serial}` }]);
    }
  }

  function move(start: TnutPoint, end: TnutPoint, renderWidth: number, renderHeight: number) {
    if (mode !== 'move') return;
    const index = nearestPhotoPointIndex(leds, start, renderWidth, renderHeight, 22);
    const occupied = nearestPhotoPointIndex(leds, end, renderWidth, renderHeight, 6);
    if (index < 0 || (occupied >= 0 && occupied !== index)) return;
    change({ ledPositions: leds.map((led, entry) => (entry === index ? { ...led, ...end } : led)) });
  }

  const toolbar = { mode, onModeChange: setMode, onUndo: undo, canUndo };
  const tools = <SprayPointToolbar {...toolbar} />;
  return (
    <>
      <Text>{t('sprayLedSetup.editLedsHint')}</Text>
      {tools}
      <SprayPhotoStage
        width={width}
        tools={tools}
        fullScreenRail={<SprayPointToolbar {...toolbar} icons />}
        canvas={{
          source,
          photoUri,
          onInteractionChange,
          mode: mode === 'move' ? 'move' : mode ? 'tap' : 'pan',
          onTap: tap,
          onMove: move,
          dragPoints: leds,
          draftColor: brandColors.primary,
          renderOverlay: (renderWidth, renderHeight, zoom, panX, panY) => (
            <SpraySetupOverlay
              holes={layout.holes}
              leds={leds}
              width={renderWidth}
              height={renderHeight}
              zoom={zoom}
              panX={panX}
              panY={panY}
            />
          ),
        }}
      />
      <Text variant="footnote">{t('sprayLedSetup.legend')}</Text>
      <Text>{t('sprayLedSetup.ledCount', { count: leds.length })}</Text>
    </>
  );
}

function CableEditor({ layout, onChange, wallUuid, source, photoUri, width, onInteractionChange }: MapEditorProps) {
  const { t } = useTranslation('boards');
  const { spacing, brandColors } = useTheme();
  const [mode, setMode] = useState<'draw' | 'select' | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [highlight, setHighlight] = useState(false);
  const [skipText, setSkipText] = useState<string | null>(null);
  const { change, undo, canUndo } = useEditorHistory(layout, onChange);
  const leds = layout.ledPositions ?? NO_LEDS;
  const wiring = layout.wiring;
  const indices = useMemo(
    () => new Map(wiring ? assignLedIndices(wiring).map(({ id, index }) => [id, index]) : []),
    [wiring],
  );
  const physicalSelection = useMemo(
    () =>
      selected.flatMap((id) => {
        const index = indices.get(id);
        return index === undefined ? [] : [index];
      }),
    [selected, indices],
  );
  const preview = useSprayLedPreview(wallUuid);
  const { available, show, stop } = preview;
  useEffect(() => {
    if (!available || !highlight) return;
    if (mode === 'select' && physicalSelection.length) void show(physicalSelection);
    else void stop();
  }, [available, highlight, mode, physicalSelection, show, stop]);

  const pair = mode === 'select' && selected.length === 2 ? selected : null;
  const cut = wiring && pair ? cutWiring(wiring, pair[0], pair[1]) : wiring;
  const joined = wiring && pair ? connectWiring(wiring, pair[0], pair[1]) : wiring;
  const edge = Boolean(cut && cut !== wiring);
  const gapCount = pair
    ? (wiring?.skips.find(
        ({ from, to }) => (from === pair[0] && to === pair[1]) || (from === pair[1] && to === pair[0]),
      )?.count ?? 0)
    : 0;
  const newSkip = skipText === null ? NaN : Number(skipText);
  const validSkip = skipText !== null && /^\d+$/.test(skipText) && newSkip <= MAX_WIRING_SKIP;
  const skipped = wiring && pair && validSkip ? setWiringSkip(wiring, pair[0], pair[1], newSkip) : wiring;
  const canApplySkip = edge && validSkip && (newSkip === gapCount || skipped !== wiring);

  function extend(ids: string[]) {
    if (mode !== 'draw' || !wiring) return;
    const next = extendWiring(wiring, ids);
    if (next !== wiring) change({ wiring: next });
  }

  function tap(point: TnutPoint, renderWidth: number, renderHeight: number) {
    const index = nearestPhotoPointIndex(leds, point, renderWidth, renderHeight, 22);
    if (index < 0) return;
    const id = leds[index].id;
    if (mode === 'draw') extend([id]);
    else if (mode === 'select')
      setSelected((previous) =>
        previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous.slice(-1), id],
      );
  }

  const tools = (
    <View style={[styles.row, { gap: spacing[2] }]}>
      <Button
        title={t('sprayLedSetup.drawCable')}
        variant={mode === 'draw' ? 'filled' : 'outlined'}
        onPress={() => setMode(mode === 'draw' ? null : 'draw')}
      />
      <Button
        title={t('sprayLedSetup.selectLeds')}
        variant={mode === 'select' ? 'filled' : 'outlined'}
        onPress={() => setMode(mode === 'select' ? null : 'select')}
      />
    </View>
  );
  const accessoryTools = (
    <View style={{ gap: spacing[2] }}>
      <Text variant="footnote">{t('sprayLedSetup.wiringLegend')}</Text>
      <Text>
        {t('sprayLedSetup.wiringStatus', { wired: indices.size, total: leds.length, paths: wiring?.paths.length ?? 0 })}
      </Text>
      {mode === 'select' ? (
        <>
          <Text variant="footnote">{t('sprayLedSetup.wiringHint')}</Text>
          <PressableSurface
            accessibilityRole="checkbox"
            accessibilityLabel={t('sprayLedSetup.lightSelected')}
            accessibilityState={{ checked: highlight }}
            disabled={!available}
            onPress={() => {
              if (highlight) void stop();
              setHighlight(!highlight);
            }}
            style={[styles.row, { alignItems: 'center', minHeight: 44, gap: spacing[2] }]}
          >
            <View style={[styles.checkbox, { borderColor: brandColors.primary }]}>
              {highlight ? <Icon name="check.small" size={18} color={brandColors.primary} /> : null}
            </View>
            <Text>{t('sprayLedSetup.lightSelected')}</Text>
          </PressableSurface>
          {!available ? <Text variant="footnote">{t('sprayLedSetup.lightingUnavailable')}</Text> : null}
          {preview.error ? (
            <Text variant="footnote" color={brandColors.error} accessibilityLiveRegion="polite">
              {preview.error === 'invalid-indices' ? t('sprayLedSetup.lightingRangeError') : t('sprayLed.lightFailed')}
            </Text>
          ) : null}
          {selected.length ? (
            <Text accessibilityLiveRegion="polite">
              {t('sprayLedSetup.selectedLeds', { ids: selected.map((id) => indices.get(id) ?? '—').join(' → ') })}
            </Text>
          ) : null}
          {pair ? (
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
                <Button
                  title={t('sprayLedSetup.insertSkips')}
                  disabled={!edge}
                  onPress={() => setSkipText(String(gapCount || 1))}
                />
              </View>
              {gapCount ? (
                <Text color={brandColors.error}>{t('sprayLedSetup.gapLabel', { count: gapCount })}</Text>
              ) : null}
            </>
          ) : null}
          {skipText !== null ? (
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
          ) : null}
        </>
      ) : null}
    </View>
  );
  return (
    <>
      <Text>{t('sprayLedSetup.cableEditorHint')}</Text>
      {tools}
      <SprayPhotoStage
        width={width}
        tools={tools}
        accessoryTools={accessoryTools}
        overlayTools={
          <SprayUndoButton
            disabled={!canUndo}
            onPress={() => {
              undo();
              setSelected([]);
            }}
          />
        }
        canvas={{
          source,
          photoUri,
          onInteractionChange,
          mode: mode === 'draw' ? 'draw' : mode === 'select' ? 'tap' : 'pan',
          onTap: tap,
          onTrace: (points, tolerance) => extend(traceLedPath(leds, points, tolerance)),
          dragPoints: leds,
          draftColor: SPRAY_CABLE_COLOR,
          renderOverlay: (renderWidth, renderHeight, zoom, panX, panY) => (
            <SpraySetupOverlay
              holes={layout.holes}
              leds={leds}
              wiring={wiring}
              selected={mode === 'select' ? selected : undefined}
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
  const focused = useIsFocused();
  const { t } = useTranslation('boards');
  const { systemColors, spacing } = useTheme();
  return (
    <Modal
      transparent
      animationType="fade"
      visible={focused}
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}
    >
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.scrim}>
        <View
          accessibilityViewIsModal
          style={[styles.dialog, { backgroundColor: systemColors.background, padding: spacing[4], gap: spacing[3] }]}
        >
          <Text variant="headline">{t('sprayLedSetup.skipCount')}</Text>
          <BuilderTextInput
            accessibilityLabel={t('sprayLedSetup.skipCount')}
            value={value}
            onChangeText={onChange}
            keyboardType="number-pad"
            maxLength={5}
            selectTextOnFocus
          />
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
  checkbox: { width: 22, height: 22, borderWidth: 2, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  scrim: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 16, backgroundColor: 'rgba(0,0,0,0.5)' },
  dialog: { width: '100%', maxWidth: 360, borderRadius: 16 },
});
