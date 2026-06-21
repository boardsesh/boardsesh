// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const reportError = vi.hoisted(() => vi.fn());

type ViewMockProps = { children?: ReactNode; testID?: string };

vi.mock('react-native', () => ({
  View: ({ children, testID }: ViewMockProps) => createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('../../../lib/error-reporting', () => ({
  reportError,
}));

vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: {
    systemGray: '#8E8E93',
  },
}));

import { BoardRenderUnavailable } from '../BoardRenderUnavailable';

describe('BoardRenderUnavailable', () => {
  beforeEach(() => {
    reportError.mockClear();
  });

  it('renders a visible board-slot fallback and reports board context', () => {
    const { container } = render(
      createElement(BoardRenderUnavailable, {
        boardName: 'kilter',
        layoutId: 8,
        sizeId: 17,
        setIds: '26',
        climbUuid: '1AFD857976594253A2D9ACB0B06B6360',
        climbName: 'orbit',
      }),
    );

    expect(container.querySelector('[data-testid="play-drawer-board-unavailable"]')).toBeTruthy();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        feature: 'mobile_play_drawer',
        boardName: 'kilter',
      },
      extra: {
        layoutId: 8,
        sizeId: 17,
        setIds: '26',
        climbUuid: '1AFD857976594253A2D9ACB0B06B6360',
        climbName: 'orbit',
      },
    });
  });
});
