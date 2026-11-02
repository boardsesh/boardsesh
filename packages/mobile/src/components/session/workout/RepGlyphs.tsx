// One glyph per go on a climb (#6903): a tick for a send, a bolt for a flash,
// an open circle for an attempt, and a dash for a planned rep nobody logged.
// Decorative: the row it sits in says the same in words.

import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Icon } from '../../Icon';
import { type IconName } from '../../icon-map';
import { useTheme } from '../../../providers/theme-provider';
import type { WorkoutRepOutcome } from './types';

const GLYPH_SIZE = 14;

type GlyphKind = WorkoutRepOutcome | 'unlogged';

const GLYPH_ICON: Record<GlyphKind, IconName> = {
  flash: 'flash',
  send: 'tick',
  attempt: 'circle',
  unlogged: 'minus',
};

export const RepGlyph = memo(function RepGlyph({ kind }: { kind: GlyphKind }) {
  const { brandColors, systemColors } = useTheme();
  const color =
    kind === 'flash' || kind === 'send'
      ? brandColors.primary
      : kind === 'attempt'
        ? systemColors.secondaryLabel
        : systemColors.tertiaryLabel;
  return <Icon name={GLYPH_ICON[kind]} size={GLYPH_SIZE} color={color} />;
});

/** The reps logged, then a dash for each planned rep still unlogged. */
export const RepGlyphs = memo(function RepGlyphs({
  reps,
  planned = reps.length,
}: {
  reps: readonly WorkoutRepOutcome[];
  planned?: number;
}) {
  const unlogged = Math.max(0, planned - reps.length);
  return (
    <View style={styles.row} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {reps.map((rep, index) => (
        // Reps are positional and never reorder: the index is the identity.
        <RepGlyph key={`rep-${index}`} kind={rep} />
      ))}
      {Array.from({ length: unlogged }, (_, index) => (
        <RepGlyph key={`unlogged-${index}`} kind="unlogged" />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
});
