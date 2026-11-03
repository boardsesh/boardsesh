// @vitest-environment jsdom
// The open Duo's bar bulb over the pane's wall button (#7000): it draws the
// pane's model and runs the pane's own tap and hold.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    onLongPress,
    accessibilityLabel,
    accessibilityHint,
    accessibilityValue,
    accessibilityActions,
    style,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    onLongPress?: () => void;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityValue?: { text?: string };
    accessibilityActions?: { label?: string }[];
    style?: (state: { pressed: boolean }) => unknown;
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        'data-style': JSON.stringify(style?.({ pressed: false })),
        onClick: onPress,
        onContextMenu: onLongPress,
        'aria-label': accessibilityLabel,
        'data-hint': accessibilityHint,
        'data-value': accessibilityValue?.text,
        'data-actions': (accessibilityActions ?? []).map((action) => action.label).join('|'),
      },
      children,
    ),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#888' },
    brandColors: { warning: '#FBBF24', primary: '#6D28D9', live: '#FBBF24', onAccent: '#16111F', onPrimary: '#FFFFFF' },
    colorScheme: 'dark',
  }),
}));
vi.mock('../../../hooks/use-differentiate-without-color', () => ({ useDifferentiateWithoutColor: () => 'off' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../play-drawer/WallWindowRing', () => ({
  WallWindowRing: ({ size }: { size: number }) => createElement('s', { 'data-ring': String(size) }),
}));

import { PaneWallControlBulb } from '../PaneWallControlBulb';
import { EMPTY_WALL_CONTROL, type WallControlModel } from '../../play-drawer/wall-control';

afterEach(() => cleanup());

const LIT: WallControlModel = {
  ...EMPTY_WALL_CONTROL,
  state: 'lit',
  holder: 'self',
  tapAction: 'disconnect',
  longPress: 'sheet',
  labelKey: 'disconnectBoard',
  a11yValueKey: 'youHaveBoardLit',
  a11yHintKey: 'litHint',
  look: 'lit',
  selected: true,
};

function renderBulb(model: WallControlModel) {
  const press = vi.fn();
  const longPress = vi.fn();
  const view = render(createElement(PaneWallControlBulb, { control: { model, press, longPress } }));
  return { ...view, press, longPress };
}

describe('PaneWallControlBulb', () => {
  it('says what the covered wall button says, and runs the pane’s tap and hold', () => {
    const { getByRole, press, longPress } = renderBulb(LIT);
    const bulb = getByRole('button');
    expect(bulb.getAttribute('aria-label')).toBe(
      'playView.wallControl.disconnectBoard, playView.wallControl.youHaveBoardLit',
    );
    expect(bulb.getAttribute('data-hint')).toBe('playView.wallControl.litHint');
    expect(bulb.getAttribute('data-actions')).toBe('playView.wallControl.boardOptions');
    fireEvent.click(bulb);
    fireEvent.contextMenu(bulb);
    expect(press).toHaveBeenCalledOnce();
    expect(longPress).toHaveBeenCalledOnce();
  });

  // Owner, 2026-11-03: a bulb's tap during a drive only stops driving, so this
  // bulb says the button's stop hint, never that it disconnects.
  it.each([
    ['an open-ended drive', { tapAction: 'stop_driving' }],
    ["Put on board's timed drive", { tapAction: 'stop_window', lightWindow: true, look: 'driving' }],
  ] as [string, Partial<WallControlModel>][])('says a tap stops %s, not that it disconnects', (_drive, drive) => {
    const { getByRole, press } = renderBulb({
      ...LIT,
      driving: true,
      labelKey: 'youAreDriving',
      a11yHintKey: 'stopDrivingHint',
      ...drive,
    });
    const bulb = getByRole('button');
    expect(bulb.getAttribute('aria-label')).toContain('playView.wallControl.youAreDriving');
    expect(bulb.getAttribute('data-hint')).toBe('playView.wallControl.stopDrivingHint');
    fireEvent.click(bulb);
    expect(press).toHaveBeenCalledOnce();
  });

  // Beside a tablet's player this bulb stands in for the wall button: the timed
  // drive needs its cue here too, the Live Activity's pattern (owner decision
  // 2026-11-02): the lit look inside a draining ring, no number to re-render on.
  it("rings the timed drive's amber bulb, with no live number, only during the timed drive", () => {
    const windowed = renderBulb({
      ...LIT,
      look: 'driving',
      lightWindow: true,
      driving: true,
      tapAction: 'stop_window',
      labelKey: 'youAreDriving',
      a11yValueKey: null,
    });
    expect(windowed.container.querySelector('[data-ring]')).not.toBeNull();
    const bulb = windowed.getByRole('button');
    expect(bulb.getAttribute('aria-label')).toBe('playView.wallControl.youAreDriving');
    expect(bulb.getAttribute('data-value')).toBeNull();
    // The amber bulb alone inside the ring: no disc to hide the arc, no halo under it.
    expect(bulb.getAttribute('data-style')).not.toContain('backgroundColor');
    const glyph = windowed.container.querySelector('[data-icon]');
    expect(glyph?.getAttribute('data-icon')).toBe('lightbulb.fill');
    expect(glyph?.getAttribute('data-color')).toBe('#FBBF24');
    cleanup();
    const plain = renderBulb(LIT);
    expect(plain.container.querySelector('[data-ring]')).toBeNull();
    expect(plain.getByRole('button').getAttribute('data-value')).toBeNull();
  });

  it('fills an open-ended drive with the amber disc and draws no ring', () => {
    const { container, getByRole } = renderBulb({
      ...LIT,
      look: 'driving',
      driving: true,
      tapAction: 'stop_driving',
      labelKey: 'youAreDriving',
    });
    expect(container.querySelector('[data-ring]')).toBeNull();
    expect(getByRole('button').getAttribute('data-style')).toContain('"backgroundColor":"#FBBF24"');
    expect(container.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('lightbulb.fill');
    // Dark ink on the dark scheme's pale amber disc.
    expect(container.querySelector('[data-icon]')?.getAttribute('data-color')).toBe('#16111F');
  });

  it.each([
    ['lit', LIT, 'lightbulb.fill'],
    ['dark', { ...LIT, state: 'dark', look: 'ready' }, 'lightbulb'],
    ["a crewmate's", { ...LIT, state: 'crew', holder: 'crew', look: 'lit' }, 'person.fill'],
    ['no board', { ...EMPTY_WALL_CONTROL, state: 'connect' }, 'lightbulb'],
  ] as [string, WallControlModel, string][])('draws the %s board in the indicator’s glyphs', (_case, model, icon) => {
    expect(renderBulb(model).container.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe(icon);
  });

  it('offers no hold without a link, and nothing at all with nothing to offer', () => {
    const free = renderBulb({ ...EMPTY_WALL_CONTROL, state: 'connect', tapAction: 'connect' });
    expect(free.getByRole('button').getAttribute('data-actions')).toBe('');
    cleanup();
    expect(renderBulb(EMPTY_WALL_CONTROL).queryByRole('button')).toBeNull();
  });
});
