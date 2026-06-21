// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// ClimbPreviewCard reuses the climbs-list row visual so the preview is identical
// to a list row. We mock the shared visual to assert the card forwards the climb
// + board config to it (and wraps it in the shared row layout + a separator).
const itemContent = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock('react-native', () => ({
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) => {
    const flat = Object.assign({}, ...(Array.isArray(style) ? style : [style]).filter(Boolean)) as {
      backgroundColor?: string;
    };
    return createElement('div', { 'data-bg': flat.backgroundColor }, children);
  },
}));

vi.mock('../ClimbListItemContent', () => ({
  ClimbListItemContent: (props: Record<string, unknown>) => {
    itemContent.props = props;
    return createElement('div', { 'data-testid': 'climb-list-item-content' });
  },
}));

vi.mock('../climb-list-row-styles', () => ({
  climbListRowStyles: { contentRow: { gap: 12 }, separator: { height: 1 } },
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { separator: '#38383A', background: '#000000' } }),
}));

import { ClimbPreviewCard } from '../ClimbPreviewCard';

const climb = {
  uuid: 'climb-1',
  name: 'Test Climb',
  frames: 'p1r12',
  difficulty: 'V4',
  quality_average: '3.0',
};

const boardConfig = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };

describe('ClimbPreviewCard', () => {
  it('renders the shared climbs-list visual with the climb and board config', () => {
    const { queryByTestId } = render(<ClimbPreviewCard climb={climb} {...boardConfig} />);
    expect(queryByTestId('climb-list-item-content')).not.toBeNull();
    expect(itemContent.props).toMatchObject({
      climb,
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
    });
  });

  it('renders a scheme-aware separator below the preview row', () => {
    const { container } = render(<ClimbPreviewCard climb={climb} {...boardConfig} />);
    // The separator is the only block tinted with the separator colour; the row
    // itself stays transparent so the sheet's glass shows through.
    expect(container.querySelector('[data-bg="#38383A"]')).not.toBeNull();
    expect(container.querySelector('[data-bg="#000000"]')).toBeNull();
  });
});
