import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';
import { Text } from './Text';
import { useTheme } from '../providers/theme-provider';
import { usePlaylistsContextOptional } from '../providers/playlists-provider';
import { useClimbPlaylistMemberships } from '../hooks/use-climb-playlist-memberships';
import { useShowPlaylistTagsPreference } from '../lib/show-playlist-tags-preference';
import { normalizePlaylistColor, PLAYLIST_COLORS } from './playlist/playlist-colors';
import { resolvePlaylistEmojiIcon } from './playlist/playlist-icon';
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
const CHIP_MAX_FONT_SCALE = 1.3;

type ResolvedPlaylistChip = { key: string; name: string; dotColor: string; emoji: string | null };

/**
 * Turn a climb's playlist UUIDs into renderable chips against the playlists
 * provider's `uuid → Playlist` index — O(membership), never a scan of the whole
 * playlist array. UUIDs with no matching playlist (a stale membership, another
 * board's list) are dropped.
 */
function resolvePlaylistChips(
  playlistUuids: Iterable<string>,
  playlistsById: Map<string, Playlist> | undefined,
): ResolvedPlaylistChip[] {
  if (!playlistsById) return [];
  const resolved: ResolvedPlaylistChip[] = [];
  let index = 0;
  for (const playlistUuid of playlistUuids) {
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
}

type PlaylistChipsRowProps = {
  /** The playlist UUIDs to show. Pass a reference-stable value (the membership
   *  store's `Set`, or a React Query cache array) — it is a memo dependency. */
  playlistUuids: Iterable<string>;
  /** `start` for a left-aligned list row, `center` for a centered detail header. */
  align?: 'start' | 'center';
  /**
   * Builds the VoiceOver label for the whole strip from every playlist name,
   * including the ones the "+N" token hides. Omit (the list-row default) to hide
   * the chips from the accessibility tree, keeping the row one clean target; pass
   * one on a detail surface, where membership is information the climber would
   * otherwise never hear.
   *
   * A formatter rather than a finished string so the caller doesn't have to
   * resolve the names a second time, and so the translation lookup it needs stays
   * out of this component — which renders once per visible list row.
   */
  describeForAccessibility?: (playlistNames: string[]) => string;
};

/**
 * The chips themselves: up to two playlist tags plus a "+N" token. Presentational
 * and membership-source-agnostic, so the climb list (fed by the shared external
 * store) and the play drawer (fed by a per-climb React Query fetch) render
 * identical strips.
 *
 * Renders nothing when no playlists provider is mounted (e.g. a preview/test
 * host), the climb is in no playlists, or memberships haven't loaded yet.
 * Display-only: `pointerEvents="none"` so it never steals a tap from its host.
 */
export const PlaylistChipsRow = React.memo(function PlaylistChipsRow({
  playlistUuids,
  align = 'start',
  describeForAccessibility,
}: PlaylistChipsRowProps) {
  const playlistsContext = usePlaylistsContextOptional();
  const { variant, systemColors, m3 } = useTheme();

  const playlistsById = playlistsContext?.playlistsById;

  const chips = useMemo(() => resolvePlaylistChips(playlistUuids, playlistsById), [playlistUuids, playlistsById]);

  if (chips.length === 0) return null;

  const accessibilityLabel = describeForAccessibility?.(chips.map((chip) => chip.name));
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
  // flash). The row height is pinned by the thumbnail, so chips appearing causes
  // no reflow — matches `AscentStatusGlyph`, which also just appears.
  return (
    <View
      style={[styles.row, align === 'center' ? styles.rowCentered : null]}
      pointerEvents="none"
      accessible={accessibilityLabel != null}
      accessibilityLabel={accessibilityLabel}
      accessibilityElementsHidden={accessibilityLabel == null}
      importantForAccessibility={accessibilityLabel == null ? 'no-hide-descendants' : 'yes'}
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

/**
 * Third row of a climb list item: small playlist-membership tags. Isolated and
 * `React.memo`'d over the primitive `climbUuid` (mirrors `AscentStatusGlyph`) so
 * a membership change re-renders only this strip — never the thumbnail, name, or
 * grade. Subscribes to its own climb's membership via `useClimbPlaylistMemberships`,
 * which the Climbs tab feeds in bulk through `useClimbListPlaylistMemberships`.
 *
 * Gated on the opt-in "Show playlist tags" setting. That gate is list-scoped by
 * design: chips add a third line to every row, a density cost a detail header
 * doesn't carry — the play drawer shows its chips unconditionally, via
 * `PlayDrawerPlaylistChips`.
 */
export const ClimbPlaylistChips = React.memo(function ClimbPlaylistChips({ climbUuid }: { climbUuid: string }) {
  const { enabled } = useShowPlaylistTagsPreference();
  const membership = useClimbPlaylistMemberships(climbUuid);

  if (!enabled) return null;

  return <PlaylistChipsRow playlistUuids={membership} />;
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    marginTop: spacing[1],
    overflow: 'hidden',
  },
  // Detail surfaces (the play-drawer header) centre their column; list rows keep
  // the default leading alignment.
  rowCentered: {
    justifyContent: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    minHeight: 20,
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
    fontSize: 12,
  },
  label: {
    fontWeight: '500',
    flexShrink: 1,
  },
});
