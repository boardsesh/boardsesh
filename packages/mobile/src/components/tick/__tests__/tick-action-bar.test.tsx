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
import { TICK_ACTION_HEIGHT, TICK_ERROR_SLOT_HEIGHT } from '../tick-sheet-metrics';
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

  it('holds its shape when the keyboard squeezes the column', () => {
    // The sheet's column is a fixed height on iOS (the #3330 detent bound) and
    // ModalSheet's KeyboardAvoidingView pads the bottom by the keyboard height,
    // so everything inside is competing for what's left. This row must not be
    // what gives: a shrunk row stretches the native button hosts to whatever
    // height is left over and the two buttons stop lining up.
    const { container } = renderBar();
    const row = styleOf(container, 'tick-action-row');

    expect(row.flexShrink).toBe(0);
    expect(row.alignItems).toBe('center');
    expect(row.minHeight).toBe(TICK_ACTION_HEIGHT);
  });

  it('gives both buttons the same explicit height, not whatever their labels measure', () => {
    // `alignItems: 'center'` sizes each child to its own content, and a native
    // button host measures from its label — the filled primary also carries an
    // icon and a spinner, so the two would settle at different heights.
    const paired = renderBar({ secondary: { title: 'Attempt', onPress: vi.fn() } });
    const [secondary, primary] = buttonCalls.props;
    expect(flattenStyle(secondary.style).height).toBe(TICK_ACTION_HEIGHT);
    expect(flattenStyle(primary.style).height).toBe(TICK_ACTION_HEIGHT);
    paired.unmount();

    renderBar();
    expect(flattenStyle(buttonCalls.props[0].style).height).toBe(TICK_ACTION_HEIGHT);
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
