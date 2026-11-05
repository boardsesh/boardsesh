import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  assignLedIndices,
  connectWiring,
  cutWiring,
  setWiringSkip,
  traceLedPath,
  MAX_LED_POSITIONS,
  type TnutLayout,
  type TnutPoint,
  type TnutWiring,
} from '@boardsesh/spray-wall-geometry';
import { useTheme } from '../../providers/theme-provider';
import type { SprayLookPreviewSource } from '../../lib/spray/spray-look-preview';
import { Button } from '../Button';
import { Text } from '../Text';
import { BuilderTextInput } from '../board-discovery/BoardMetaFields';
import { SprayPhotoStage } from './SprayPhotoStage';
import { SpraySetupOverlay } from './SpraySetupOverlay';

export function SprayLedMapEditor({
  layout,
  onChange,
  kind,
  source,
  photoUri,
  width,
  onInteractionChange,
}: {
  layout: TnutLayout;
  onChange: (update: Partial<TnutLayout>) => void;
  kind: 'positions' | 'wiring';
  source: SprayLookPreviewSource;
  photoUri: string;
  width: number;
  onInteractionChange: (active: boolean) => void;
}) {
  const { t } = useTranslation('boards');
  const { spacing, brandColors } = useTheme();
  const [mode, setMode] = useState<'add' | 'remove' | 'pan' | 'draw' | 'select'>(kind === 'wiring' ? 'draw' : 'add');
  const [selected, setSelected] = useState<string[]>([]);
  const [skipText, setSkipText] = useState('1');
  const [history, setHistory] = useState<TnutLayout[]>([]);
  const leds = layout.ledPositions ?? [];
  const wiring = layout.wiring;
  const indices = useMemo(
    () => new Map(wiring ? assignLedIndices(wiring).map((entry) => [entry.id, entry.index]) : []),
    [wiring],
  );
  const edge =
    selected.length === 2 &&
    Boolean(
      wiring?.paths.some((path) =>
        path.some(
          (id, index) =>
            index + 1 < path.length &&
            ((id === selected[0] && path[index + 1] === selected[1]) ||
              (id === selected[1] && path[index + 1] === selected[0])),
        ),
      ),
    );
  function change(update: Partial<TnutLayout>) {
    setHistory((previous) => [...previous.slice(-29), layout]);
    onChange(update);
  }
  function tap(point: TnutPoint, renderWidth: number, renderHeight: number) {
    let nearest = -1,
      distance = 22;
    leds.forEach((led, index) => {
      const candidate = Math.hypot((led.x - point.x) * renderWidth, (led.y - point.y) * renderHeight);
      if (candidate < distance) {
        nearest = index;
        distance = candidate;
      }
    });
    if (kind === 'wiring') {
      if (nearest < 0) return;
      const id = leds[nearest].id;
      setSelected((previous) =>
        previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous.slice(-1), id],
      );
      return;
    }
    if (mode === 'remove') {
      if (nearest < 0) return;
      change({ ledPositions: leds.filter((_, index) => index !== nearest), wiring: undefined });
    } else if (mode === 'add' && leds.length < MAX_LED_POSITIONS && distance >= 8) {
      let serial = 0;
      const ids = new Set(leds.map((led) => led.id));
      while (ids.has(`manual-${serial}`)) serial++;
      change({ ledPositions: [...leds, { ...point, id: `manual-${serial}` }], wiring: undefined });
    }
  }
  function trace(points: TnutPoint[], tolerance: number) {
    if (!wiring) return;
    const ids = traceLedPath(leds, points, tolerance);
    if (!ids.length) return;
    let next: TnutWiring = wiring;
    if (ids.length === 1 && !next.paths.some((path) => path.includes(ids[0])))
      next = { ...next, paths: [...next.paths, [ids[0]]] };
    for (let index = 1; index < ids.length; index++) next = connectWiring(next, ids[index - 1], ids[index]);
    if (next !== wiring) change({ wiring: next });
  }
  const tools = (
    <View style={{ gap: spacing[3], paddingVertical: spacing[2] }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
        {(kind === 'positions' ? (['add', 'remove', 'pan'] as const) : (['draw', 'select', 'pan'] as const)).map(
          (choice) => (
            <Button
              key={choice}
              title={
                choice === 'add'
                  ? t('sprayLedSetup.add')
                  : choice === 'remove'
                    ? t('sprayLedSetup.remove')
                    : choice === 'pan'
                      ? t('sprayLedSetup.pan')
                      : choice === 'draw'
                        ? t('sprayLedSetup.drawCable')
                        : t('sprayLedSetup.selectLeds')
              }
              variant={mode === choice ? 'filled' : 'outlined'}
              onPress={() => setMode(choice)}
            />
          ),
        )}
        <Button
          title={t('sprayLedSetup.undo')}
          variant="text"
          disabled={!history.length}
          onPress={() => {
            const previous = history.at(-1);
            if (previous) {
              onChange(previous);
              setHistory((entries) => entries.slice(0, -1));
              setSelected([]);
            }
          }}
        />
      </View>
      <Text variant="footnote">{t('sprayLedSetup.legend')}</Text>
      {kind === 'positions' ? (
        <Text>{t('sprayLedSetup.ledCount', { count: leds.length })}</Text>
      ) : (
        <>
          <Text>
            {t('sprayLedSetup.wiringStatus', {
              wired: indices.size,
              total: leds.length,
              paths: wiring?.paths.length ?? 0,
            })}
          </Text>
          <Text variant="footnote">{t('sprayLedSetup.wiringHint')}</Text>
          {selected.length ? (
            <Text accessibilityLiveRegion="polite">
              {t('sprayLedSetup.selectedLeds', {
                ids: selected
                  .map((id) =>
                    indices.has(id) ? String(indices.get(id)) : String(leds.findIndex((led) => led.id === id) + 1),
                  )
                  .join(' → '),
              })}
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
            <Button
              title={t('sprayLedSetup.cutCable')}
              disabled={!edge}
              onPress={() => {
                if (wiring) change({ wiring: cutWiring(wiring, selected[0], selected[1]) });
              }}
            />
            <Button
              title={t('sprayLedSetup.connectCable')}
              disabled={selected.length !== 2 || !wiring || connectWiring(wiring, selected[0], selected[1]) === wiring}
              onPress={() => {
                if (wiring) change({ wiring: connectWiring(wiring, selected[0], selected[1]) });
              }}
            />
          </View>
          <BuilderTextInput
            accessibilityLabel={t('sprayLedSetup.skipCount')}
            value={skipText}
            onChangeText={setSkipText}
            keyboardType="number-pad"
            maxLength={5}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
            <Button
              title={t('sprayLedSetup.insertSkips')}
              disabled={!edge || !/^\d+$/.test(skipText) || Number(skipText) < 1 || Number(skipText) > 10000}
              onPress={() => {
                if (!wiring) return;
                const previous = wiring.skips.find(
                  (skip) =>
                    (skip.from === selected[0] && skip.to === selected[1]) ||
                    (skip.from === selected[1] && skip.to === selected[0]),
                );
                change({
                  wiring: setWiringSkip(wiring, selected[0], selected[1], (previous?.count ?? 0) + Number(skipText)),
                });
              }}
            />
            <Button
              title={t('sprayLedSetup.removeSkips')}
              variant="text"
              disabled={!edge}
              onPress={() => {
                if (wiring) change({ wiring: setWiringSkip(wiring, selected[0], selected[1], 0) });
              }}
            />
          </View>
          {edge &&
          wiring?.skips.some(
            (skip) =>
              (skip.from === selected[0] && skip.to === selected[1]) ||
              (skip.from === selected[1] && skip.to === selected[0]),
          ) ? (
            <Text color={brandColors.warning}>
              {t('sprayLedSetup.gapLabel', {
                count: wiring.skips.find(
                  (skip) =>
                    (skip.from === selected[0] && skip.to === selected[1]) ||
                    (skip.from === selected[1] && skip.to === selected[0]),
                )?.count,
              })}
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
  return (
    <>
      <Text>{kind === 'positions' ? t('sprayLedSetup.editLedsHint') : t('sprayLedSetup.cableEditorHint')}</Text>
      {tools}
      <SprayPhotoStage
        width={width}
        tools={tools}
        canvas={{
          source,
          photoUri,
          mode: mode === 'pan' ? 'pan' : mode === 'draw' ? 'draw' : 'tap',
          onTap: tap,
          onTrace: trace,
          onInteractionChange,
          renderOverlay: (renderWidth, renderHeight, zoom) => (
            <SpraySetupOverlay
              holes={layout.holes}
              leds={leds}
              wiring={kind === 'wiring' ? wiring : undefined}
              selected={selected}
              width={renderWidth}
              height={renderHeight}
              zoom={zoom}
            />
          ),
        }}
      />
    </>
  );
}
