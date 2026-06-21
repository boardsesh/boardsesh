// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controls the resolved UI variant the Card branches on.
const ctrl = vi.hoisted(() => ({ variant: 'material' as 'material' | 'liquidGlass' }));

// Minimal RN surface: View → div, StyleSheet + Platform.select stubs.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-view': 'true' }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Platform: { select: (spec: Record<string, unknown>) => spec.ios },
}));

// Paper Card → <section> exposing the props the material test asserts on; Card
// has a static `.Content` (the component wraps children in <Card.Content>).
vi.mock('react-native-paper', () => {
  const Card = ({ children, mode, onPress }: { children?: ReactNode; mode?: string; onPress?: () => void }) =>
    createElement('section', { 'data-paper-card': 'true', 'data-mode': mode, onClick: onPress }, children);
  Card.Content = ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-paper-card-content': 'true' }, children);
  return { Card };
});

// Glass-path pressable → a plain <button>.
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { 'data-pressable': 'true', onClick: onPress }, children),
}));

vi.mock('../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: ctrl.variant,
    systemColors: { secondaryBackground: '#eee', separator: '#ccc' },
    m3: { outlineVariant: '#ddd' },
  }),
}));

import { Card } from '../Card';

describe('Card (Material variant)', () => {
  it('renders a Paper elevated card', () => {
    ctrl.variant = 'material';
    const { container } = render(
      <Card>
        <span>Body</span>
      </Card>,
    );
    const paper = container.querySelector('[data-paper-card]');
    expect(paper).not.toBeNull();
    expect(paper?.getAttribute('data-mode')).toBe('elevated');
    expect(container.querySelector('[data-pressable]')).toBeNull();
    expect(container.textContent).toContain('Body');
  });

  it('fires onPress when interactive', () => {
    ctrl.variant = 'material';
    const onPress = vi.fn();
    const { container } = render(
      <Card onPress={onPress}>
        <span>Tap</span>
      </Card>,
    );
    const paper = container.querySelector('[data-paper-card]');
    fireEvent.click(paper as Element);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('Card (Liquid Glass variant)', () => {
  it('renders a static View when no onPress is given', () => {
    ctrl.variant = 'liquidGlass';
    const { container } = render(
      <Card>
        <span>Body</span>
      </Card>,
    );
    expect(container.querySelector('[data-view]')).not.toBeNull();
    expect(container.querySelector('[data-pressable]')).toBeNull();
    expect(container.querySelector('[data-paper-card]')).toBeNull();
  });

  it('renders a PressableSurface and fires onPress when interactive', () => {
    ctrl.variant = 'liquidGlass';
    const onPress = vi.fn();
    const { container } = render(
      <Card onPress={onPress}>
        <span>Tap</span>
      </Card>,
    );
    const pressable = container.querySelector('[data-pressable]');
    expect(pressable).not.toBeNull();
    expect(container.querySelector('[data-paper-card]')).toBeNull();
    fireEvent.click(pressable as Element);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
