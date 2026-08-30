// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// This banner exists because `useConfirm` cannot be seen from inside the create
// drawer on Android: the Material path renders a Paper Dialog in a JS Portal at
// the app root, and the drawer is a native @expo/ui sheet composited above it, so
// the dialog paints behind and its promise never resolves. Sheet content cannot be
// occluded by the sheet it lives in, which is the whole point of this component.

type PressMockProps = { children?: ReactNode; onPress?: () => void; accessibilityRole?: string };
vi.mock('react-native', () => ({
  View: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
    createElement('div', { role: accessibilityRole }, children),
  Pressable: ({ children, onPress, accessibilityRole }: PressMockProps) =>
    createElement('button', { onClick: onPress, 'data-role': accessibilityRole }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#EFEFF0', secondaryLabel: '#5B5563' },
    brandColors: { error: '#C81E1E' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 }, borderRadius: { md: 8 } }));

import { InlineConfirmBanner } from '../InlineConfirmBanner';

const props = {
  title: 'Start over?',
  message: "This one isn't in your drafts yet.",
  confirmLabel: 'Start over',
  cancelLabel: 'Dismiss',
};

function renderBanner() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const { container, getByText } = render(createElement(InlineConfirmBanner, { ...props, onConfirm, onCancel }));
  return { container, getByText, onConfirm, onCancel };
}

describe('InlineConfirmBanner', () => {
  it('states what is being asked and offers both ways out', () => {
    const { getByText } = renderBanner();
    expect(getByText('Start over?')).toBeTruthy();
    expect(getByText("This one isn't in your drafts yet.")).toBeTruthy();
    expect(getByText('Start over')).toBeTruthy();
    expect(getByText('Dismiss')).toBeTruthy();
  });

  it('announces itself as an alert, since it replaces a dialog', () => {
    const { container } = renderBanner();
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
  });

  it('reports the choice the climber actually made', () => {
    // Each render gets its own container: both banners share one document, so an
    // unscoped query would match the other one's buttons too.
    const confirming = renderBanner();
    fireEvent.click(within(confirming.container).getByText('Start over'));
    expect(confirming.onConfirm).toHaveBeenCalledTimes(1);
    expect(confirming.onCancel).not.toHaveBeenCalled();

    const cancelling = renderBanner();
    fireEvent.click(within(cancelling.container).getByText('Dismiss'));
    expect(cancelling.onCancel).toHaveBeenCalledTimes(1);
    expect(cancelling.onConfirm).not.toHaveBeenCalled();
  });
});
