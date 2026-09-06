import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PlaylistChipsRow } from '../ClimbPlaylistChips';
import { useClimbPlaylistMemberships } from '../../hooks/use-climb-playlist-memberships';
import { useClimbPlaylistMembershipQuery } from '../../hooks/use-climb-playlist-membership-query';
import { usePlaylistsContextOptional } from '../../providers/playlists-provider';
import { hasPlaylistForBoard } from '../../lib/sort-filter-playlists';
import { iosSystemColors } from '../../theme/ios-colors';

/**
 * How many playlists get named here before the rest collapse into "+N". One, not
 * the list row's two: these tags share the stats line with sends, quality and
 * setter, and two full names would ellipsize both to noise.
 */
const HEADER_MAX_VISIBLE_CHIPS = 1;

type PlayDrawerPlaylistChipsProps = {
  climbUuid: string;
  boardName: string;
  layoutId: number;
  /**
   * Whether this header may fetch membership. True for the climb on screen;
   * false for the swipe "peek" header, whose climb changes continuously during a
   * fling — firing a request per peek would spray one per climb passed. The peek
   * still paints from the cache/seed, and the stats row it rides is a fixed
   * height either way, so nothing shifts as the swipe settles.
   */
  fetchMembership: boolean;
};

/**
 * Playlist-membership tags in the play drawer, riding the header's stats line.
 *
 * Not the list variant. `ClimbPlaylistChips` reads the shared
 * `playlistMembershipStore`, which is written by exactly one hook
 * (`useClimbListPlaylistMemberships`) running on the Climbs tab — so a drawer
 * opened from the queue, from a playlist, or from a deep link would render an
 * empty strip forever. This variant seeds from the store (instant when the
 * climber did come from the Climbs tab) and confirms with its own per-climb
 * fetch, sharing the query key the add-to-playlist picker writes to.
 *
 * Costs the board art nothing. The drawer's first screen is a FIXED height with
 * the board `flex: 1` inside it, so every point the header takes comes straight
 * off the board — which is why these tags do NOT get a line of their own, and are
 * not capsules. They render as `caption1` text inside the existing
 * "42 sends · 3.2★ · setter" line, in that line's own grey, so the row is exactly
 * one caption tall whether the climb is in a playlist or not. See
 * `STATS_ROW_MARGIN_TOP` in `PlayDrawerHeader` for the full budget.
 *
 * Shown unconditionally: the "Show playlist tags" setting is list-scoped, gating
 * a third line on every row, and a header that adds no line carries no such
 * density cost.
 */
export const PlayDrawerPlaylistChips = memo(function PlayDrawerPlaylistChips({
  climbUuid,
  boardName,
  layoutId,
  fetchMembership,
}: PlayDrawerPlaylistChipsProps) {
  const { t } = useTranslation('climbs');
  const playlistsContext = usePlaylistsContextOptional();
  const playlists = playlistsContext?.playlists;
  const isAuthenticated = playlistsContext?.isAuthenticated ?? false;

  // Whether the climber has any playlist a chip could name. Board-scoped with the
  // same rule the `playlistsForClimb` resolver applies, so this is exactly "can a
  // chip ever appear here". It costs no height either way — it only decides
  // whether the stats row shares its width.
  const hasBoardPlaylists = useMemo(
    () => (playlists ? hasPlaylistForBoard(playlists, boardName, layoutId) : false),
    [playlists, boardName, layoutId],
  );

  const { memberUuids } = useClimbPlaylistMembershipQuery({
    climbUuid,
    boardName,
    layoutId,
    enabled: fetchMembership && isAuthenticated && hasBoardPlaylists && layoutId > 0,
  });

  // The store seed paints immediately when the climber arrived from the Climbs
  // tab with playlist tags on; the fetch above then confirms and wins. Results
  // are deliberately NOT written back into the store: the Climbs tab resets it on
  // every board/auth/preference change and would wipe them. React Query is the
  // durable cache here.
  const seededMembers = useClimbPlaylistMemberships(climbUuid);
  // No memo needed: both sides are already reference-stable (a React Query cache
  // array, the store's cached `Set`), so the coalesce is stable on its own.
  const members: Iterable<string> = memberUuids ?? seededMembers;

  // Every playlist by name, not just the one that fits — a "+2" token tells a
  // VoiceOver user nothing. The list variant stays hidden from the accessibility
  // tree (it would triple the length of every row); on a detail surface this is
  // the only place membership is announced at all.
  const describeForAccessibility = useCallback(
    (playlistNames: string[]) => t('mobile.detail.inPlaylists', { playlists: playlistNames.join(', ') }),
    [t],
  );

  // Nothing at all for a signed-out climber or one with no playlist on this
  // board: they can never see a chip here, so they should not pay the width
  // either — the stats line keeps the room to itself.
  if (!isAuthenticated || !hasBoardPlaylists) return null;

  return (
    <PlaylistChipsRow
      playlistUuids={members}
      align="inline"
      maxVisible={HEADER_MAX_VISIBLE_CHIPS}
      // The exact grey the stats text beside it uses — one line, one colour.
      inlineLabelColor={iosSystemColors.systemGray}
      describeForAccessibility={describeForAccessibility}
    />
  );
});
