import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter, useSegments } from 'expo-router';
import type { Climb } from '@boardsesh/queue';
import { AppMenu } from '../AppMenu';
import {
  useClimbActions,
  type ClimbActionsFavoriteControl,
  type ClimbActionsMirrorControl,
} from '../climb-actions/use-climb-actions';
import {
  buildPlayDrawerMenuRows,
  type ClimbMenuGroups,
  type PlayDrawerHiddenButtons,
} from '../play-drawer/play-drawer-menu-rows';
import { useDrawerHost, type BoardConfig } from '../../providers/drawer-host-provider';
import { useActiveClimbUuid } from '../../providers/queue-provider';
import { useProfile } from '../../lib/graphql/hooks';
import { isPlayerRoute } from '../../lib/route-segments';
import type { MiniPlayerButtonId } from '../../lib/mini-player-buttons';
import { useMiniPlayerFavorite, useMiniPlayerMirrorToggle, useOpenMiniPlayerQueue } from './MiniPlayerButtons';

/**
 * The MiniPlayer ⋯'s order, as Music orders its own: what you keep (Favourite,
 * Add to playlist, Share), the queue, the wall (Mirror, Change angle), the
 * climb itself (Add beta video, Edit, Fork), Climb view settings and Open in
 * the Kilter / Tension app (the player's ⋯ groups those two the same way), then
 * Report and Delete. Play next, Play last and Log are never offered: the climb
 * is already on the wall, and ✓ is right beside ⋯.
 */
export const MINI_PLAYER_MENU_GROUPS: ClimbMenuGroups = [
  ['favorite', 'playlist', 'share'],
  ['openQueue'],
  ['mirror', 'angle'],
  ['betaVideo', 'edit', 'fork'],
  ['viewOptions', 'openInApp'],
  ['report', 'delete'],
];

/**
 * What ⋯ stands in for: each button this climber could have on the bar here
 * (`isMiniPlayerButtonAvailable`) that the bar is not showing, because it is
 * switched off or did not fit.
 */
export function miniPlayerMenuHiddenButtons(
  shown: readonly MiniPlayerButtonId[],
  isAvailable: (buttonId: MiniPlayerButtonId) => boolean,
): PlayDrawerHiddenButtons {
  const hidden = (buttonId: keyof PlayDrawerHiddenButtons) => isAvailable(buttonId) && !shown.includes(buttonId);
  return {
    favorite: hidden('favorite'),
    share: hidden('share'),
    queue: hidden('queue'),
    mirror: hidden('mirror'),
    angle: hidden('angle'),
  };
}

const CLIMB_VIEW_SETTINGS_BY_TAB = {
  home: '/(tabs)/home/settings/climb-view',
  climbs: '/(tabs)/climbs/settings/climb-view',
  discover: '/(tabs)/discover/settings/climb-view',
  record: '/(tabs)/record/settings/climb-view',
  profile: '/(tabs)/profile/settings/climb-view',
} as const;

/**
 * Settings → Climb view, pushed in the tab the bar sits over so the tab bar and
 * the bar stay put. The player's View options sheet lives inside `/play`; off
 * it, this screen holds the same Mini player switches.
 */
export function climbViewSettingsHref(segments: readonly string[]): string {
  const tab = segments[0] === '(tabs)' ? segments[1] : undefined;
  return tab !== undefined && tab in CLIMB_VIEW_SETTINGS_BY_TAB
    ? CLIMB_VIEW_SETTINGS_BY_TAB[tab as keyof typeof CLIMB_VIEW_SETTINGS_BY_TAB]
    : '/settings/climb-view';
}

const PALETTE_ROW_IDS: ReadonlySet<string> = new Set(['favorite', 'playlist', 'share']);

/**
 * Marks the leading Favourite / Add to playlist / Share rows as the menu's icon
 * row. Needs 2 or more; otherwise the rows come back untouched.
 */
export function withPaletteRows<Row extends { id: string }>(rows: readonly Row[]): (Row & { palette?: true })[] {
  let leading = 0;
  while (leading < rows.length && PALETTE_ROW_IDS.has(rows[leading].id)) leading += 1;
  if (leading < 2) return [...rows];
  return rows.map((row, index) => (index < leading ? { ...row, palette: true as const } : row));
}

export type MiniPlayerActionsMenuProps = {
  climb: Climb;
  /** The board the climb is drawn on (`resolveClimbRenderBoard`), as the bar's buttons use. */
  climbBoard: BoardConfig;
  queueItemUuid?: string;
  isAuthenticated: boolean;
  /** The climber's buttons the bar is drawing right now (`MiniPlayerControls.leading`). */
  shownButtons: readonly MiniPlayerButtonId[];
  /** The bar's own availability rule, so ⋯ offers what the bar would. */
  isAvailable: (buttonId: MiniPlayerButtonId) => boolean;
  /** The climb whose grades the angle sheet shows per angle, as the bar's Angle passes it. */
  angleClimbUuid: string | undefined;
  /** This phone holds the board's link: tags the heart's FavoriteToggle. */
  bluetoothConnected: boolean;
  size: number;
};

