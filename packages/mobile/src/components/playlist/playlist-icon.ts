const PLAYLIST_ICON_EMOJI: Record<string, string> = {
  LocalFireDepartmentOutlined: '🔥',
  DiamondOutlined: '💎',
  EnergySavingsLeafOutlined: '🌱',
  FavoriteOutlined: '❤️',
  StarOutlined: '⭐',
};

const ICON_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.-]+$/;

export function resolvePlaylistEmojiIcon(icon?: string | null): string | null {
  const trimmedIcon = icon?.trim();
  if (!trimmedIcon) return null;

  const mapped = PLAYLIST_ICON_EMOJI[trimmedIcon];
  if (mapped) return mapped;

  return ICON_IDENTIFIER_PATTERN.test(trimmedIcon) ? null : trimmedIcon;
}
