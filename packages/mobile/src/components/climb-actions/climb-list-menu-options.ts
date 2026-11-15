import type { ClimbMenuGroups } from '../play-drawer/play-drawer-menu-rows';
export const LIST_GROUPS: ClimbMenuGroups = [
  ['playNext', 'queue', 'replayFromHere'],
  ['playlist', 'favorite', 'tick', 'editEntry', 'share'],
  ['betaVideo', 'edit', 'fork', 'openInApp'],
  ['report', 'delete'],
];
export const ALL_BUTTONS_HIDDEN = {
  playNext: true,
  tick: true,
  favorite: true,
  share: true,
  queue: true,
  mirror: true,
  angle: true,
};
