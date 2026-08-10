// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { flattenStyle } from '../../../../test/flatten-style';
import type { ButtonProps } from '../../Button.types';

const buttonCalls = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  PlatformColor: (name: string) => name,
  View: ({ children, style, testID }: { children?: ReactNode; style?: unknown; testID?: string }) =>
    createElement('div', { 'data-style': JSON.stringify(style ?? null), 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

// Capture what the native Button primitive is handed — the 1:2 split lives in
// the style it receives, not in anything it renders.
vi.mock('../../Button', () => ({
  Button: (props: ButtonProps) => {
    buttonCalls.props.push(props as unknown as Record<string, unknown>);
    return createElement('button', { 'data-variant': props.variant }, props.title);
  },
}));

vi.mock('../../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: unknown }) =>
    createElement('span', { 'data-color': String(color) }, children),
}));

vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));

vi.mock('../../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../../test/theme-mock');
  const theme = makeThemeMock();
  return { useTheme: () => theme };
});

import { TickActionBar } from '../TickActionBar';
import { TICK_ERROR_SLOT_HEIGHT } from '../tick-sheet-metrics';
import { brandColors } from '../../../theme/colors';

function renderBar(props: Partial<Parameters<typeof TickActionBar>[0]> = {}) {
  return render(
    createElement(TickActionBar, {
      primary: { title: 'Send', onPress: vi.fn() },
      ...props,
    }),
  );
}

function styleOf(container: HTMLElement, testID: string): Record<string, unknown> {
  const node = container.querySelector(`[data-testid="${testID}"]`);
  return flattenStyle(JSON.parse(node?.getAttribute('data-style') ?? 'null'));
}

describe('TickActionBar', () => {
  beforeEach(() => {
    buttonCalls.props.length = 0;
  });

  it('gives the primary twice the secondary width when both are present', () => {
    renderBar({ secondary: { title: 'Attempt', onPress: vi.fn() } });

    const [secondary, primary] = buttonCalls.props;
    expect(secondary.title).toBe('Attempt');
    expect(flattenStyle(secondary.style).flex).toBe(1);
    expect(primary.title).toBe('Send');
    expect(flattenStyle(primary.style).flex).toBe(2);
  });

  it('fills the bar with the primary when there is no secondary', () => {
    renderBar();

    expect(buttonCalls.props).toHaveLength(1);
    expect(flattenStyle(buttonCalls.props[0].style).flex).toBe(1);
  });

  it('reserves the error slot when there is no error, so a failed save never moves the buttons', () => {
    const atRest = renderBar();
    const restSlot = styleOf(atRest.container, 'tick-action-error-slot');
    const restRow = styleOf(atRest.container, 'tick-action-row');
    expect(restSlot.minHeight).toBe(TICK_ERROR_SLOT_HEIGHT);
    expect(atRest.container.querySelector('[data-testid="tick-action-error-slot"]')?.childNodes).toHaveLength(0);

    const failed = renderBar({ error: "Couldn't save your tick" });
    expect(styleOf(failed.container, 'tick-action-error-slot')).toEqual(restSlot);
    expect(styleOf(failed.container, 'tick-action-row')).toEqual(restRow);
  });

  it('prints the failure in the brand error colour', () => {
    const { container } = renderBar({ error: "Couldn't save your tick" });

    const message = container.querySelector('[data-testid="tick-action-error-slot"] span');
    expect(message?.textContent).toBe("Couldn't save your tick");
    expect(message?.getAttribute('data-color')).toBe(brandColors.error);
    expect(container.querySelector('[data-icon="warning"]')).not.toBeNull();
  });
});
