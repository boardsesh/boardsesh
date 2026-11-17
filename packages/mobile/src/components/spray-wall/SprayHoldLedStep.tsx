import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  assignLedIndices,
  buildSprayLedMapping,
  clearHoldLedLink,
  findSprayHoldAtPoint,
  ledPairs,
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
import { SprayPhotoToolButton, SprayUndoButton } from './SprayPointToolbar';
import { SpraySetupOverlay } from './SpraySetupOverlay';
import { sprayHoldRings } from './spray-hold-rings';
import { mapLedPairsById } from './spray-led-units';
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
  const { spacing, brandColors } = useTheme();
  const preview = useSprayLedPreview(wallUuid);
  const [target, setTarget] = useState<TapTarget>('holds');
  const [holdId, setHoldId] = useState<number | null>(null);
  const [selectionAttempt, setSelectionAttempt] = useState(0);
  const [freeUnitId, setFreeUnitId] = useState<string | null>(null);
  const [history, setHistory] = useState<(SprayHoldLedLink[] | undefined)[]>([]);
  const leds = layout.ledPositions ?? NO_LEDS;
  const pairs = useMemo(() => ledPairs(layout), [layout]);
  const pairsById = useMemo(() => mapLedPairsById(pairs), [pairs]);
  const rings = useMemo(() => sprayHoldRings(holds, source), [holds, source]);
  const visibleIds = useMemo(() => new Set(rings.map((ring) => ring.id)), [rings]);
  const visibleHolds = useMemo(() => holds.filter((hold) => visibleIds.has(hold.id)), [holds, visibleIds]);
  // Resolve links against the full list so hidden holds keep any manual LED ownership.
  const mapping = useMemo(() => buildSprayLedMapping(layout, source.frame, holds), [layout, source.frame, holds]);
  // This step comes before the cable, so a hold counts as linked when it has LED
  // positions, wired or not; Test LEDs later reports the wired ones.
  const unmappedHoldIds = useMemo(
    () => mapping.holds.filter((hold) => visibleIds.has(hold.holdId) && !hold.ledIds.length).map((hold) => hold.holdId),
    [mapping, visibleIds],
  );
  const ledsWithHold = useMemo(() => new Set(mapping.holds.flatMap((hold) => hold.ledIds)), [mapping]);
  const freeLeds = useMemo(() => leds.filter((led) => !ledsWithHold.has(led.id)), [leds, ledsWithHold]);
  const freeIds = useMemo(() => new Set(freeLeds.map(({ id }) => id)), [freeLeds]);
  const focusMembers = freeUnitId === null ? [] : (pairsById.get(freeUnitId) ?? [freeUnitId]);
  const unassignedMembers = focusMembers.filter((id) => freeIds.has(id));
  const focusIds = unassignedMembers.length ? [...focusMembers] : [];
  const wired = Boolean(layout.wiring?.paths.some((path) => path.length));
  const indexById = useMemo(
    () => new Map(layout.wiring ? assignLedIndices(layout.wiring).map(({ id, index }) => [id, index]) : []),
    [layout.wiring],
  );
  const entry = holdId === null ? undefined : mapping.holds.find((hold) => hold.holdId === holdId);
  const linkedByHand = holdId !== null && (layout.holdLeds ?? []).some((link) => link.holdId === holdId);

  // Preview every wired LED in a focused unit so it can be found on the wall.
  const focusIndices = focusIds
    .map((id) => indexById.get(id))
    .filter((index) => index !== undefined)
    .sort((first, second) => first - second);
  const indicesKey = (entry?.indices ?? focusIndices).join(',');
  const lastLit = useRef('');
  const { available, show, stop } = preview;
  useEffect(() => {
    const attemptKey = `${selectionAttempt}:${indicesKey}`;
    if (!available || selectionAttempt === 0 || attemptKey === lastLit.current) return;
    lastLit.current = attemptKey;
    if (indicesKey) void show(indicesKey.split(',').map(Number));
    else void stop();
  }, [available, indicesKey, selectionAttempt, show, stop]);

  function commit(next: TnutLayout) {
    setHistory((previous) => [...previous.slice(-49), layout.holdLeds]);
    onChange({ holdLeds: next.holdLeds });
  }
  function chooseHold(id: number) {
    setSelectionAttempt((attempt) => attempt + 1);
    setHoldId(id);
    setFreeUnitId(null);
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
    const hit = findSprayHoldAtPoint(visibleHolds, point, source.frame);
    if (hit === null) return;
    if (unassignedMembers.length) {
      // A partly linked pair can be found as a unit without stealing its assigned LED.
      const hitLeds = mapping.holds.find((hold) => hold.holdId === hit)?.ledIds ?? [];
      commit(setHoldLedLink(layout, hit, [...hitLeds, ...unassignedMembers]));
    }
    chooseHold(hit);
  }
  /** Holds without an LED, top to bottom and left to right, starting after the current one. */
  function nextUnmapped() {
    const order = visibleHolds
      .filter((hold) => unmappedHoldIds.includes(hold.id))
      .sort((first, second) => first.cy - second.cy || first.cx - second.cx)
      .map((hold) => hold.id);
    if (!order.length) return;
    const after = holdId === null ? -1 : order.indexOf(holdId);
    chooseHold(order[(after + 1) % order.length]);
  }
  /** Step through singles and pairs with a free LED, in the same photo order. */
  function nextFreeLed() {
    const order = [
      ...new Set(
        [...freeLeds]
          .sort((first, second) => first.y - second.y || first.x - second.x)
          .map(({ id }) => pairsById.get(id)?.[0] ?? id),
      ),
    ];
    if (!order.length) return;
    const after = freeUnitId === null ? -1 : order.indexOf(freeUnitId);
    setFreeUnitId(order[(after + 1) % order.length]);
    setSelectionAttempt((attempt) => attempt + 1);
    setHoldId(null);
    setTarget('holds');
  }
  function undo() {
    const previous = history.at(-1);
    if (!history.length) return;
    setHistory((entries) => entries.slice(0, -1));
    onChange({ holdLeds: previous ?? [] });
  }
  function resetLink() {
    if (holdId !== null) commit(clearHoldLedLink(layout, holdId));
  }

  const linked = visibleHolds.length - unmappedHoldIds.length;
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
          onPress={resetLink}
        />
        <Button title={t('sprayLedSetup.undo')} variant="text" disabled={!history.length} onPress={undo} />
      </View>
    </View>
  );
  return (
    <View style={{ gap: spacing[3] }}>
      <Text>{t('sprayLedSetup.holdLedsHint')}</Text>
      <Text variant="footnote">{t('sprayLedSetup.holdLedsSummary', { linked, total: visibleHolds.length })}</Text>
      <Text variant="footnote">
        {t('sprayLedSetup.holdLedsLedSummary', { linked: leds.length - freeLeds.length, total: leds.length })}
      </Text>
      {tools}
      <SprayPhotoStage
        width={width}
        tools={tools}
        fullScreenRail={
          <>
            <SprayPhotoToolButton
              icon={target === 'holds' ? 'lightbulb' : 'hand.raised'}
              label={t(target === 'holds' ? 'sprayLedSetup.holdLedsPickLeds' : 'sprayLedSetup.holdLedsPickHolds')}
              onPress={() => setTarget(target === 'holds' ? 'leds' : 'holds')}
            />
            <SprayPhotoToolButton
              icon="next-unmapped-hold"
              label={t('sprayLedSetup.holdLedsNextUnmapped')}
              disabled={!unmappedHoldIds.length}
              onPress={nextUnmapped}
            />
            <SprayPhotoToolButton
              icon="next-free-led"
              label={t('sprayLedSetup.holdLedsNextFreeLed')}
              disabled={!freeLeds.length}
              onPress={nextFreeLed}
            />
            <SprayPhotoToolButton
              icon="mirror"
              label={t('sprayLedSetup.holdLedsReset')}
              disabled={!linkedByHand}
              onPress={resetLink}
            />
            <SprayUndoButton disabled={!history.length} onPress={undo} />
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
              holes={[]}
              leds={leds}
              ledPairs={pairs}
              selected={entry?.ledIds ?? focusIds}
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
        {focusIds.length && !entry
          ? t(
              focusIds.length === 2
                ? 'sprayLedSetup.holdLedsFreePairSelected'
                : 'sprayLedSetup.holdLedsFreeLedSelected',
            )
          : entry
            ? t(linkedByHand ? 'sprayLedSetup.holdLedsSelectedManual' : 'sprayLedSetup.holdLedsSelected', {
                count: entry.ledIds.length,
              })
            : t('sprayLedSetup.holdLedsNoHold')}
      </Text>
      {target === 'leds' && entry ? <Text variant="footnote">{t('sprayLedSetup.holdLedsLedHint')}</Text> : null}
      {preview.error ? (
        <>
          <Text variant="footnote" color={brandColors.error} accessibilityLiveRegion="polite">
            {t('sprayLed.lightFailed')}
          </Text>
          <Button
            title={t('sprayLedSetup.retry')}
            variant="outlined"
            disabled={!available}
            onPress={() => setSelectionAttempt((attempt) => attempt + 1)}
          />
        </>
      ) : null}
      {!wired ? (
        <Text variant="footnote">{t('sprayLedSetup.holdLedsNotWired')}</Text>
      ) : !preview.available ? (
        <Text variant="footnote">{t('sprayLedSetup.lightingUnavailable')}</Text>
      ) : null}
    </View>
  );
}
