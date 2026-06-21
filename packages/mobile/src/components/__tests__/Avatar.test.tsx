import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Image: () => null,
  PixelRatio: { get: () => 3 },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: unknown) => styles },
  View: () => null,
}));

vi.mock('../Text', () => ({
  Text: () => null,
}));

import { sizedAvatarUri } from '../Avatar';

describe('sizedAvatarUri', () => {
  it('passes third-party avatar URLs through unchanged', () => {
    expect(sizedAvatarUri('https://lh3.googleusercontent.com/a/avatar', 40)).toBe(
      'https://lh3.googleusercontent.com/a/avatar',
    );
  });

  it('adds a size query param to backend-served avatars', () => {
    expect(sizedAvatarUri('https://ws.example.com/static/avatars/user-1.jpg', 40)).toBe(
      'https://ws.example.com/static/avatars/user-1.jpg?size=128',
    );
  });

  it('preserves existing upload versions when adding size', () => {
    expect(sizedAvatarUri('https://ws.example.com/static/avatars/user-1.jpg?v=upload-123', 40)).toBe(
      'https://ws.example.com/static/avatars/user-1.jpg?v=upload-123&size=128',
    );
  });
});
