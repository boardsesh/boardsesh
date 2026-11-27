import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  assignLedIndices,
  buildSprayLedMapping,
  clearTnutLedLink,
  findSprayHoldAtPoint,
  ledPairs,
  setTnutLedLink,
  setSprayHoldLedSelection,
  clearSprayHoldLedSelection,
  prepareSprayNutLedEdit,
  type CanonicalSprayHold,
  type SprayLedLinkLayer,
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
import { SpraySetupOverlay, type SprayLedAssociation } from './SpraySetupOverlay';
import { sprayHoldRings } from './spray-hold-rings';
import { mapLedPairsById } from './spray-led-units';
import { nearestPhotoPointIndex } from './tnut-corner-viewport';

type TapTarget = 'holds' | 'tnuts';
type Selection = { holdId: number } | { holeIndex: number } | null;
type LinkSnapshot = Pick<TnutLayout, 'holdLeds' | 'holdAboveLeds' | 'tnutLeds'>;
const NO_LEDS: NonNullable<TnutLayout['ledPositions']> = [];

/** Choose a hold or mounting nut, then edit its LEDs in this wizard layer. */
export function SprayHoldLedStep({
  wallUuid,
  layout,
  holds,
  source,
  photoUri,
  width,
  layer = 'primary',
  onChange,
  onInteractionChange,
}: {
  wallUuid: string;
  layout: TnutLayout;
  holds: readonly CanonicalSprayHold[];
  source: SprayLookPreviewSource;
  photoUri: string;
  width: number;
  layer?: SprayLedLinkLayer;
  onChange: (update: Partial<TnutLayout>) => void;
  onInteractionChange: (active: boolean) => void;
}) {
  const { t } = useTranslation('boards');
  const { spacing, brandColors } = useTheme();
  const { available, error, show, stop } = useSprayLedPreview(wallUuid);
  const [target, setTarget] = useState<TapTarget>('holds');
  const [selection, setSelection] = useState<Selection>(null);
  const [selectionAttempt, setSelectionAttempt] = useState(0);
  const [freeUnitId, setFreeUnitId] = useState<string | null>(null);
  const [history, setHistory] = useState<LinkSnapshot[]>([]);
  const leds = layout.ledPositions ?? NO_LEDS;
  const pairs = useMemo(() => ledPairs(layout), [layout]);
  const pairsById = useMemo(() => mapLedPairsById(pairs), [pairs]);
  const rings = useMemo(() => sprayHoldRings(holds, source), [holds, source]);
  const visibleIds = useMemo(() => new Set(rings.map((ring) => ring.id)), [rings]);
  const visibleHolds = useMemo(() => holds.filter((hold) => visibleIds.has(hold.id)), [holds, visibleIds]);
  // Hidden holds retain their manual ownership, so resolve the whole wall.
  const mapping = useMemo(() => buildSprayLedMapping(layout, source.frame, holds), [layout, source.frame, holds]);
  const holdsById = useMemo(() => new Map(mapping.holds.map((hold) => [hold.holdId, hold])), [mapping]);
  const ledsById = useMemo(() => new Map(leds.map((led) => [led.id, led])), [leds]);
  type Entry = (typeof mapping.holds)[number] | (typeof mapping.holes)[number];
  const ledIdsFor = (entry: Entry) => (layer === 'above' ? entry.aboveLedIds : entry.ledIds);
  const indicesFor = (entry: Entry) => (layer === 'above' ? entry.aboveIndices : entry.indices);
  const nutRoleKey = layer === 'above' ? 'aboveLedIds' : 'ledIds';
  const nutLinksByPoint = useMemo(
    () => new Map((layout.tnutLeds ?? []).map((link) => [`${link.hole.x}:${link.hole.y}`, link])),
    [layout.tnutLeds],
  );
  const holdLinks = layer === 'above' ? layout.holdAboveLeds : layout.holdLeds;
  const effectiveNutEntry = (holeIndex: number) => {
    return mapping.holes[holeIndex];
  };
  const selectedHoldId = selection && 'holdId' in selection ? selection.holdId : null;
  const selectedNutIndex = selection && 'holeIndex' in selection ? selection.holeIndex : null;
  const entry =
    selectedHoldId !== null
      ? holdsById.get(selectedHoldId)
      : selectedNutIndex !== null
        ? effectiveNutEntry(selectedNutIndex)
        : undefined;
  const selectedNutIndices =
    selectedHoldId !== null
      ? (holdsById.get(selectedHoldId)?.holeIndices ?? [])
      : selectedNutIndex === null
        ? []
        : [selectedNutIndex];
  const matchedHoldId = selectedHoldId ?? (selectedNutIndex === null ? null : mapping.holes[selectedNutIndex].holdId);
  const linkedByHand = Boolean(
    selectedNutIndices.some((index) => {
      const point = layout.holes[index];
      return nutLinksByPoint.get(`${point.x}:${point.y}`)?.[nutRoleKey] !== undefined;
    }) ||
    (matchedHoldId !== null && holdLinks?.some((link) => link.holdId === matchedHoldId)),
  );
  const unmappedHoldIds = mapping.holds
    .filter((hold) => visibleIds.has(hold.holdId) && !ledIdsFor(hold).length)
    .map((hold) => hold.holdId);
  const unmappedNutIndices = mapping.holes
    .filter((nut) => !ledIdsFor(effectiveNutEntry(nut.holeIndex)).length)
    .map((nut) => nut.holeIndex);
  const missing = target === 'holds' ? unmappedHoldIds.length : unmappedNutIndices.length;
  const total = target === 'holds' ? visibleHolds.length : layout.holes.length;
  const ownedIds = new Set(
    (target === 'holds' ? mapping.holds : mapping.holes.map((nut) => effectiveNutEntry(nut.holeIndex))).flatMap(
      ledIdsFor,
    ),
  );
  const freeLeds = leds.filter((led) => !ownedIds.has(led.id));
  const freeIds = new Set(freeLeds.map((led) => led.id));
  const focusMembers = freeUnitId === null ? [] : (pairsById.get(freeUnitId) ?? [freeUnitId]);
  const unassignedMembers = focusMembers.filter((id) => freeIds.has(id));
  const focusIds = unassignedMembers.length ? [...focusMembers] : [];
  const selectedLedIds = entry ? ledIdsFor(entry) : focusIds;
  const wired = Boolean(layout.wiring?.paths.some((path) => path.length));
  const indexById = useMemo(
    () => new Map(layout.wiring ? assignLedIndices(layout.wiring).map(({ id, index }) => [id, index]) : []),
    [layout.wiring],
  );
  const indicesKey = entry
    ? indicesFor(entry).join(',')
    : focusIds
        .flatMap((id) => (indexById.has(id) ? [indexById.get(id)!] : []))
        .sort((first, second) => first - second)
        .join(',');
  const lastLit = useRef('');
  useEffect(() => {
    const attemptKey = `${layer}:${selectionAttempt}:${indicesKey}`;
    if (!available || selectionAttempt === 0 || attemptKey === lastLit.current) return;
    lastLit.current = attemptKey;
    if (indicesKey) void show(indicesKey.split(',').map(Number));
    else void stop();
  }, [available, indicesKey, layer, selectionAttempt, show, stop]);
  const associations = useMemo<SprayLedAssociation[]>(() => {
    const targets =
      target === 'holds'
        ? visibleHolds.map((hold) => ({
            point: { x: hold.cx / source.frame.width, y: hold.cy / source.frame.height },
            ledIds: layer === 'above' ? holdsById.get(hold.id)?.aboveLedIds : holdsById.get(hold.id)?.ledIds,
          }))
        : mapping.holes.map((nut) => {
            return {
              point: layout.holes[nut.holeIndex],
              ledIds: layer === 'above' ? nut.aboveLedIds : nut.ledIds,
            };
          });
    return targets.flatMap(({ point, ledIds }) =>
      (ledIds ?? []).flatMap((id) => {
        const led = ledsById.get(id);
        return led ? [{ from: point, to: led }] : [];
      }),
    );
  }, [target, visibleHolds, source.frame, layer, holdsById, mapping.holes, layout.holes, ledsById]);

  function commit(next: TnutLayout) {
    setHistory((previous) => [
      ...previous.slice(-49),
      { holdLeds: layout.holdLeds, holdAboveLeds: layout.holdAboveLeds, tnutLeds: layout.tnutLeds },
    ]);
    onChange({ holdLeds: next.holdLeds ?? [], holdAboveLeds: next.holdAboveLeds ?? [], tnutLeds: next.tnutLeds ?? [] });
  }
  function choose(next: Selection) {
    setSelection(next);
    setFreeUnitId(null);
    setSelectionAttempt((attempt) => attempt + 1);
  }
  function changeTarget(next: TapTarget) {
    setTarget(next);
    choose(null);
  }
  function editLink(ledIds: readonly string[]) {
    if (selectedHoldId !== null)
      commit(setSprayHoldLedSelection(layout, source.frame, holds, selectedHoldId, ledIds, layer));
    else if (selectedNutIndex !== null)
      commit(setTnutLedLink(beforeNutEdit(selectedNutIndex), selectedNutIndex, ledIds, layer));
  }
  function beforeNutEdit(holeIndex: number) {
    return prepareSprayNutLedEdit(layout, source.frame, holds, holeIndex, layer);
  }
  function tap(point: TnutPoint, photoWidth: number, photoHeight: number) {
    // While editing, LEDs win even where a target sits underneath one. The
    // explicit Choose another action (or a blank tap) starts target selection.
    if (selection && entry) {
      const ledIndex = nearestPhotoPointIndex(leds, point, photoWidth, photoHeight, 18);
      if (ledIndex >= 0) {
        const id = leds[ledIndex].id;
        const unit = pairsById.get(id) ?? [id];
        const remove = unit.every((member) => selectedLedIds.includes(member));
        const members = new Set(unit);
        editLink(remove ? selectedLedIds.filter((ledId) => !members.has(ledId)) : [...selectedLedIds, ...unit]);
        return;
      }
    }
    if (target === 'tnuts') {
      const holeIndex = nearestPhotoPointIndex(layout.holes, point, photoWidth, photoHeight, 22);
      if (holeIndex >= 0 && unassignedMembers.length) {
        commit(
          setTnutLedLink(
            beforeNutEdit(holeIndex),
            holeIndex,
            [...ledIdsFor(effectiveNutEntry(holeIndex)), ...unassignedMembers],
            layer,
          ),
        );
      }
      choose(holeIndex >= 0 ? { holeIndex } : null);
    } else {
      const holdId = findSprayHoldAtPoint(visibleHolds, point, source.frame);
      if (holdId !== null && unassignedMembers.length) {
        const mapped = holdsById.get(holdId);
        const ids = [...(mapped ? ledIdsFor(mapped) : []), ...unassignedMembers];
        commit(setSprayHoldLedSelection(layout, source.frame, holds, holdId, ids, layer));
      }
      choose(holdId !== null ? { holdId } : null);
    }
  }
  function nextFreeLed() {
    const order = [
      ...new Set(
        [...freeLeds]
          .sort((first, second) => first.y - second.y || first.x - second.x)
          .map(({ id }) => pairsById.get(id)?.[0] ?? id),
      ),
    ];
    if (!order.length) return;
    const after = order.indexOf(freeUnitId ?? '');
    choose(null);
    setFreeUnitId(order[(after + 1) % order.length]);
  }
  function nextUnmapped() {
    if (target === 'holds') {
      const order = visibleHolds
        .filter((hold) => unmappedHoldIds.includes(hold.id))
        .sort((first, second) => first.cy - second.cy || first.cx - second.cx)
        .map((hold) => hold.id);
      if (order.length) choose({ holdId: order[(order.indexOf(selectedHoldId ?? -1) + 1) % order.length] });
    } else {
      const order = [...unmappedNutIndices].sort(
        (first, second) =>
          layout.holes[first].y - layout.holes[second].y || layout.holes[first].x - layout.holes[second].x,
      );
      if (order.length) choose({ holeIndex: order[(order.indexOf(selectedNutIndex ?? -1) + 1) % order.length] });
    }
  }
  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((entries) => entries.slice(0, -1));
    onChange({
      holdLeds: previous.holdLeds ?? [],
      holdAboveLeds: previous.holdAboveLeds ?? [],
      tnutLeds: previous.tnutLeds ?? [],
    });
  }
  function resetLink() {
    if (selectedHoldId !== null) commit(clearSprayHoldLedSelection(layout, source.frame, holds, selectedHoldId, layer));
    else if (selectedNutIndex !== null)
      commit(clearTnutLedLink(beforeNutEdit(selectedNutIndex), selectedNutIndex, layer));
  }
  const nextLabel = target === 'holds' ? t('sprayLedSetup.holdLedsNextUnmapped') : t('sprayLedSetup.holdLedsNextTnut');
  const chooseLabel =
    target === 'holds' ? t('sprayLedSetup.holdLedsChooseHold') : t('sprayLedSetup.holdLedsChooseTnut');
  const freeLabel =
    target === 'holds' ? t('sprayLedSetup.holdLedsNextFreeLed') : t('sprayLedSetup.holdLedsNextFreeTnutLed');
  const tools = (
    <View style={{ gap: spacing[2] }}>
      <SegmentedControl
        options={[
          { key: 'holds' as const, label: t('sprayLedSetup.holdLedsPickHolds') },
          { key: 'tnuts' as const, label: t('sprayLedSetup.holdLedsPickTnuts') },
        ]}
        selectedKey={target}
        onSelect={changeTarget}
        accessibilityLabel={t('sprayLedSetup.holdLedsTapTarget')}
      />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[2] }}>
        <Button title={nextLabel} variant="outlined" disabled={!missing} onPress={nextUnmapped} />
        <Button title={freeLabel} variant="outlined" disabled={!freeLeds.length} onPress={nextFreeLed} />
        <Button title={chooseLabel} variant="outlined" disabled={!selection} onPress={() => choose(null)} />
        <Button
          title={t('sprayLedSetup.holdLedsReset')}
          variant="outlined"
          disabled={!linkedByHand}
          onPress={resetLink}
        />
        <SprayUndoButton disabled={!history.length} onPress={undo} />
      </View>
    </View>
  );
  return (
    <View style={{ gap: spacing[3] }}>
      <Text>{layer === 'above' ? t('sprayLedSetup.holdLedsAboveHint') : t('sprayLedSetup.holdLedsHint')}</Text>
      <Text variant="footnote">
        {target === 'holds'
          ? t('sprayLedSetup.holdLedsSummary', { linked: total - missing, total })
          : t('sprayLedSetup.holdLedsTnutSummary', { linked: total - missing, total })}
      </Text>
      {tools}
      <SprayPhotoStage
        width={width}
        tools={tools}
        fullScreenRail={
          <>
            <SprayPhotoToolButton
              icon={target === 'holds' ? 'circle' : 'hand.raised'}
              label={target === 'holds' ? t('sprayLedSetup.holdLedsPickTnuts') : t('sprayLedSetup.holdLedsPickHolds')}
              onPress={() => changeTarget(target === 'holds' ? 'tnuts' : 'holds')}
            />
            <SprayPhotoToolButton
              icon="next-unmapped-hold"
              label={nextLabel}
              disabled={!missing}
              onPress={nextUnmapped}
            />
            <SprayPhotoToolButton
              icon="next-free-led"
              label={freeLabel}
              disabled={!freeLeds.length}
              onPress={nextFreeLed}
            />
            <SprayPhotoToolButton
              icon="hand.raised"
              label={chooseLabel}
              disabled={!selection}
              onPress={() => choose(null)}
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
              holes={target === 'tnuts' ? layout.holes : []}
              mutedHoles={
                target === 'tnuts'
                  ? mapping.holes.filter((nut) => nut.holdId !== null).map((nut) => layout.holes[nut.holeIndex])
                  : []
              }
              leds={leds}
              ledPairs={pairs}
              associations={associations}
              selected={selectedLedIds}
              selectedHoles={selectedNutIndex === null ? [] : [layout.holes[selectedNutIndex]]}
              unmappedHoles={[
                ...freeLeds,
                ...(target === 'tnuts' ? unmappedNutIndices.map((index) => layout.holes[index]) : []),
              ]}
              holdRings={target === 'holds' ? rings : undefined}
              selectedHoldIds={selectedHoldId === null ? [] : [selectedHoldId]}
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
          ? target === 'holds'
            ? t(
                focusIds.length === 2
                  ? 'sprayLedSetup.holdLedsFreePairSelected'
                  : 'sprayLedSetup.holdLedsFreeLedSelected',
              )
            : t(
                focusIds.length === 2
                  ? 'sprayLedSetup.holdLedsFreeTnutPairSelected'
                  : 'sprayLedSetup.holdLedsFreeTnutLedSelected',
              )
          : entry
            ? target === 'holds'
              ? t(linkedByHand ? 'sprayLedSetup.holdLedsSelectedManual' : 'sprayLedSetup.holdLedsSelected', {
                  count: selectedLedIds.length,
                })
              : t(linkedByHand ? 'sprayLedSetup.holdLedsTnutSelectedManual' : 'sprayLedSetup.holdLedsTnutSelected', {
                  count: selectedLedIds.length,
                })
            : target === 'holds'
              ? t('sprayLedSetup.holdLedsNoHold')
              : t('sprayLedSetup.holdLedsNoTnut')}
      </Text>
      {entry ? (
        <Text variant="footnote">
          {target === 'holds' ? t('sprayLedSetup.holdLedsLedHint') : t('sprayLedSetup.holdLedsTnutLedHint')}
        </Text>
      ) : null}
      {error ? (
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
      ) : !available ? (
        <Text variant="footnote">{t('sprayLedSetup.lightingUnavailable')}</Text>
      ) : null}
    </View>
  );
}
