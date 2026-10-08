// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';

const ctrl = vi.hoisted(() => ({ mode: 'glass' as 'glass' | 'blur' | 'material' | 'solid' }));

vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  return {
    StyleSheet: { absoluteFill: { position: 'absolute' }, create: (styles: unknown) => styles },
    View: ({ style, testID }: { style?: unknown; testID?: string }) =>
      createElement('div', { 'data-testid': testID, 'data-bg': flattenStyle(style).backgroundColor }),
  };
});
vi.mock('../../hooks/use-effective-surface-mode', () => ({ useEffectiveSurfaceMode: () => ctrl.mode }));
vi.mock('../GlassSurface', () => ({
  GlassSurface: ({ role, tintColor }: { role?: string; tintColor?: string }) =>
    createElement('div', { 'data-testid': 'glass-surface', 'data-role': role, 'data-tint': tintColor }),
}));

import { ScreenBackground } from '../ScreenBackground';

beforeEach(() => {
  ctrl.mode = 'glass';
});

// HIG Materials: Liquid Glass is the controls layer, never a screen's content
// background.
describe('ScreenBackground', () => {
  it.each(['glass', 'blur'] as const)('is the opaque system colour, not glass, in %s mode', (mode) => {
    ctrl.mode = mode;
    const { queryByTestId } = render(<ScreenBackground color="#F2F2F7" role="low" tintColor="#11223344" />);
    expect(queryByTestId('glass-surface')).toBeNull();
    expect(queryByTestId('screen-background-opaque')?.getAttribute('data-bg')).toBe('#F2F2F7');
  });

  it.each(['material', 'solid'] as const)('keeps the tonal surface in %s mode', (mode) => {
    ctrl.mode = mode;
    const { getByTestId, queryByTestId } = render(
      <ScreenBackground color="#F2F2F7" role="low" tintColor="#11223344" />,
    );
    expect(queryByTestId('screen-background-opaque')).toBeNull();
    expect(getByTestId('glass-surface').getAttribute('data-role')).toBe('low');
    expect(getByTestId('glass-surface').getAttribute('data-tint')).toBe('#11223344');
  });
});