/**
 * ⋯ on the wide MiniPlayer (iPad, the open Duo): Music's "more" beside its
 * transport. The same climb actions as the player's ⋯ (`useClimbActions` and
 * `buildPlayDrawerMenuRows`), in Music's order, with a row for every bar button
 * the bar is not showing.
 *
 * The bar sits over the tabs, never under `/play` (the bar offers no ⋯ while
 * the player route is up), so every sheet opens through the root openers on
 * `useDrawerHost()`, which present over the tab content. Favourite, Mirror and
 * the queue run the same hooks as the bar's own buttons, so a row and a button
 * never disagree.
 *
 * Keyed on the climb and its row set, like the player's ⋯: a change while it is
 * open remounts it, so a tap never lands on a row that moved.
 */
export const MiniPlayerActionsMenu = memo(function MiniPlayerActionsMenu({
  climb,
  climbBoard,
  queueItemUuid,
  isAuthenticated,
  shownButtons,
  isAvailable,
  angleClimbUuid,
  bluetoothConnected,
  size,
}: MiniPlayerActionsMenuProps) {
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const router = useRouter();
  const segments = useSegments();
  const { openAddToPlaylist, openAnglePicker } = useDrawerHost();
  const activeClimbUuid = useActiveClimbUuid();
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const currentUserId = isAuthenticated ? (profile?.id ?? null) : null;

  const hidden = useMemo(() => miniPlayerMenuHiddenButtons(shownButtons, isAvailable), [shownButtons, isAvailable]);

  const favorite = useMiniPlayerFavorite({
    climb,
    climbBoard,
    bluetoothConnected,
    source: 'mini_player_menu',
    enabled: hidden.favorite,
  });
  const mirror = useMiniPlayerMirrorToggle({ climb, climbBoard, queueItemUuid });
  const favoriteControl = useMemo<ClimbActionsFavoriteControl>(
    () => ({ isFavorited: favorite.isFavorited, onToggle: favorite.toggle }),
    [favorite.isFavorited, favorite.toggle],
  );
  const mirrorControl = useMemo<ClimbActionsMirrorControl | undefined>(
    () => (hidden.mirror ? { isMirrored: mirror.isMirrored, onToggle: mirror.toggle } : undefined),
    [hidden.mirror, mirror.isMirrored, mirror.toggle],
  );
  const openQueue = useOpenMiniPlayerQueue('mini_player_menu');
  const handleOpenAngle = useCallback(() => openAnglePicker(angleClimbUuid), [openAnglePicker, angleClimbUuid]);
  const handleSelectPlaylist = useCallback(
    () => openAddToPlaylist(climb, climbBoard),
    [openAddToPlaylist, climb, climbBoard],
  );
  const viewOptionsHref = climbViewSettingsHref(segments);
  const handleOpenViewOptions = useCallback(() => router.push(viewOptionsHref), [router, viewOptionsHref]);

  // Log ascent, Add beta video and Report are left to `useClimbActions`' root
  // openers (`useDrawerHost()`), which are the right ones off `/play`.
  const items = useClimbActions({
    climb,
    boardConfig: climbBoard,
    queueItemUuid,
    currentUserId,
    isAuthenticated,
    onSelectPlaylist: handleSelectPlaylist,
    onOpenQueue: openQueue,
    onOpenViewOptions: handleOpenViewOptions,
    mirrorControl,
    onOpenAngle: hidden.angle ? handleOpenAngle : undefined,
    favoriteControl,
    analyticsSource: 'mini_player_menu',
  });

  const isActiveClimb = climb.uuid === activeClimbUuid;
  // Off `/play` the row pushes Settings → Climb view, not the player's View
  // options sheet, so it is named after the screen it opens.
  const climbViewTitle = tCommon('mobile.settings.climbView.title');
  const rows = useMemo(
    () =>
      buildPlayDrawerMenuRows(items, {
        hidden,
        boardMismatch: false,
        isActiveClimb,
        groups: MINI_PLAYER_MENU_GROUPS,
      }).map((row) => (row.id === 'viewOptions' ? { ...row, label: climbViewTitle } : row)),
    [items, hidden, isActiveClimb, climbViewTitle],
  );
  // Music's icon row: Favourite, Add to playlist and Share lead the menu. Fewer than
  // 2 left (a draft has no Share, signed out has neither of the first two) falls back
  // to plain rows, since a one-item control group looks odd.
  const menuRows = useMemo(() => withPaletteRows(rows), [rows]);
  const handleSelectIndex = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row || row.disabled) return;
      row.run();
    },
    [rows],
  );
  const rowSignature = rows.map((row) => (row.disabled ? `${row.id}:off` : row.id)).join(',');

  // The bar gives up ⋯ while `/play` is up (`moreAvailable`); this is the
  // backstop, since a root sheet opened from here would present behind it.
  if (isPlayerRoute(segments)) return null;

  return (
    <AppMenu
      key={`${climb.uuid}|${rowSignature}`}
      iconName="more"
      iconAppearance="plain"
      anchorSize={size}
      accessibilityLabel={t('playView.actionBar.moreActionsForAria', { name: climb.name })}
      actions={menuRows}
      onSelectIndex={handleSelectIndex}
    />
  );
});
