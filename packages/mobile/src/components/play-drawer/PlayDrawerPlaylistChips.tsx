import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PlaylistChipsRow } from '../ClimbPlaylistChips';
import { useClimbPlaylistMemberships } from '../../hooks/use-climb-playlist-memberships';
import { useClimbPlaylistMembershipQuery } from '../../hooks/use-climb-playlist-membership-query';
import { usePlaylistsContextOptional } from '../../providers/playlists-provider';
import { hasPlaylistForBoard } from '../../lib/sort-filter-playlists';

/**
 * Height of the reserved chips slot, in points.
 *
 * The play drawer's first screen is a FIXED height and the board art under the
 * header is `flex: 1` inside it, so every point the header takes comes off the
 * board. If the strip's height varied per climb — present for a climb in a
 * playlist, absent for the next one — the board would resize on every swipe, and
 * again whenever a membership fetch landed. So the slot is constant whenever it
 * is rendered at all, and the chips paint inside it.
 *
 * Sized for the tallest chip the strip can produce: `caption1` (16pt line height)
 * scaled by the chips' 1.3 accessibility cap, plus 4pt of chip padding and the
 * row's 4pt top margin, rounded up for headroom.
 */
export const PLAY_DRAWER_CHIPS_SLOT_HEIGHT = 30;

type PlayDrawerPlaylistChipsProps = {
  climbUuid: string;
  boardName: string;
  layoutId: number;
  /**
   * Whether this header may fetch membership. True for the climb on screen;
   * false for the swipe "peek" header, whose climb changes continuously during a
   * fling — firing a request per peek would spray one per climb passed. The peek
   * still paints from the cache/seed, and the reserved slot keeps both headers
   * the same height, so nothing shifts as the swipe settles.
   */
  fetchMembership: boolean;
};

/**
 * Playlist-membership tags under the climb name in the play drawer.
 *
 * Not the list variant. `ClimbPlaylistChips` reads the shared
 * `playlistMembershipStore`, which is written by exactly one hook
 * (`useClimbListPlaylistMemberships`) running on the Climbs tab — so a drawer
 * opened from the queue, from a playlist, or from a deep link would render an
 * empty strip forever. This variant seeds from the store (instant when the
 * climber did come from the Climbs tab) and confirms with its own per-climb
 * fetch, sharing the query key the add-to-playlist picker writes to.
 *
 * Shown unconditionally: the "Show playlist tags" setting is list-scoped, gating
 * a third line on every row, and a detail header carries no such density cost.
 * The slot only exists for climbers who actually have playlists on this
 * board+layout — the only people who can ever see a chip here — so it costs
 * everyone else no board space at all.
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
  // chip ever appear here" — and it does not vary per climb, which is what keeps
  // the reserved slot's height constant while swiping through the queue.
  //
  // It can still flip once, from false to true, if a climber opens a climb before
  // the app-root playlists query has resolved: the slot appears and the board
  // settles 30pt. Reserving the slot while that query is in flight would trade
  // that for the same settle in reverse, and would charge it to everyone who has
  // no playlists — the majority — instead of only to playlist owners inside a
  // one-or-two-second window at cold start. This is the cheaper side of the trade.
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

  // Every playlist by name, not just the two that fit — a "+2" token tells a
  // VoiceOver user nothing. The list variant stays hidden from the accessibility
  // tree (it would triple the length of every row); on a detail surface this is
  // the only place membership is announced at all.
  const describeForAccessibility = useCallback(
    (playlistNames: string[]) => t('mobile.detail.inPlaylists', { playlists: playlistNames.join(', ') }),
    [t],
  );

  // No slot at all — not even an empty one — for a signed-out climber or one with
  // no playlist on this board. They can never see a chip here, so they should not
  // pay for the space either.
  if (!isAuthenticated || !hasBoardPlaylists) return null;

  return (
    <View style={styles.slot}>
      <PlaylistChipsRow playlistUuids={members} align="center" describeForAccessibility={describeForAccessibility} />
    </View>
  );
});

const styles = StyleSheet.create({
  slot: {
    height: PLAY_DRAWER_CHIPS_SLOT_HEIGHT,
    alignSelf: 'stretch',
    justifyContent: 'flex-start',
    // Backstop: an unusually tall chip clips rather than pushing the board art.
    overflow: 'hidden',
  },
});
