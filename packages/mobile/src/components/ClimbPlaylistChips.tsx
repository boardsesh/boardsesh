import { useTypographyStyles, type TypographyScale } from '../hooks/use-typography-styles';
import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text } from './Text';
import { useTheme } from '../providers/theme-provider';
import { usePlaylistsContextOptional } from '../providers/playlists-provider';
import { useClimbPlaylistMemberships } from '../hooks/use-climb-playlist-memberships';
import { normalizePlaylistColor, PLAYLIST_COLORS } from './playlist/playlist-colors';
import { resolvePlaylistEmojiIcon } from './playlist/playlist-icon';
import { ClimbRowReservedLine } from './ClimbRowReservedLine';
import { CLIMB_ROW_TAGS_LINE } from './climb-row-layout';
import { spacing, borderRadius } from '../theme/tokens';
import { selectByVariant } from '../theme/variants';

// A glanceable readout, not a control: show the first two playlists a climb is
// in, then a "+N" token for the rest. The full list stays reachable through the
// row's existing actions (swipe / long-press). No nested horizontal scroller —
// it would fight the row's left/right swipe gestures and cost per-row on
// FlashList recycle (HIG + M3 design review both rejected it).
const MAX_VISIBLE_CHIPS = 2;
// Lowest-priority line in the row, so cap its growth under accessibility text
// sizes rather than letting it push the row taller than the board thumbnail.
const CHIP_MAX_FONT_SCALE = CLIMB_ROW_TAGS_LINE.maxFontScale;

/** One playlist a climb is in, resolved to what its tag draws. */
export type ClimbPlaylistChip = { key: string; name: string; dotColor: string; emoji: string | null };

export type ClimbRowPlaylistChipsLeafProps = {
  climbUuid: string;
  /**
   * Hold the line's height while there is nothing to draw in it. The row asks
   * for this when it has no thumbnail: memberships load after the row has
   * painted, and nothing else would stop the row growing when they land. Left
   * out, a climb in no playlists draws nothing.
   */
  reserveLine?: boolean;
};

/**
 * Third row of a climb list item: small playlist-membership tags. Isolated and
 * `React.memo`'d over the primitive `climbUuid` (mirrors `AscentStatusGlyph`) so
 * a membership change re-renders only this strip — never the thumbnail, name, or
 * grade. Subscribes to its own climb's membership via `useClimbPlaylistMemberships`
 * and resolves names/colours from the playlists provider's `playlistsById` map.
 *
 * Whether the climber wants tags at all is the row's call, not this leaf's:
 * `ClimbListItemContent` only mounts it while the "Show playlist tags" setting is
 * on, so a row with tags off pays for none of the subscriptions here.
 *
 * Renders nothing when: no provider is mounted (e.g. a preview/test host), the
 * climb is in no playlists, or memberships haven't loaded yet. With
 * `reserveLine` it renders an empty line of the same height instead.
 */
export const ClimbPlaylistChips = React.memo(function ClimbPlaylistChips({
  climbUuid,
  reserveLine = false,
}: ClimbRowPlaylistChipsLeafProps) {
  const membership = useClimbPlaylistMemberships(climbUuid);
  const playlistsContext = usePlaylistsContextOptional();

  const playlistsById = playlistsContext?.playlistsById;

  const chips = useMemo<ClimbPlaylistChip[]>(() => {
    if (!playlistsById || membership.size === 0) return [];
    const resolved: ClimbPlaylistChip[] = [];
    let index = 0;
    for (const playlistUuid of membership) {
      const playlist = playlistsById.get(playlistUuid);
      if (!playlist) continue;
      const dotColor = normalizePlaylistColor(playlist.color) ?? PLAYLIST_COLORS[index % PLAYLIST_COLORS.length];
      resolved.push({
        key: playlistUuid,
        name: playlist.name,
        dotColor,
        emoji: resolvePlaylistEmojiIcon(playlist.icon),
      });
      index += 1;
    }
    return resolved;
  }, [membership, playlistsById]);

  return <ClimbPlaylistChipsView chips={chips} reserveLine={reserveLine} />;
});

