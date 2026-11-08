import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  buildSprayLedMapping,
  clearHoldLedLink,
  findSprayHoldAtPoint,
  setHoldLedLink,
  type CanonicalSprayHold,
  type SprayHoldLedLink,
  type TnutLayout,
  type TnutPoint,
} from '@boardsesh/spray-wall-geometry';
import type { SprayLookPreviewSource } from '../../lib/spray/spray-look-preview';
import { useSprayLedPreview } from '../../lib/spray/use-spray-led-preview';
import { useTheme } from '../../providers/theme-provider';
import { Button } from '../Button';
import { SegmentedControl } from '../SegmentedControl';
import { Text } from '../Text';
import { SprayPhotoStage } from './SprayPhotoStage';
import { SpraySetupOverlay } from './SpraySetupOverlay';
import { sprayHoldRings } from './spray-hold-rings';
import { nearestPhotoPointIndex } from './tnut-corner-viewport';

type TapTarget = 'holds' | 'leds';
const NO_LEDS: NonNullable<TnutLayout['ledPositions']> = [];

/**
 * Check and fix which LEDs light each hold. The app links them from the photo
 * geometry; where that is wrong, the climber picks a hold and taps its LEDs,
 * which stores a hand-made link that every later lighting (Test LEDs and
 * routes) follows.
 */
export function SprayHoldLedStep({
  wallUuid,
  layout,
  holds,
  source,
  photoUri,
  width,
  onChange,
  onInteractionChange,
}: {
  wallUuid: string;
  layout: TnutLayout;
  holds: readonly CanonicalSprayHold[];
  source: SprayLookPreviewSource;
  photoUri: string;
  width: number;
  onChange: (update: Partial<TnutLayout>) => void;
  onInteractionChange: (active: boolean) => void;
}) {
  const { t } = useTranslation('boards');
  const { spacing } = useTheme();
  const preview = useSprayLedPreview(wallUuid);
  const [target, setTarget] = useState<TapTarget>('holds');
  const [holdId, setHoldId] = useState<number | null>(null);
  const [history, setHistory] = useState<(SprayHoldLedLink[] | undefined)[]>([]);
  const leds = layout.ledPositions ?? NO_LEDS;
  const mapping = useMemo(() => buildSprayLedMapping(layout, source.frame, holds), [layout, source.frame, holds]);
  const rings = useMemo(() => sprayHoldRings(holds, source.frame), [holds, source.frame]);
  const unmappedHoldIds = useMemo(
    () => mapping.holds.filter((hold) => !hold.indices.length).map((hold) => hold.holdId),
    [mapping],
  );
  const entry = holdId === null ? undefined : mapping.holds.find((hold) => hold.holdId === holdId);
  const linkedByHand = holdId !== null && (layout.holdLeds ?? []).some((link) => link.holdId === holdId);

  // The wall shows the chosen hold's LEDs, so a wrong link is obvious on the wall too.
  const indicesKey = entry?.indices.join(',') ?? '';
  const lastLit = useRef('');
  const { available, show, stop } = preview;
  useEffect(() => {
    if (!available || indicesKey === lastLit.current) return;
    lastLit.current = indicesKey;
    if (indicesKey) void show(indicesKey.split(',').map(Number));
    else void stop();
  }, [available, indicesKey, show, stop]);

  function commit(next: TnutLayout) {
    setHistory((previous) => [...previous.slice(-49), layout.holdLeds]);
    onChange({ holdLeds: next.holdLeds });
  }
  function chooseHold(id: number) {
    setHoldId(id);
    // Picking a hold is almost always followed by fixing its LEDs.
    setTarget('leds');
  }
  function tap(point: TnutPoint, photoWidth: number, photoHeight: number) {
    if (target === 'leds' && holdId !== null && entry) {
      const index = nearestPhotoPointIndex(leds, point, photoWidth, photoHeight, 18);
      if (index >= 0) {
        const id = leds[index].id;
        const ledIds = entry.ledIds.includes(id) ? entry.ledIds.filter((led) => led !== id) : [...entry.ledIds, id];
        commit(setHoldLedLink(layout, holdId, ledIds));
        return;
      }
    }
    // Away from any LED, a tap picks the hold under the finger.
    const hit = findSprayHoldAtPoint(holds, point, source.frame);
    if (hit !== null) chooseHold(hit);
  }
  /** Holds without an LED, top to bottom and left to right, starting after the current one. */
  function nextUnmapped() {
    const order = holds
      .filter((hold) => unmappedHoldIds.includes(hold.id))
      .sort((first, second) => first.cy - second.cy || first.cx - second.cx)
      .map((hold) => hold.id);
    if (!order.length) return;
    const after = holdId === null ? -1 : order.indexOf(holdId);
    chooseHold(order[(after + 1) % order.length]);
  }
  function undo() {
    const previous = history.at(-1);
    if (!history.length) return;
    setHistory((entries) => entries.slice(0, -1));
    onChange({ holdLeds: previous });
  }

  const mapped = mapping.holds.length - unmappedHoldIds.length;
  const tools = (
    <View style={{ gap: spacing[2] }}>
      <SegmentedControl
        options={[
          { key: 'holds' as const, label: t('sprayLedSetup.holdLedsPickHolds') },
          { key: 'leds' as const, label: t('sprayLedSetup.holdLedsPickLeds') },
        ]}
        selectedKey={target}
        onSelect={setTarget}
        accessibilityLabel={t('sprayLedSetup.holdLedsTapTarget')}
      />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
        <Button
          title={t('sprayLedSetup.holdLedsNextUnmapped')}
          variant="outlined"
          disabled={!unmappedHoldIds.length}
          onPress={nextUnmapped}
        />
        <Button
          title={t('sprayLedSetup.holdLedsReset')}
          variant="outlined"
          disabled={!linkedByHand}
          onPress={() => {
            if (holdId !== null) commit(clearHoldLedLink(layout, holdId));
          }}
        />
        <Button title={t('sprayLedSetup.undo')} variant="text" disabled={!history.length} onPress={undo} />
      </View>
    </View>
  );
  return (
    <View style={{ gap: spacing[3] }}>
      <Text>{t('sprayLedSetup.holdLedsHint')}</Text>
      <Text variant="footnote">{t('sprayLedSetup.mappingSummary', { mapped, total: holds.length })}</Text>
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
              holes={[]}
              leds={leds}
              selected={entry?.ledIds ?? []}
              holdRings={rings}
              selectedHoldIds={holdId === null ? [] : [holdId]}
              subtleLeds
              unmappedHoldIds={unmappedHoldIds}
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
        {entry
          ? t(linkedByHand ? 'sprayLedSetup.holdLedsSelectedManual' : 'sprayLedSetup.holdLedsSelected', {
              count: entry.ledIds.length,
            })
          : t('sprayLedSetup.holdLedsNoHold')}
      </Text>
      {target === 'leds' && entry ? <Text variant="footnote">{t('sprayLedSetup.holdLedsLedHint')}</Text> : null}
      {!preview.available ? <Text variant="footnote">{t('sprayLedSetup.lightingUnavailable')}</Text> : null}
    </View>
  );
}
