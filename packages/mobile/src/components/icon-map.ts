import type { SymbolViewProps } from 'expo-symbols';

type IconMapping = {
  // SFSymbol union (from sf-symbols-typescript via expo-symbols) — every name is
  // validated at compile time, so a typo fails `vp run typecheck:mobile`.
  ios: SymbolViewProps['name'];
  android: string;
};

export const iconMap = {
  // Tab bar / iPad sidebar
  home: { ios: 'house', android: 'home-outline' },
  'home.fill': { ios: 'house.fill', android: 'home' },
  record: { ios: 'record.circle', android: 'record-circle-outline' },
  discover: { ios: 'bookmark', android: 'bookmark-multiple-outline' },
  boards: { ios: 'square.grid.2x2', android: 'view-dashboard' },
  'boards.fill': { ios: 'square.grid.2x2.fill', android: 'view-dashboard' },
  search: { ios: 'magnifyingglass', android: 'magnify' },
  queue: { ios: 'list.bullet', android: 'playlist-play' },
  profile: { ios: 'person.crop.circle', android: 'account-circle-outline' },
  'profile.fill': { ios: 'person.crop.circle.fill', android: 'account-circle' },
  more: { ios: 'ellipsis', android: 'dots-horizontal' },
  settings: { ios: 'gearshape', android: 'cog-outline' },
  'settings.fill': { ios: 'gearshape.fill', android: 'cog' },
  server: { ios: 'server.rack', android: 'server-network' },
  logout: { ios: 'rectangle.portrait.and.arrow.right', android: 'logout' },

  // Navigation
  'chevron.right': { ios: 'chevron.right', android: 'chevron-right' },
  'chevron.left': { ios: 'chevron.left', android: 'chevron-left' },
  'chevron.down': { ios: 'chevron.down', android: 'chevron-down' },
  'chevron.up': { ios: 'chevron.up', android: 'chevron-up' },
  close: { ios: 'xmark', android: 'close' },
  back: { ios: 'chevron.left', android: 'arrow-left' },

  // Actions
  favorite: { ios: 'heart', android: 'heart-outline' },
  'favorite.fill': { ios: 'heart.fill', android: 'heart' },
  add: { ios: 'plus.circle', android: 'plus-circle-outline' },
  'add.fill': { ios: 'plus.circle.fill', android: 'plus-circle' },
  share: { ios: 'square.and.arrow.up', android: 'share-variant-outline' },
  comment: { ios: 'bubble.left', android: 'comment-outline' },
  'comment.fill': { ios: 'bubble.left.fill', android: 'comment' },
  'more.actions': { ios: 'ellipsis.circle', android: 'dots-horizontal-circle-outline' },
  'more.actions.fill': { ios: 'ellipsis.circle.fill', android: 'dots-horizontal-circle' },
  copy: { ios: 'doc.on.doc', android: 'content-copy' },
  'doc.text': { ios: 'doc.text', android: 'file-document-outline' },
  mail: { ios: 'envelope', android: 'email-outline' },
  paw: { ios: 'pawprint.fill', android: 'paw' },
  flag: { ios: 'flag', android: 'flag-outline' },
  link: { ios: 'link', android: 'link-variant' },
  github: { ios: 'chevron.left.forwardslash.chevron.right', android: 'github' },
  upload: { ios: 'square.and.arrow.up', android: 'upload-outline' },
  delete: { ios: 'trash', android: 'delete-outline' },
  'delete.fill': { ios: 'trash.fill', android: 'delete' },
  edit: { ios: 'pencil', android: 'pencil-outline' },
  pin: { ios: 'pin', android: 'pin-outline' },
  'pin.fill': { ios: 'pin.fill', android: 'pin' },
  transfer: { ios: 'arrow.left.arrow.right', android: 'swap-horizontal' },
  tag: { ios: 'tag', android: 'tag-outline' },
  'check.small': { ios: 'checkmark', android: 'check' },
  flash: { ios: 'bolt.fill', android: 'flash' },
  'open.external': { ios: 'arrow.up.right.square', android: 'open-in-new' },

  // Climb/Board
  mirror: { ios: 'arrow.triangle.2.circlepath', android: 'sync' },
  lightbulb: { ios: 'lightbulb', android: 'lightbulb-on-outline' },
  'lightbulb.fill': { ios: 'lightbulb.fill', android: 'lightbulb-on' },
  'lightbulb.slash': { ios: 'lightbulb.slash', android: 'lightbulb-off' },
  angle: { ios: 'angle', android: 'angle-acute' },
  tick: { ios: 'checkmark.circle.fill', android: 'check-circle' },
  'tick.outline': { ios: 'checkmark.circle', android: 'check-circle-outline' },
  // Ascent-status "attempted" marker (tried, didn't send). A circled X that
  // mirrors the circled check used for `send`, so the climb-row status glyphs
  // (bolt / check / x) read as one matched set.
  'ascent.attempt': { ios: 'xmark.circle', android: 'close-circle-outline' },
  // Intrinsic climb-attribute glyphs shown after the name (web parity:
  // climb-card/climb-icons.tsx © benchmark + ⊘ no-match).
  'no.match': { ios: 'hand.raised.slash', android: 'hand-back-right-off-outline' },
  benchmark: { ios: 'c.circle', android: 'copyright' },
  bluetooth: { ios: 'antenna.radiowaves.left.and.right', android: 'bluetooth' },
  'bluetooth.connected': { ios: 'antenna.radiowaves.left.and.right', android: 'bluetooth-connect' },
  'bluetooth.off': { ios: 'antenna.radiowaves.left.and.right.slash', android: 'bluetooth-off' },
  playlist: { ios: 'folder.badge.plus', android: 'folder-plus-outline' },
  send: { ios: 'paperplane.fill', android: 'send' },

  // Create climb
  flame: { ios: 'flame', android: 'fire' },
  lock: { ios: 'lock', android: 'lock-outline' },
  visibility: { ios: 'eye', android: 'eye-outline' },
  'visibility.off': { ios: 'eye.slash', android: 'eye-off-outline' },
  'play.circle': { ios: 'play.circle', android: 'play-circle-outline' },
  'square.and.arrow.up.on.square': { ios: 'square.and.arrow.up.on.square', android: 'tray-arrow-up' },
  eraser: { ios: 'eraser', android: 'eraser' },
  'hand.raised': { ios: 'hand.raised', android: 'hand-back-right-outline' },
  undo: { ios: 'arrow.uturn.backward', android: 'undo' },
  redo: { ios: 'arrow.uturn.forward', android: 'redo' },

  // Status
  info: { ios: 'info.circle', android: 'information-outline' },
  warning: { ios: 'exclamationmark.triangle', android: 'alert-outline' },
  error: { ios: 'xmark.circle', android: 'alert-circle-outline' },
  success: { ios: 'checkmark.circle', android: 'check-circle-outline' },

  // Social
  person: { ios: 'person', android: 'account-outline' },
  'person.fill': { ios: 'person.fill', android: 'account' },
  'person.badge.plus': { ios: 'person.badge.plus', android: 'account-plus-outline' },
  people: { ios: 'person.2', android: 'account-multiple-outline' },
  'people.fill': { ios: 'person.2.fill', android: 'account-multiple' },
  discord: { ios: 'bubble.left.and.bubble.right.fill', android: 'discord' },
  notification: { ios: 'bell', android: 'bell-outline' },
  'notification.fill': { ios: 'bell.fill', android: 'bell' },

  // Queue / Playback
  history: { ios: 'clock.arrow.circlepath', android: 'history' },
  'checkmark.circle.fill': { ios: 'checkmark.circle.fill', android: 'check-circle' },
  circle: { ios: 'circle', android: 'circle-outline' },
  'play.fill': { ios: 'play.fill', android: 'play' },
  pause: { ios: 'pause', android: 'pause' },
  'minus.circle': { ios: 'minus.circle', android: 'minus-circle-outline' },
  'end.session': { ios: 'stop.circle', android: 'stop-circle-outline' },
  'skip.previous': { ios: 'backward.end', android: 'skip-previous' },
  'skip.next': { ios: 'forward.end', android: 'skip-next' },
  'drag.handle': { ios: 'line.3.horizontal', android: 'drag-horizontal-variant' },

  // Math
  minus: { ios: 'minus', android: 'minus' },
  plus: { ios: 'plus', android: 'plus' },

  // Data
  'chart.bar': { ios: 'chart.bar', android: 'chart-bar' },
  repeat: { ios: 'repeat', android: 'repeat' },

  // Misc
  star: { ios: 'star', android: 'star-outline' },
  'star.fill': { ios: 'star.fill', android: 'star' },
  crown: { ios: 'crown.fill', android: 'crown' },
  location: { ios: 'location', android: 'map-marker-outline' },
  'location.fill': { ios: 'location.fill', android: 'map-marker' },
  calendar: { ios: 'calendar', android: 'calendar-outline' },
  clock: { ios: 'clock', android: 'clock-outline' },
  filter: { ios: 'line.3.horizontal.decrease', android: 'filter-variant' },
  sort: { ios: 'arrow.up.arrow.down', android: 'sort-variant' },
  refresh: { ios: 'arrow.clockwise', android: 'refresh' },
  'crop.free': { ios: 'viewfinder', android: 'crop-free' },
  photo: { ios: 'photo', android: 'image-outline' },
  camera: { ios: 'camera', android: 'camera-outline' },
  video: { ios: 'video', android: 'video-outline' },
  instagram: { ios: 'camera.fill', android: 'instagram' },
  // MaterialCommunityIcons has no standalone tiktok glyph — `play-box` is the
  // closest neutral "short-form video clip" cue and matches our visual
  // placement (small badge on a video thumbnail).
  tiktok: { ios: 'play.rectangle.fill', android: 'play-box' },

  // Dev tools
  branch: { ios: 'arrow.triangle.branch', android: 'source-branch' },
} as const satisfies Record<string, IconMapping>;

export type IconName = keyof typeof iconMap;
