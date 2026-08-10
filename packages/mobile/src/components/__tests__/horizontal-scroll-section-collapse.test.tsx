// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'shelf-scroll' }, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));
vi.mock('../SectionHeader', () => ({
  SectionHeader: ({ title, expanded }: { title: string; expanded?: boolean }) =>
    createElement(
      'div',
      { 'data-testid': 'section-header', 'data-expanded': expanded === undefined ? undefined : String(expanded) },
      title,
    ),
}));
vi.mock('../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));

import { HorizontalScrollSection } from '../HorizontalScrollSection';

const CARD = 'SHELF_CARD';

function renderShelf(props: Record<string, unknown>) {
  return render(
    createElement(HorizontalScrollSection, {
      title: 'Beta videos',
      children: createElement('span', null, CARD),
      ...props,
    }),
  );
}

describe('HorizontalScrollSection collapse', () => {
  it('renders its scroller when no disclosure props are given', () => {
    const { getByTestId, getByText } = renderShelf({});
    expect(getByTestId('shelf-scroll')).toBeTruthy();
    expect(getByText(CARD)).toBeTruthy();
  });

  it('renders the scroller while expanded', () => {
    const { getByTestId } = renderShelf({ expanded: true, onToggleExpanded: vi.fn() });
    expect(getByTestId('shelf-scroll')).toBeTruthy();
  });

  it('drops the scroller but keeps the header when collapsed', () => {
    // The header is the only way back — it must outlive the collapse (#4229).
    const { queryByTestId, getByTestId, queryByText } = renderShelf({
      expanded: false,
      onToggleExpanded: vi.fn(),
    });

    expect(getByTestId('section-header')).toBeTruthy();
    expect(queryByTestId('shelf-scroll')).toBeNull();
    expect(queryByText(CARD)).toBeNull();
  });

  it('suppresses the loading spinner while collapsed', () => {
    // A folded shelf that still spins would advertise work the user opted out of.
    const { queryByTestId } = renderShelf({ expanded: false, onToggleExpanded: vi.fn(), loading: true });
    expect(queryByTestId('spinner')).toBeNull();
  });

  it('forwards the disclosure state to the header', () => {
    const { getByTestId } = renderShelf({ expanded: false, onToggleExpanded: vi.fn() });
    expect(getByTestId('section-header').getAttribute('data-expanded')).toBe('false');
  });
});
