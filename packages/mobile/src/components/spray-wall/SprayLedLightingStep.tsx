import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  assignLedIndices,
  buildSprayLedMapping,
  findSprayHoldAtPoint,
  type CanonicalSprayHold,
  type TnutLayout,
  type TnutPoint,
} from '@boardsesh/spray-wall-geometry';
import type { SprayLookPreviewSource } from '../../lib/spray/spray-look-preview';
import { useSprayLedPreview } from '../../lib/spray/use-spray-led-preview';
import { useTheme } from '../../providers/theme-provider';
import { Button } from '../Button';
import { Text } from '../Text';
import { SegmentedControl } from '../SegmentedControl';
import { SprayPhotoStage } from './SprayPhotoStage';
import { SprayPhotoToolButton } from './SprayPointToolbar';
import { SpraySetupOverlay } from './SpraySetupOverlay';
import { sprayHoldRings } from './spray-hold-rings';
import { sprayPhotoCoverage } from './spray-photo-coverage';
import { nearestPhotoPointIndex } from './tnut-corner-viewport';

export function SprayLedLightingStep({
  wallUuid,
  orderedIndices,
  layout,
  holds,
  source,
  photoUri,
  width,
  onInteractionChange,
}: {
  wallUuid: string;
  orderedIndices: readonly number[];
  layout: TnutLayout;
  holds: readonly CanonicalSprayHold[];
  source: SprayLookPreviewSource;
  photoUri: string;
  width: number;
  onInteractionChange: (active: boolean) => void;
}) {
  const { t } = useTranslation('boards');
  const { spacing, brandColors } = useTheme();
  const preview = useSprayLedPreview(wallUuid);
  const [kind, setKind] = useState<'holes' | 'holds'>('holes');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectionLighting, setSelectionLighting] = useState(true);
  const mapping = useMemo(() => buildSprayLedMapping(layout, source.frame, holds), [layout, source.frame, holds]);
  const rings = useMemo(() => sprayHoldRings(holds, source), [holds, source]);
  const visibleIds = useMemo(() => new Set(rings.map((ring) => ring.id)), [rings]);
  const visibleHolds = useMemo(() => holds.filter((hold) => visibleIds.has(hold.id)), [holds, visibleIds]);
  const entries = kind === 'holes' ? mapping.holes : mapping.holds;
  const chosen = entries.find((entry) => ('holeIndex' in entry ? entry.holeIndex : entry.holdId) === selectedId);
  const indices = chosen?.indices ?? [];
  const selectedHole = kind === 'holes' && selectedId !== null ? layout.holes[selectedId] : undefined;
  const missing = Boolean(chosen && !indices.length);
  const { unmappedHoles, unmappedHoldIds } = useMemo(
    () => ({
      unmappedHoles: mapping.holes.filter((hole) => !hole.indices.length).map((hole) => layout.holes[hole.holeIndex]),
      unmappedHoldIds: mapping.holds
        .filter((hold) => visibleIds.has(hold.holdId) && !hold.indices.length)
        .map((hold) => hold.holdId),
    }),
    [mapping, layout.holes, visibleIds],
  );
  // Selecting holds or holes lights them straight away; clearing the selection turns them off.
  const indicesKey = selectionLighting ? indices.join(',') : '';
  const lastLit = useRef('');
  const { available, show, stop } = preview;
  useEffect(() => {
    if (!available || indicesKey === lastLit.current) return;
    lastLit.current = indicesKey;
    if (indicesKey) void show(indicesKey.split(',').map(Number));
    else void stop();
  }, [available, indicesKey, show, stop]);
  const visibleWiredLeds = useMemo(() => {
    if (!layout.wiring) return [];
    const onPhoto = sprayPhotoCoverage(source);
    const { width: frameWidth, height: frameHeight } = source.frame;
    const visible = new Set(
      (layout.ledPositions ?? []).filter(({ x, y }) => onPhoto(x * frameWidth, y * frameHeight)).map(({ id }) => id),
    );
    return assignLedIndices(layout.wiring).filter(({ id }) => visible.has(id));
  }, [layout.ledPositions, layout.wiring, source]);
  const ledIdByIndex = useMemo(() => new Map(visibleWiredLeds.map(({ id, index }) => [index, id])), [visibleWiredLeds]);
  const visibleChaseIndices = orderedIndices.filter((index) => ledIdByIndex.has(index));
  const chasing = typeof preview.chaseIndex === 'number';
  const testingStrip = preview.allLit || preview.state === 'chasing';
  const chaseLedId = typeof preview.chaseIndex === 'number' ? ledIdByIndex.get(preview.chaseIndex) : undefined;
  const litLedIds = preview.allLit
    ? visibleWiredLeds.map(({ id }) => id)
    : chasing
      ? chaseLedId === undefined
        ? []
        : [chaseLedId]
      : selectionLighting
        ? (chosen?.ledIds ?? [])
        : [];
  /** Light all and the row test replace the selection on the wall, so they clear it on screen too. */
  function clearSelection() {
    setSelectedId(null);
    // An emptied selection must not switch off what is about to light.
    lastLit.current = '';
  }
  const options = [
    { key: 'holes' as const, label: t('sprayLedSetup.selectHoles') },
    { key: 'holds' as const, label: t('sprayLedSetup.selectHolds') },
  ];
  function selectKind(next: 'holes' | 'holds') {
    if (next === kind) return;
    setKind(next);
    clearSelection();
    void preview.stop();
  }
  function toggleLighting() {
    if (selectionLighting || testingStrip || preview.state === 'sending') {
      lastLit.current = '';
      void preview.stop();
      setSelectionLighting(false);
    } else {
      setSelectionLighting(true);
    }
  }
  function tap(point: TnutPoint, photoWidth: number, photoHeight: number) {
    const id =
      kind === 'holds'
        ? findSprayHoldAtPoint(visibleHolds, point, source.frame)
        : nearestPhotoPointIndex(layout.holes, point, photoWidth, photoHeight, 18);
    if (id === null || id < 0) return;
    // A tap during a full-wall test replaces that test, even with an unwired selection.
    if (testingStrip || preview.state === 'sending') {
      const tapped = entries.find((entry) => ('holeIndex' in entry ? entry.holeIndex : entry.holdId) === id);
      if ((!selectionLighting || !tapped?.indices.length) && !lastLit.current) void stop();
    }
    setSelectedId((previous) => (previous === id ? null : id));
  }
  const bulbOn = selectionLighting || testingStrip;
  const lightbulb = (
    <SprayPhotoToolButton
      icon={bulbOn ? 'lightbulb.fill' : 'lightbulb.slash'}
      label={t(bulbOn ? 'sprayLedSetup.lightingStop' : 'sprayLedSetup.lightSelection')}
      selected={bulbOn}
      onPress={toggleLighting}
    />
  );
  const tools = (
    <View style={{ gap: spacing[2], flexDirection: 'row', alignItems: 'center' }}>
      <View style={{ flex: 1 }}>
        <SegmentedControl
          options={options}
          selectedKey={kind}
          onSelect={selectKind}
          accessibilityLabel={t('sprayLedSetup.selectionKind')}
        />
      </View>
      {lightbulb}
    </View>
  );
  return (
    <View style={{ gap: spacing[3] }}>
      <Text variant="footnote">{t('sprayLedSetup.mappingHint')}</Text>
      <Text variant="footnote">
        {t('sprayLedSetup.mappingSummary', {
          mapped: mapping.holds.filter((hold) => visibleIds.has(hold.holdId) && hold.indices.length).length,
          total: visibleHolds.length,
        })}
      </Text>
      {tools}
      <SprayPhotoStage
        width={width}
        tools={tools}
        fullScreenRail={
          <>
            <SprayPhotoToolButton
              icon={kind === 'holes' ? 'hand.raised' : 'circle'}
              label={t(kind === 'holes' ? 'sprayLedSetup.selectHolds' : 'sprayLedSetup.selectHoles')}
              onPress={() => selectKind(kind === 'holes' ? 'holds' : 'holes')}
            />
            {lightbulb}
          </>
        }
        canvas={{
          source,
          photoUri,
          mode: 'tap',
          onTap: tap,
          onInteractionChange,
          renderOverlay: (photoWidth, photoHeight, zoom, panX, panY) => (
            <SpraySetupOverlay
              holes={kind === 'holes' ? layout.holes : []}
              leds={layout.ledPositions}
              selected={litLedIds}
              selectedHoles={selectedHole ? [selectedHole] : []}
              holdRings={kind === 'holds' ? rings : undefined}
              selectedHoldIds={kind === 'holds' && selectedId !== null ? [selectedId] : []}
              subtleLeds
              unmappedHoles={kind === 'holes' ? unmappedHoles : []}
              unmappedHoldIds={kind === 'holds' ? unmappedHoldIds : []}
              width={photoWidth}
              height={photoHeight}
              zoom={zoom}
              panX={panX}
              panY={panY}
            />
          ),
        }}
      />
      <Text variant="footnote" accessibilityLiveRegion="polite">
        {preview.allLit
          ? t('sprayLedSetup.allLitSummary', { count: visibleWiredLeds.length })
          : t('sprayLedSetup.selectionSummary', { count: chosen ? 1 : 0, leds: indices.length })}
      </Text>
      {missing ? (
        <Text variant="footnote" color={brandColors.error} accessibilityLiveRegion="polite">
          {t('sprayLedSetup.selectionUnmapped', { count: 1 })}
        </Text>
      ) : null}
      <Text variant="footnote">{t('sprayLedSetup.lightingHint')}</Text>
      {!preview.available ? <Text variant="footnote">{t('sprayLedSetup.lightingUnavailable')}</Text> : null}
      <Button
        title={preview.allLit ? t('sprayLed.turnOff') : t('sprayLedSetup.lightWired')}
        variant="outlined"
        disabled={!preview.available || visibleWiredLeds.length === 0}
        onPress={() => {
          if (preview.allLit) {
            void preview.stop();
            return;
          }
          clearSelection();
          void preview.lightAll(visibleWiredLeds.map(({ index }) => index));
        }}
      />
      <Button
        title={t('sprayLedSetup.lightingChase')}
        variant="outlined"
        disabled={!preview.available || visibleChaseIndices.length === 0}
        onPress={() => {
          clearSelection();
          void preview.chase(visibleChaseIndices);
        }}
      />
      {preview.state !== 'idle' && !preview.allLit ? (
        <Text variant="footnote" accessibilityLiveRegion="polite">
          {preview.state === 'chasing'
            ? t('sprayLedSetup.lightingChasing')
            : preview.state === 'lit'
              ? t('sprayLedSetup.lightingSelected')
              : t('sprayLed.sending')}
        </Text>
      ) : null}
      {preview.error ? (
        <Text variant="footnote" color={brandColors.error} accessibilityLiveRegion="polite">
          {preview.error === 'invalid-indices' ? t('sprayLedSetup.lightingRangeError') : t('sprayLed.lightFailed')}
        </Text>
      ) : null}
    </View>
  );
}
