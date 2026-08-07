// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  Image: ({
    source,
    onError,
    accessibilityLabel,
  }: {
    source: { uri: string };
    onError?: () => void;
    accessibilityLabel?: string;
  }) => createElement('img', { src: source.uri, onError, 'aria-label': accessibilityLabel }),
  PixelRatio: { get: () => 3 },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
    createElement('div', { 'data-fallback': true, 'aria-label': accessibilityLabel }, children),
}));

vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-initials': true }, children),
}));

import { Avatar } from '../Avatar';

const AVATAR_URI = 'https://ws.example.com/static/avatars/user-1.jpg?v=upload-1';

describe('Avatar image-error fallback', () => {
  it('renders the image while it loads fine', () => {
    const { container } = render(<Avatar uri={AVATAR_URI} name="Alex Honnold" />);
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.querySelector('[data-initials]')).toBeNull();
  });

  it('falls back to initials when the image fails to load', () => {
    const { container } = render(<Avatar uri={AVATAR_URI} name="Alex Honnold" />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-initials]')?.textContent).toBe('AH');
  });

  it('retries the image when a re-upload produces a new versioned uri', () => {
    const { container, rerender } = render(<Avatar uri={AVATAR_URI} name="Alex Honnold" />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();

    rerender(<Avatar uri="https://ws.example.com/static/avatars/user-1.jpg?v=upload-2" name="Alex Honnold" />);
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('renders initials directly when there is no uri', () => {
    const { container } = render(<Avatar uri={null} name="Alex Honnold" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-initials]')?.textContent).toBe('AH');
  });
});
