import { describe, expect, it } from 'vitest';
import { resolvePlaylistEmojiIcon } from '../playlist-icon';

describe('resolvePlaylistEmojiIcon', () => {
  it('maps generated recommendation icon names to emoji', () => {
    expect(resolvePlaylistEmojiIcon('LocalFireDepartmentOutlined')).toBe('🔥');
    expect(resolvePlaylistEmojiIcon('DiamondOutlined')).toBe('💎');
    expect(resolvePlaylistEmojiIcon('EnergySavingsLeafOutlined')).toBe('🌱');
  });

  it('keeps native emoji playlist icons', () => {
    expect(resolvePlaylistEmojiIcon('⭐')).toBe('⭐');
    expect(resolvePlaylistEmojiIcon('  ❤️  ')).toBe('❤️');
  });

  it('falls back for unknown icon identifiers', () => {
    expect(resolvePlaylistEmojiIcon('SomeMuiIcon')).toBeNull();
    expect(resolvePlaylistEmojiIcon(undefined)).toBeNull();
  });
});
