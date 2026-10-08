// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { BoardCandidate } from '@boardsesh/shared-schema';

vi.mock('react-native', () => ({
  Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) =>
    visible ? createElement('div', null, children) : null,
  View: ({ children, accessibilityViewIsModal }: { children?: ReactNode; accessibilityViewIsModal?: boolean }) =>
    createElement('div', { 'data-modal': String(!!accessibilityViewIsModal) }, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessible,
    importantForAccessibility,
    accessibilityRole,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessible?: boolean;
    importantForAccessibility?: string;
    accessibilityRole?: string;
  }) =>
    createElement(
      'div',
      {
        onClick: onPress,
        'data-backdrop': accessible === false && importantForAccessibility === 'no' ? 'true' : undefined,
        'data-role': accessibilityRole,
      },
      children,
    ),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios ?? spec.default },
  PlatformColor: (name: string) => name,
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#111', secondaryLabel: '#888', fill: '#222', separator: '#333' },
  }),
}));
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 0 }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { BoardDisambiguationSheet } from '../BoardDisambiguationSheet';

const candidates = [
  { boardId: 1, boardName: 'Crag Wall', boardType: 'kilter', gymName: 'Gym A', isOwnedByMe: false },
  { boardId: 2, boardName: 'Home Wall', boardType: 'kilter', gymName: null, isOwnedByMe: true },
] as unknown as BoardCandidate[];

describe('BoardDisambiguationSheet accessibility', () => {
  it('hides the backdrop from assistive tech and keeps it a sibling of the modal card', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <BoardDisambiguationSheet visible candidates={candidates} onPick={() => {}} onCancel={onCancel} />,
    );
    const backdrop = container.querySelector('[data-backdrop="true"]') as HTMLElement;
    const card = container.querySelector('[data-modal="true"]') as HTMLElement;
    expect(backdrop.contains(card)).toBe(false);
    fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('exposes each candidate and Cancel as buttons that still work', () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    const { container, getByText } = render(
      <BoardDisambiguationSheet visible candidates={candidates} onPick={onPick} onCancel={onCancel} />,
    );
    expect(container.querySelectorAll('[data-role="button"]').length).toBe(3);
    fireEvent.click(getByText('Home Wall'));
    expect(onPick).toHaveBeenCalledWith(2);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
