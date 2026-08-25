import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SpikeBoard } from '../src/components/board-spike/SpikeBoard';
import { SPIKE_ART_LABEL, SPIKE_ART_LEVELS, type SpikeArtLevel } from '../src/components/board-spike/spike-art';
import { DEFAULT_SPIKE_BOARD_KEY, SPIKE_BOARDS } from '../src/components/board-spike/spike-boards';
import {
  SPIKE_BACKGROUNDS,
  SPIKE_PALETTE_LABEL,
  SPIKE_TREATMENTS,
  type SpikeBackgroundKey,
  type SpikeOverride,
  type SpikePaletteKey,
} from '../src/components/board-spike/spike-config';
import { Text } from '../src/components/Text';
import { spacing } from '../src/theme/tokens';

/**
 * Dev-only spike screen for issue #2202 — "hard to see Grasshopper board climbs".
 *
 * Renders one synthesised climb under every rendering treatment proposed in the
 * issue thread, on every board in `spike-boards.ts`, with the board art, the
 * play-field colour and the role palette as independent axes — so they can be
 * compared on a real device instead of in a mockup.
 *
 * Not reachable from app navigation. Open it with
 * `com.boardsesh.app:///board-spike`, optionally `?board=<key>&treatment=<key>`
 * so a capture script can land directly on one cell of the matrix. Three
 * slashes: with two, the route name parses as the URL host and Expo Router
 * never matches it.
 */
export default function BoardSpikeScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ board?: string; treatment?: string }>();

  const initialBoardIndex = Math.max(
    0,
    SPIKE_BOARDS.findIndex((option) => option.key === (params.board ?? DEFAULT_SPIKE_BOARD_KEY)),
  );
  const initialTreatmentIndex = Math.max(
    0,
    SPIKE_TREATMENTS.findIndex((option) => option.key === params.treatment),
  );

  const [boardIndex, setBoardIndex] = useState(initialBoardIndex);
  const [treatmentIndex, setTreatmentIndex] = useState(initialTreatmentIndex);

  // Expo Router reuses this screen when the same route is deep-linked again, so
  // the useState initialisers above only ever run once per JS launch. Without
  // this the capture script's second `?board=…&treatment=…` link would be a
  // silent no-op and every shot after the first would be of the same cell.
  useEffect(() => {
    const nextBoard = SPIKE_BOARDS.findIndex((option) => option.key === params.board);
    if (nextBoard >= 0) setBoardIndex(nextBoard);
    const nextTreatment = SPIKE_TREATMENTS.findIndex((option) => option.key === params.treatment);
    if (nextTreatment >= 0) setTreatmentIndex(nextTreatment);
  }, [params.board, params.treatment]);
  const [art, setArt] = useState<SpikeArtLevel>('original');
  const [background, setBackground] = useState<SpikeBackgroundKey>('field');
  const [palette, setPalette] = useState<SpikePaletteKey>('shipped');
  const [desaturate, setDesaturate] = useState(false);
  const [smooth, setSmooth] = useState(true);
  const [halosOverride, setHalosOverride] = useState<SpikeOverride>('auto');

  const board = SPIKE_BOARDS[boardIndex];
  const treatment = SPIKE_TREATMENTS[treatmentIndex];
  const backgroundColor = SPIKE_BACKGROUNDS.find((option) => option.key === background)?.color ?? '#181225';

  const step = (delta: number) =>
    setTreatmentIndex((index) => (index + delta + SPIKE_TREATMENTS.length) % SPIKE_TREATMENTS.length);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.screen, { paddingTop: insets.top }]} testID="board-spike-screen">
        <View style={styles.caption}>
          <Text variant="subheadline" style={styles.captionTitle}>
            {`${treatmentIndex + 1}/${SPIKE_TREATMENTS.length}  ${treatment.label}`}
          </Text>
          <Text variant="caption1" color="#A9A2B6" numberOfLines={2}>
            {`${board.label} · ${treatment.note}`}
          </Text>
        </View>

        <SpikeBoard
          board={board}
          treatment={treatment}
          art={art}
          backgroundColor={backgroundColor}
          palette={palette}
          desaturate={desaturate}
          smooth={smooth}
          halosOverride={halosOverride}
        />

        <View style={[styles.controls, { paddingBottom: insets.bottom + spacing[2] }]}>
          <View style={styles.row}>
            <SpikeChip label="◀  Previous" selected={false} onPress={() => step(-1)} />
            <SpikeChip label="Next  ▶" selected onPress={() => step(1)} />
            <SpikeChip label="Desat" selected={desaturate} onPress={() => setDesaturate((on) => !on)} />
            <SpikeChip label="Smooth" selected={smooth} onPress={() => setSmooth((on) => !on)} />
            <SpikeChip
              label={`Halos: ${halosOverride}`}
              selected={halosOverride !== 'auto'}
              onPress={() =>
                setHalosOverride((current) => (current === 'auto' ? 'on' : current === 'on' ? 'off' : 'auto'))
              }
            />
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
            {SPIKE_BOARDS.map((option, index) => (
              <SpikeChip
                key={option.key}
                label={option.label}
                selected={index === boardIndex}
                onPress={() => setBoardIndex(index)}
              />
            ))}
          </ScrollView>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
            {SPIKE_ART_LEVELS.map((level) => (
              <SpikeChip
                key={level}
                label={SPIKE_ART_LABEL[level]}
                selected={level === art}
                onPress={() => setArt(level)}
              />
            ))}
            {(['shipped', 'equalL'] as const).map((key) => (
              <SpikeChip
                key={key}
                label={SPIKE_PALETTE_LABEL[key]}
                selected={key === palette}
                onPress={() => setPalette(key)}
              />
            ))}
            {SPIKE_BACKGROUNDS.map((option) => (
              <SpikeChip
                key={option.key}
                label={option.label}
                swatch={option.color}
                selected={option.key === background}
                onPress={() => setBackground(option.key)}
              />
            ))}
          </ScrollView>
        </View>
      </View>
    </>
  );
}

function SpikeChip({
  label,
  selected,
  swatch,
  onPress,
}: {
  label: string;
  selected: boolean;
  swatch?: string;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.chip, selected && styles.chipSelected]}>
      {swatch !== undefined && <View style={[styles.swatch, { backgroundColor: swatch }]} />}
      <Text variant="caption1" color={selected ? '#0F0B16' : '#E9E4F5'}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0F0B16',
  },
  caption: {
    // Right inset keeps the note clear of the dev client's floating menu button,
    // which sits over this corner on every screen.
    paddingLeft: spacing[3],
    paddingRight: 96,
    paddingVertical: spacing[2],
    gap: 2,
  },
  captionTitle: {
    color: '#F5F2FB',
    fontWeight: '600',
  },
  controls: {
    paddingTop: spacing[2],
    gap: spacing[2],
  },
  row: {
    flexDirection: 'row',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(180, 168, 205, 0.4)',
    backgroundColor: 'rgba(199, 184, 232, 0.12)',
  },
  chipSelected: {
    backgroundColor: '#A78BFA',
    borderColor: '#A78BFA',
  },
  swatch: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.5)',
  },
});
