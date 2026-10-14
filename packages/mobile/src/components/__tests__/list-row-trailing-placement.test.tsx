// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// `trailingPlacement="below"` exists for rows whose actions must stay reachable
// at large text sizes: beside the title they share one line that never wraps,
// so a long title or label squeezes a button off the edge. Below, they sit in
// the title's own column, on a line of their own.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { separator: '#separator', tertiaryLabel: '#tertiary' } }),
}));
vi.mock('../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../Icon', () => ({ Icon: () => null }));
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
}));

import { ListRow } from '../ListRow';

afterEach(cleanup);

const actions = createElement('em', null, 'Approve Decline');

/** The column that holds the title: the title's own parent. */
function titleColumn(): HTMLElement {
  const column = screen.getByText('Ada Lovelace').parentElement;
  if (!column) throw new Error('title has no column');
  return column;
}

describe('ListRow trailing placement', () => {
  it('keeps trailing content beside the title by default', () => {
    render(createElement(ListRow, { title: 'Ada Lovelace', trailing: actions }));
    expect(screen.getByText('Approve Decline')).not.toBeNull();
    expect(titleColumn().contains(screen.getByText('Approve Decline'))).toBe(false);
  });

  it('puts trailing content on its own line under the title with "below"', () => {
    render(createElement(ListRow, { title: 'Ada Lovelace', trailing: actions, trailingPlacement: 'below' }));
    const column = titleColumn();
    const placed = screen.getByText('Approve Decline');
    expect(column.contains(placed)).toBe(true);
    // Under the title, not before it.
    expect(column.firstElementChild?.textContent).toBe('Ada Lovelace');
    // Drawn once: not also beside the title.
    expect(screen.getAllByText('Approve Decline')).toHaveLength(1);
  });
});
