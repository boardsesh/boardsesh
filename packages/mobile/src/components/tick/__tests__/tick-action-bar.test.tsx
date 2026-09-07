// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { flattenStyle } from '../../../../test/flatten-style';
import type { ButtonProps } from '../../Button.types';

const buttonCalls = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
// The OS text scale the component reads. Every test but the Dynamic-Type one
// leaves it at 1.
const screen = vi.hoisted(() => ({ fontScale: 1 }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  PlatformColor: (name: string) => name,
  View: ({
    children,
    style,
    testID,
    accessibilityRole,
    accessibilityLiveRegion,
  }: {
    children?: ReactNode;
    style?: unknown;
    testID?: string;
    accessibilityRole?: string;
    accessibilityLiveRegion?: string;
  }) =>
    createElement(
      'div',
      {
        'data-style': JSON.stringify(style ?? null),
        'data-testid': testID,
        'data-a11y-role': accessibilityRole,
        'data-a11y-live': accessibilityLiveRegion,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: screen.fontScale }),
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
import { TICK_ACTION_HEIGHT, TICK_ERROR_SLOT_HEIGHT, tickActionHeight } from '../tick-sheet-metrics';
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
    screen.fontScale = 1;
  });

  // The style each Button was handed, by role. Reading the spy by index breaks
  // the moment a render order or a render count changes; the title is what the
  // assertion actually means.
  function buttonStyle(title: string): Record<string, unknown> {
    const call = buttonCalls.props.find((props) => props.title === title);
    expect(call, `no Button rendered with title ${title}`).toBeDefined();
    return flattenStyle(call?.style);
  }

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

  it('holds its shape when the keyboard squeezes the column', () => {
    // ModalSheet pads the bottom by the keyboard height INSIDE a fixed-height
    // column, so everything above competes for what is left. Not this row.
    const { container } = renderBar();
    const row = styleOf(container, 'tick-action-row');

    expect(row.flexShrink).toBe(0);
    expect(row.alignItems).toBe('center');
    expect(row.minHeight).toBe(TICK_ACTION_HEIGHT);
  });

  it('pins both buttons to one height, so the tonal and filled pills cannot measure apart', () => {
    renderBar({ secondary: { title: 'Attempt', onPress: vi.fn() } });

    expect(buttonStyle('Attempt').height).toBe(TICK_ACTION_HEIGHT);
    expect(buttonStyle('Send').height).toBe(TICK_ACTION_HEIGHT);
  });

  it('pins the height of a lone primary too', () => {
    renderBar();

    expect(buttonStyle('Send').height).toBe(TICK_ACTION_HEIGHT);
  });

  it('grows the shared height with the OS text scale, and still shares it', () => {
    screen.fontScale = 2;
    renderBar({ secondary: { title: 'Attempt', onPress: vi.fn() } });

    const grown = tickActionHeight(2);
    expect(grown).toBeGreaterThan(TICK_ACTION_HEIGHT);
    expect(buttonStyle('Attempt').height).toBe(grown);
    expect(buttonStyle('Send').height).toBe(grown);
    // The flex split is not what the text scale moves.
    expect(buttonStyle('Attempt').flex).toBe(1);
    expect(buttonStyle('Send').flex).toBe(2);
  });

  it('announces a failure: these used to go through showToast, which announced', () => {
    // On the ALWAYS-mounted slot, not on the message — a live region that mounts
    // with its content is announced inconsistently, and moving it would give up
    // the reserved height that keeps the buttons still on a failed save.
    for (const props of [{}, { error: "Couldn't save your tick" }]) {
      const { container } = renderBar(props);
      const slot = container.querySelector('[data-testid="tick-action-error-slot"]');
      expect(slot?.getAttribute('data-a11y-role')).toBe('alert');
      expect(slot?.getAttribute('data-a11y-live')).toBe('assertive');
    }
  });

  it('prints the failure in the brand error colour', () => {
    const { container } = renderBar({ error: "Couldn't save your tick" });

    const message = container.querySelector('[data-testid="tick-action-error-slot"] span');
    expect(message?.textContent).toBe("Couldn't save your tick");
    expect(message?.getAttribute('data-color')).toBe(brandColors.error);
    expect(container.querySelector('[data-icon="warning"]')).not.toBeNull();
  });
});
