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
import { SpraySetupOverlay } from './SpraySetupOverlay';
import { sprayHoldRings } from './spray-hold-rings';
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
  const [selected, setSelected] = useState<number[]>([]);
  const mapping = useMemo(() => buildSprayLedMapping(layout, source.frame, holds), [layout, source.frame, holds]);
  const rings = useMemo(() => sprayHoldRings(holds, source.frame), [holds, source.frame]);
  const entries = kind === 'holes' ? mapping.holes : mapping.holds;
  const selection = new Set(selected);
  const chosen = entries.filter((entry) => selection.has('holeIndex' in entry ? entry.holeIndex : entry.holdId));
  const indices = [...new Set(chosen.flatMap((entry) => entry.indices))];
  const selectedLedIds = [...new Set(chosen.flatMap((entry) => entry.ledIds))];
  const selectedHoles = kind === 'holes' ? layout.holes.filter((_, index) => selection.has(index)) : [];
  const missing = chosen.filter((entry) => !entry.indices.length).length;
  const { unmappedHoles, unmappedHoldIds } = useMemo(
    () => ({
      unmappedHoles: mapping.holes.filter((hole) => !hole.indices.length).map((hole) => layout.holes[hole.holeIndex]),
      unmappedHoldIds: mapping.holds.filter((hold) => !hold.indices.length).map((hold) => hold.holdId),
    }),
    [mapping, layout.holes],
  );
  // Selecting holds or holes lights them straight away; clearing the selection turns them off.
  const indicesKey = indices.join(',');
  const lastLit = useRef('');
  const { available, show, stop } = preview;
  useEffect(() => {
    if (!available || indicesKey === lastLit.current) return;
    lastLit.current = indicesKey;
    if (indicesKey) void show(indicesKey.split(',').map(Number));
    else void stop();
  }, [available, indicesKey, show, stop]);
  // Draw what the wall shows: every LED after Light all, the LED the row-by-row
  // test has reached, or otherwise the selection's LEDs.
  const ledIdByIndex = useMemo(
    () => new Map(layout.wiring ? assignLedIndices(layout.wiring).map(({ id, index }) => [index, id]) : []),
    [layout.wiring],
  );
  const chasing = typeof preview.chaseIndex === 'number';
  const chaseLedId = typeof preview.chaseIndex === 'number' ? ledIdByIndex.get(preview.chaseIndex) : undefined;
  const litLedIds = preview.allLit
    ? (layout.ledPositions ?? []).map((led) => led.id)
    : chasing
      ? chaseLedId === undefined
        ? []
        : [chaseLedId]
      : selectedLedIds;
  /** Light all and the row test replace the selection on the wall, so they clear it on screen too. */
  function clearSelection() {
    setSelected([]);
    // An emptied selection must not switch off what is about to light.
    lastLit.current = '';
  }
  const options = [
    { key: 'holes' as const, label: t('sprayLedSetup.selectHoles') },
    { key: 'holds' as const, label: t('sprayLedSetup.selectHolds') },
  ];
  function selectKind(next: 'holes' | 'holds') {
    setKind(next);
    setSelected([]);
    lastLit.current = '';
    void preview.stop();
  }
  function tap(point: TnutPoint, photoWidth: number, photoHeight: number) {
    const id =
      kind === 'holds'
        ? findSprayHoldAtPoint(holds, point, source.frame)
        : nearestPhotoPointIndex(layout.holes, point, photoWidth, photoHeight, 18);
    if (id === null || id < 0) return;
    setSelected((previous) =>
      previous.includes(id) ? previous.filter((selectedId) => selectedId !== id) : [...previous, id],
    );
  }
  const tools = (
    <View style={{ gap: spacing[2] }}>
      <SegmentedControl
        options={options}
        selectedKey={kind}
        onSelect={selectKind}
        accessibilityLabel={t('sprayLedSetup.selectionKind')}
      />
      <Button
        title={t('sprayLedSetup.lightSelection')}
        variant="outlined"
        disabled={!preview.available || !indices.length}
        onPress={() => void preview.show(indices)}
      />
      <Button
        title={t('sprayLedSetup.lightingStop')}
        variant="text"
        disabled={!preview.available}
        onPress={() => void preview.stop()}
      />
    </View>
  );
  return (
    <View style={{ gap: spacing[3] }}>
      <Text variant="footnote">{t('sprayLedSetup.mappingHint')}</Text>
      <Text variant="footnote">
        {t('sprayLedSetup.mappingSummary', {
          mapped: mapping.holds.filter((hold) => hold.indices.length).length,
          total: holds.length,
        })}
      </Text>
      {tools}
      <SprayPhotoStage
        width={width}
        tools={tools}
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
              selectedHoles={selectedHoles}
              holdRings={kind === 'holds' ? rings : undefined}
              selectedHoldIds={kind === 'holds' ? selected : []}
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
          ? t('sprayLedSetup.allLitSummary', { count: layout.ledPositions?.length ?? 0 })
          : t('sprayLedSetup.selectionSummary', { count: selected.length, leds: indices.length })}
      </Text>
      {missing ? (
        <Text variant="footnote" color={brandColors.error} accessibilityLiveRegion="polite">
          {t('sprayLedSetup.selectionUnmapped', { count: missing })}
        </Text>
      ) : null}
      <Text variant="footnote">{t('sprayLedSetup.lightingHint')}</Text>
      {!preview.available ? <Text variant="footnote">{t(preview.unavailableMessage)}</Text> : null}
      <Button
        title={preview.allLit ? t('sprayLed.turnOff') : t('sprayLed.lightAll')}
        variant="outlined"
        disabled={!preview.available}
        onPress={() => {
          if (preview.allLit) {
            void preview.stop();
            return;
          }
          clearSelection();
          void preview.lightAll();
        }}
      />
      <Button
        title={t('sprayLedSetup.lightingChase')}
        variant="outlined"
        disabled={!preview.available || orderedIndices.length === 0}
        onPress={() => {
          clearSelection();
          void preview.chase(orderedIndices);
        }}
      />
      {preview.state !== 'idle' ? (
        <Text variant="footnote" accessibilityLiveRegion="polite">
          {preview.state === 'chasing'
            ? t('sprayLedSetup.lightingChasing')
            : preview.state === 'lit'
              ? t('sprayLed.lit')
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
