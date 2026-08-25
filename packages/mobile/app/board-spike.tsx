import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SpikeBoard } from '../src/components/board-spike/SpikeBoard';
import { SPIKE_ART_LABEL, SPIKE_ART_LEVELS, type SpikeArtLevel } from '../src/components/board-spike/spike-art';
import {
  SPIKE_BACKGROUNDS,
  SPIKE_PALETTE_LABEL,
  SPIKE_TREATMENTS,
  type SpikeBackgroundKey,
  type SpikePaletteKey,
} from '../src/components/board-spike/spike-config';
import { Text } from '../src/components/Text';
import { spacing } from '../src/theme/tokens';

/**
 * Dev-only spike screen for issue #2202 — "hard to see Grasshopper board climbs".
 *
 * Renders one climb on one board under every rendering treatment proposed in the
 * issue thread, with the board art, the play-field colour and the role palette as
 * independent axes, so they can be compared on a real device instead of in a
 * mockup. Not reachable from app navigation: open it with
 * `com.boardsesh.app://board-spike`.
 */
export default function BoardSpikeScreen() {
  const insets = useSafeAreaInsets();
  const [treatmentIndex, setTreatmentIndex] = useState(0);
  const [art, setArt] = useState<SpikeArtLevel>('original');
  const [background, setBackground] = useState<SpikeBackgroundKey>('field');
  const [palette, setPalette] = useState<SpikePaletteKey>('shipped');

  const treatment = SPIKE_TREATMENTS[treatmentIndex];
  const backgroundColor = SPIKE_BACKGROUNDS.find((option) => option.key === background)?.color ?? '#181225';

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.screen, { paddingTop: insets.top }]} testID="board-spike-screen">
        <View style={styles.caption}>
          <Text variant="subheadline" style={styles.captionTitle}>
            {`${treatmentIndex + 1}/${SPIKE_TREATMENTS.length}  ${treatment.label}`}
          </Text>
          <Text variant="caption1" color="#A9A2B6" numberOfLines={2}>
            {treatment.note}
          </Text>
        </View>

        <SpikeBoard treatment={treatment} art={art} backgroundColor={backgroundColor} palette={palette} />

        <View style={[styles.controls, { paddingBottom: insets.bottom + spacing[2] }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
            {SPIKE_TREATMENTS.map((option, index) => (
              <SpikeChip
                key={option.key}
                label={option.chip}
                selected={index === treatmentIndex}
                onPress={() => setTreatmentIndex(index)}
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
          </ScrollView>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
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
