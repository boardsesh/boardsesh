// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { LedgerTryMark } from '@boardsesh/profile-stats';

vi.mock('react-native', () => ({
  View: ({
    children,
    testID,
    accessibilityElementsHidden,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityElementsHidden?: boolean;
  }) =>
    createElement(
      'div',
      { 'data-testid': testID, 'aria-hidden': accessibilityElementsHidden ? 'true' : undefined },
      children,
    ),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-testid': `try-dot-${name}` }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts?.count === undefined ? key : `${key}:${opts.count}`),
  }),
}));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primary: '#primary' }, systemColors: { secondaryLabel: '#secondary' } }),
}));

import { TryDots } from '../TryDots';

const renderDots = (marks: LedgerTryMark[], overflowTries = 0) =>
  render(createElement(TryDots, { marks, overflowTries }));

describe('TryDots', () => {
  it('draws one node per mark, in order', () => {
    const { container } = renderDots(['fall', 'fall', 'send', 'flash']);
    const row = container.firstElementChild;
    expect(Array.from(row?.children ?? []).map((node) => node.getAttribute('data-testid'))).toEqual([
      'try-dot-fall',
      'try-dot-fall',
      'try-dot-send',
      'try-dot-flash',
    ]);
  });

  it('leads with a count of the tries it left out', () => {
    const { container } = renderDots(['fall', 'send'], 21);
    const row = container.firstElementChild;
    expect(row?.firstElementChild?.textContent).toBe('mobile.logbook.moreTries:21');
    expect(row?.children).toHaveLength(3);
  });

  it('prints no caption when nothing was left out', () => {
    const { container } = renderDots(['fall']);
    expect(container.textContent).toBe('');
  });

  it('stays out of the accessibility tree', () => {
    const { container } = renderDots(['fall']);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});