/**
 * The tags `ClimbPlaylistChips` draws. Nothing for a climb in no playlists, or
 * with `reserveLine` an empty line as tall as a line of tags.
 * Display-only — hidden from the accessibility tree and `pointerEvents="none"`
 * so the whole row stays one clean target (membership management lives in the
 * actions sheet).
 */
export const ClimbPlaylistChipsView = React.memo(function ClimbPlaylistChipsView({
  chips,
  reserveLine = false,
}: {
  chips: readonly ClimbPlaylistChip[];
  reserveLine?: boolean;
}) {
  const styles = useTypographyStyles(createStyles);
  const { variant, systemColors, m3 } = useTheme();

  if (chips.length === 0) {
    if (!reserveLine) return null;
    // The line's own row and chip styles around a blank label, so the space held
    // is the space a tag takes, at any text size.
    return (
      <View
        style={styles.row}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID="climb-row-tags-line"
      >
        <View style={styles.chip}>
          <ClimbRowReservedLine variant="caption1" maxFontSizeMultiplier={CHIP_MAX_FONT_SCALE} style={styles.label} />
        </View>
      </View>
    );
  }

  const visibleChips = chips.slice(0, MAX_VISIBLE_CHIPS);
  const overflowCount = chips.length - visibleChips.length;

  // Quiet neutral container + a small leading colour dot — the name carries the
  // meaning, the dot is redundant colour identity (degrades gracefully when a
  // playlist has no colour, and stays readable for colour-blind users). Liquid
  // Glass uses a capsule on the system fill; Material uses an 8dp M3 chip on
  // surfaceVariant, kept distinct from the app's capsule filter pills.
  const containerColor = selectByVariant(variant, { liquidGlass: systemColors.fill, material: m3.surfaceVariant });
  const labelColor = selectByVariant(variant, {
    liquidGlass: systemColors.secondaryLabel,
    material: m3.onSurfaceVariant,
  });
  const chipRadius = selectByVariant(variant, { liquidGlass: borderRadius.full, material: borderRadius.md });

  // No mount animation: FlashList recycles cells, so a recycled row scrolling
  // back into view would replay a fade for already-known membership (a visible
  // flash). The row height is pinned by the thumbnail, or without one by the
  // line reserved above, so chips appearing causes no reflow — matches
  // `AscentStatusGlyph`, which also just appears.
  return (
    <View
      style={styles.row}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="climb-row-tags-line"
    >
      {visibleChips.map((chip) => (
        <View key={chip.key} style={[styles.chip, { backgroundColor: containerColor, borderRadius: chipRadius }]}>
          {chip.emoji ? (
            <Text variant="caption1" maxFontSizeMultiplier={CHIP_MAX_FONT_SCALE} style={styles.emoji}>
              {chip.emoji}
            </Text>
          ) : (
            <View style={[styles.dot, { backgroundColor: chip.dotColor }]} />
          )}
          <Text
            variant="caption1"
            color={labelColor}
            numberOfLines={1}
            maxFontSizeMultiplier={CHIP_MAX_FONT_SCALE}
            style={styles.label}
          >
            {chip.name}
          </Text>
        </View>
      ))}
      {overflowCount > 0 ? (
        <View style={[styles.chip, styles.overflowChip, { backgroundColor: containerColor, borderRadius: chipRadius }]}>
          <Text variant="caption1" color={labelColor} maxFontSizeMultiplier={CHIP_MAX_FONT_SCALE} style={styles.label}>
            {`+${overflowCount}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[1],
      marginTop: CLIMB_ROW_TAGS_LINE.marginTop,
      overflow: 'hidden',
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[1],
      paddingHorizontal: spacing[2],
      paddingVertical: CLIMB_ROW_TAGS_LINE.chipPaddingVertical,
      minHeight: CLIMB_ROW_TAGS_LINE.chipMinHeight,
      // Let a chip shrink so a long name ellipsizes rather than shoving the "+N"
      // token off the row.
      flexShrink: 1,
    },
    // The overflow counter never shrinks — it must always stay visible.
    overflowChip: {
      flexShrink: 0,
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: borderRadius.full,
      flexShrink: 0,
    },
    emoji: {
      fontSize: textStyles.caption1.fontSize,
    },
    label: {
      fontWeight: '500',
      flexShrink: 1,
    },
  });
