import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { isValidOutlineRing } from '@boardsesh/board-art-geometry/ring';
import {
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
import { SpraySetupOverlay, type SprayHoldRing } from './SpraySetupOverlay';
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
  const rings = useMemo<SprayHoldRing[]>(
    () =>
      holds.map((hold) => {
        const outline = isValidOutlineRing(hold.outline)
          ? hold.outline
          : Array.from({ length: 64 }, (_, index) => {
              const angle = Math.floor(index / 2) * (Math.PI / 16);
              return index % 2 ? Math.sin(angle) : Math.cos(angle);
            });
        const points: TnutPoint[] = [];
        for (let index = 0; index + 1 < outline.length; index += 2)
          points.push({
            x: (hold.cx + outline[index] * hold.r) / source.frame.width,
            y: (hold.cy + outline[index + 1] * hold.r) / source.frame.height,
          });
        return { id: hold.id, points };
      }),
    [holds, source.frame],
  );
  const entries = kind === 'holes' ? mapping.holes : mapping.holds;
  const selection = new Set(selected);
  const chosen = entries.filter((entry) => selection.has('holeIndex' in entry ? entry.holeIndex : entry.holdId));
  const indices = [...new Set(chosen.flatMap((entry) => entry.indices))];
  const selectedLedIds = [...new Set(chosen.flatMap((entry) => entry.ledIds))];
  const selectedHoles = kind === 'holes' ? layout.holes.filter((_, index) => selection.has(index)) : [];
  const missing = chosen.filter((entry) => !entry.indices.length).length;
  const options = [
    { key: 'holes' as const, label: t('sprayLedSetup.selectHoles') },
    { key: 'holds' as const, label: t('sprayLedSetup.selectHolds') },
  ];
  function selectKind(next: 'holes' | 'holds') {
    setKind(next);
    setSelected([]);
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
              selected={selectedLedIds}
              selectedHoles={selectedHoles}
              holdRings={kind === 'holds' ? rings : undefined}
              selectedHoldIds={kind === 'holds' ? selected : []}
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
        {t('sprayLedSetup.selectionSummary', { count: selected.length, leds: indices.length })}
      </Text>
      {missing ? (
        <Text variant="footnote" color={brandColors.error} accessibilityLiveRegion="polite">
          {t('sprayLedSetup.selectionUnmapped', { count: missing })}
        </Text>
      ) : null}
      <Text variant="footnote">{t('sprayLedSetup.lightingHint')}</Text>
      {!preview.available ? <Text variant="footnote">{t('sprayLedSetup.lightingUnavailable')}</Text> : null}
      <Button
        title={t('sprayLed.lightAll')}
        variant="outlined"
        disabled={!preview.available}
        onPress={() => void preview.lightAll()}
      />
      <Button
        title={t('sprayLedSetup.lightingChase')}
        variant="outlined"
        disabled={!preview.available || orderedIndices.length === 0}
        onPress={() => void preview.chase(orderedIndices)}
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
