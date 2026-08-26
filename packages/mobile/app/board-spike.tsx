import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useProfile } from '../src/lib/graphql/hooks';
import { SpikeBoard } from '../src/components/board-spike/SpikeBoard';
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
 * Dev- and tester-only spike screen for issue #2202 — "hard to see Grasshopper
 * board climbs".
 *
 * Renders one synthesised climb under every rendering treatment proposed in the
 * issue thread, on every board in `spike-boards.ts`, with the play-field colour
 * and the role palette as independent axes — so they can be compared on a real
 * device instead of in a mockup.
 *
 * Not reachable from app navigation. Open it with
 * `com.boardsesh.app:///board-spike`, optionally
 * `?board=<key>&treatment=<key>&field=<key>&palette=<key>&halos=auto|on|off&leds=on|off`
 * so a capture script can land directly on one cell of the matrix — every axis
 * a capture varies is on the link, because a chip cannot be pressed by `adb`.
 * (`Smooth` is the exception: it is a rendering switch nobody captures against.)
 * Three slashes: with two, the route name parses as the URL host and Expo Router
 * never matches it.
 */
export default function BoardSpikeScreen() {
  const insets = useSafeAreaInsets();
  const { data: profile, isLoading: profileLoading } = useProfile();
  const params = useLocalSearchParams<{
    board?: string;
    treatment?: string;
    field?: string;
    palette?: string;
    halos?: string;
    leds?: string;
  }>();

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

  const [background, setBackground] = useState<SpikeBackgroundKey>(backgroundKeyOf(params.field) ?? 'field');
  const [palette, setPalette] = useState<SpikePaletteKey>(paletteKeyOf(params.palette) ?? 'shipped');
  const [smooth, setSmooth] = useState(true);
  const [halosOverride, setHalosOverride] = useState<SpikeOverride>(overrideOf(params.halos) ?? 'auto');
  // On by default and on in every captured arm, the baseline included. It is a
  // layer over the board's own art rather than a way of marking a lit hold, so
  // holding it constant is what keeps the arms one variable apart — see the
  // baseline treatment's note.
  const [leds, setLeds] = useState(switchOf(params.leds) ?? true);

  // Expo Router reuses this screen when the same route is deep-linked again, so
  // the useState initialisers above only ever run once per JS launch. Without
  // this the capture script's second `?board=…&treatment=…` link would be a
  // silent no-op and every shot after the first would be of the same cell.
  //
  // An axis the link leaves out keeps whatever it has, so pressing a chip and
  // then deep-linking another board holds the rest of the matrix still. The
  // cost is that a run varying `field` leaves the screen on that field: the
  // next run has to name the field it wants, which is what `capture-boards.sh`
  // does.
  useEffect(() => {
    const nextBoard = SPIKE_BOARDS.findIndex((option) => option.key === params.board);
    if (nextBoard >= 0) setBoardIndex(nextBoard);
    const nextTreatment = SPIKE_TREATMENTS.findIndex((option) => option.key === params.treatment);
    if (nextTreatment >= 0) setTreatmentIndex(nextTreatment);
    const nextBackground = backgroundKeyOf(params.field);
    if (nextBackground !== undefined) setBackground(nextBackground);
    const nextPalette = paletteKeyOf(params.palette);
    if (nextPalette !== undefined) setPalette(nextPalette);
    const nextHalos = overrideOf(params.halos);
    if (nextHalos !== undefined) setHalosOverride(nextHalos);
    const nextLeds = switchOf(params.leds);
    if (nextLeds !== undefined) setLeds(nextLeds);
  }, [params.board, params.treatment, params.field, params.palette, params.halos, params.leds]);

  const board = SPIKE_BOARDS[boardIndex];
  const treatment = SPIKE_TREATMENTS[treatmentIndex];
  const backgroundColor = SPIKE_BACKGROUNDS.find((option) => option.key === background)?.color ?? '#181225';

  const step = (delta: number) =>
    setTreatmentIndex((index) => (index + delta + SPIKE_TREATMENTS.length) % SPIKE_TREATMENTS.length);

  // Same audience as the More tab's Development section: `__DEV__ || isTester`.
  // Not being in the navigation tree is not a guard — a deep link reaches this
  // route directly in any build — and this screen is an unfinished experiment,
  // not something to hand a climber. In dev the profile query may never resolve
  // (no session), so `__DEV__` short-circuits ahead of it; elsewhere wait for
  // the profile before deciding, or a tester gets bounced on a cold open.
  if (!__DEV__) {
    if (profileLoading) {
      return (
        <>
          <Stack.Screen options={{ headerShown: false }} />
          <View style={[styles.screen, styles.loading]}>
            <ActivityIndicator />
          </View>
        </>
      );
    }
    if (!profile?.isTester) return <Redirect href="/(tabs)/profile/more" />;
  }

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
          backgroundColor={backgroundColor}
          palette={palette}
          smooth={smooth}
          halosOverride={halosOverride}
          leds={leds}
        />

        <View style={[styles.controls, { paddingBottom: insets.bottom + spacing[2] }]}>
          <View style={styles.row}>
            <SpikeChip label="◀  Previous" selected={false} onPress={() => step(-1)} />
            <SpikeChip label="Next  ▶" selected onPress={() => step(1)} />
            <SpikeChip label="Smooth" selected={smooth} onPress={() => setSmooth((on) => !on)} />
            <SpikeChip label={`LEDs: ${leds ? 'on' : 'off'}`} selected={leds} onPress={() => setLeds((on) => !on)} />
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
            {/* Off the label record rather than a literal, so a palette added to
                `spike-config.ts` gets a chip instead of being deep-link-only. */}
            {(Object.keys(SPIKE_PALETTE_LABEL) as SpikePaletteKey[]).map((key) => (
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

/*
 * Deep-link values for the axes that are not an index into a list. Each returns
 * `undefined` when the parameter is absent or is not one of the keys, so a typo
 * in a capture URL leaves the axis alone instead of resolving to another cell.
 */
function backgroundKeyOf(value: string | undefined): SpikeBackgroundKey | undefined {
  return SPIKE_BACKGROUNDS.find((option) => option.key === value)?.key;
}

function paletteKeyOf(value: string | undefined): SpikePaletteKey | undefined {
  // The label record is keyed by SpikePaletteKey, so it stays exhaustive when a
  // palette is added.
  const paletteKeys = Object.keys(SPIKE_PALETTE_LABEL) as SpikePaletteKey[];
  return paletteKeys.find((key) => key === value);
}

function overrideOf(value: string | undefined): SpikeOverride | undefined {
  return (['auto', 'on', 'off'] as const).find((key) => key === value);
}

/** Two-state axes take the same on/off words as the three-state ones. */
function switchOf(value: string | undefined): boolean | undefined {
  if (value === 'on') return true;
  if (value === 'off') return false;
  return undefined;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0F0B16',
  },
  loading: {
    alignItems: 'center',
    justifyContent: 'center',
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
