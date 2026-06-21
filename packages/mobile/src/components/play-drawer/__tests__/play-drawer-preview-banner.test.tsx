// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type PressableMockProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress, accessibilityLabel }: PressableMockProps) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

// t echoes the key so the badge + button copy is assertable.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { accent: '#007AFF' } }),
}));

vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { white: '#FFFFFF', systemOrange: '#FF9500' },
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 4: 16 },
  borderRadius: { sm: 4 },
}));

import { PlayDrawerPreviewBanner } from '../PlayDrawerPreviewBanner';

describe('PlayDrawerPreviewBanner', () => {
  it('renders the Preview badge and a Set active button', () => {
    const { container } = render(createElement(PlayDrawerPreviewBanner, { showSetActive: true, onSetActive: vi.fn() }));
    expect(container.textContent).toContain('playView.previewBadge');
    expect(container.querySelector('button')).toBeTruthy();
    expect(container.textContent).toContain('playView.setActive');
  });

  it('promotes the climb when Set active is pressed', () => {
    const onSetActive = vi.fn();
    const { container } = render(createElement(PlayDrawerPreviewBanner, { showSetActive: true, onSetActive }));
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(onSetActive).toHaveBeenCalledTimes(1);
  });

  it('hides Set active when showSetActive is false (cross-board uses the switch-board overlay)', () => {
    const { container } = render(
      createElement(PlayDrawerPreviewBanner, { showSetActive: false, onSetActive: vi.fn() }),
    );
    expect(container.textContent).toContain('playView.previewBadge');
    expect(container.querySelector('button')).toBeNull();
  });
});
