import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  assignLedIndices,
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
 * routes) follows. It runs before the cable, so the wall only lights the
 * chosen hold once a cable exists (when the climber comes back to it).
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
  // An LED with no hold, picked with "Next LED without a hold"; tapping a hold then adds it there.
  const [freeLedId, setFreeLedId] = useState<string | null>(null);
  const [history, setHistory] = useState<(SprayHoldLedLink[] | undefined)[]>([]);
  const leds = layout.ledPositions ?? NO_LEDS;
  const mapping = useMemo(() => buildSprayLedMapping(layout, source.frame, holds), [layout, source.frame, holds]);
  const rings = useMemo(() => sprayHoldRings(holds, source.frame), [holds, source.frame]);
  // This step comes before the cable, so a hold counts as linked when it has LED
  // positions, wired or not; Test LEDs later reports the wired ones.
  const unmappedHoldIds = useMemo(
    () => mapping.holds.filter((hold) => !hold.ledIds.length).map((hold) => hold.holdId),
    [mapping],
  );
  const ledsWithHold = useMemo(() => new Set(mapping.holds.flatMap((hold) => hold.ledIds)), [mapping]);
  const freeLeds = useMemo(() => leds.filter((led) => !ledsWithHold.has(led.id)), [leds, ledsWithHold]);
  // Once the LED joins a hold, it is no longer the focus.
  const focusLed = freeLedId !== null && !ledsWithHold.has(freeLedId) ? freeLedId : null;
  const wired = Boolean(layout.wiring?.paths.some((path) => path.length));
  const indexById = useMemo(
    () => new Map(layout.wiring ? assignLedIndices(layout.wiring).map(({ id, index }) => [id, index]) : []),
    [layout.wiring],
  );
  const entry = holdId === null ? undefined : mapping.holds.find((hold) => hold.holdId === holdId);
  const linkedByHand = holdId !== null && (layout.holdLeds ?? []).some((link) => link.holdId === holdId);

  // The wall shows the chosen hold's LEDs (or the chosen loose LED), so a wrong
  // link is obvious on the wall too.
  const focusIndex = focusLed === null ? undefined : indexById.get(focusLed);
  const indicesKey = entry ? entry.indices.join(',') : focusIndex === undefined ? '' : String(focusIndex);
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
    setFreeLedId(null);
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
    if (hit === null) return;
    if (focusLed !== null) {
      // "Next LED without a hold" picked this LED: the tapped hold is where it belongs.
      const hitLeds = mapping.holds.find((hold) => hold.holdId === hit)?.ledIds ?? [];
      commit(setHoldLedLink(layout, hit, [...hitLeds, focusLed]));
    }
    chooseHold(hit);
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
  /** LEDs without a hold, in the same order. Picks one and waits for the tap on its hold. */
  function nextFreeLed() {
    const order = [...freeLeds].sort((first, second) => first.y - second.y || first.x - second.x).map((led) => led.id);
    if (!order.length) return;
    const after = focusLed === null ? -1 : order.indexOf(focusLed);
    setFreeLedId(order[(after + 1) % order.length]);
    setHoldId(null);
    setTarget('holds');
  }
  function undo() {
    const previous = history.at(-1);
    if (!history.length) return;
    setHistory((entries) => entries.slice(0, -1));
    onChange({ holdLeds: previous });
  }

  const linked = mapping.holds.length - unmappedHoldIds.length;
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
          title={t('sprayLedSetup.holdLedsNextFreeLed')}
          variant="outlined"
          disabled={!freeLeds.length}
          onPress={nextFreeLed}
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
      <Text variant="footnote">{t('sprayLedSetup.holdLedsSummary', { linked, total: holds.length })}</Text>
      <Text variant="footnote">
        {t('sprayLedSetup.holdLedsLedSummary', { linked: leds.length - freeLeds.length, total: leds.length })}
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
              holes={[]}
              leds={leds}
              selected={entry?.ledIds ?? (focusLed === null ? [] : [focusLed])}
              unmappedHoles={freeLeds}
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
        {focusLed !== null && !entry
          ? t('sprayLedSetup.holdLedsFreeLedSelected')
          : entry
            ? t(linkedByHand ? 'sprayLedSetup.holdLedsSelectedManual' : 'sprayLedSetup.holdLedsSelected', {
                count: entry.ledIds.length,
              })
            : t('sprayLedSetup.holdLedsNoHold')}
      </Text>
      {target === 'leds' && entry ? <Text variant="footnote">{t('sprayLedSetup.holdLedsLedHint')}</Text> : null}
      {!wired ? (
        <Text variant="footnote">{t('sprayLedSetup.holdLedsNotWired')}</Text>
      ) : !preview.available ? (
        <Text variant="footnote">{t('sprayLedSetup.lightingUnavailable')}</Text>
      ) : null}
    </View>
  );
}
