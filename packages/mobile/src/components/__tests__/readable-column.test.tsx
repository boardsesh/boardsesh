// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

const insets = vi.hoisted(() => ({ value: { top: 0, right: 0, bottom: 0, left: 0 } }));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insets.value,
}));

vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const { flattenStyle } = await import('../../../test/flatten-style');
  return {
    StyleSheet: { create: <T,>(styles: T) => styles },
    View: ({ children, style, testID }: { children?: ReactNode; style?: unknown; testID?: string }) =>
      createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(flattenStyle(style)) }, children),
  };
});

import { READABLE_CONTENT_WIDTH, ReadableColumn } from '../ReadableColumn';

function styleOf(container: HTMLElement, testID: string): Record<string, unknown> {
  const element = container.querySelector(`[data-testid="${testID}"]`);
  expect(element).not.toBeNull();
  return JSON.parse(element?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
}

describe('ReadableColumn', () => {
  beforeEach(() => {
    insets.value = { top: 0, right: 0, bottom: 0, left: 0 };
  });

  it('adds nothing on a portrait iPhone, which has no side insets', () => {
    const { container } = render(<ReadableColumn testID="column" />);
    const style = styleOf(container, 'column');

    expect(style.paddingLeft).toBeUndefined();
    expect(style.paddingRight).toBeUndefined();
    expect(style.maxWidth).toBe(READABLE_CONTENT_WIDTH);
  });

  it("pads clear of iPhone Duo's side tab rail and widens the cap by the same amount", () => {
    // INFERRED from a simulator log: a tab on the Duo's inner display in landscape.
    insets.value = { top: 0, right: 84, bottom: 34, left: 0 };
    const { container } = render(<ReadableColumn testID="column" />);
    const style = styleOf(container, 'column');

    expect(style.paddingLeft).toBe(0);
    expect(style.paddingRight).toBe(84);
    expect(style.maxWidth).toBe(READABLE_CONTENT_WIDTH + 84);
  });

  it('pads once when nested, as Profile nests SocialTab', () => {
    // Profile's page column holds SocialTab, which renders its own ReadableColumn.
    insets.value = { top: 0, right: 84, bottom: 34, left: 0 };
    const { container } = render(
      <ReadableColumn testID="profile-page">
        <ReadableColumn testID="social-tab" />
      </ReadableColumn>,
    );

    expect(styleOf(container, 'profile-page').paddingRight).toBe(84);
    const inner = styleOf(container, 'social-tab');
    expect(inner.paddingRight).toBeUndefined();
    expect(inner.maxWidth).toBe(READABLE_CONTENT_WIDTH);
  });

  it('lets a caller style still win over the column defaults', () => {
    insets.value = { top: 0, right: 84, bottom: 34, left: 0 };
    const { container } = render(<ReadableColumn testID="column" style={{ flex: 1 }} />);

    expect(styleOf(container, 'column')).toMatchObject({ flex: 1, paddingRight: 84 });
  });
});
