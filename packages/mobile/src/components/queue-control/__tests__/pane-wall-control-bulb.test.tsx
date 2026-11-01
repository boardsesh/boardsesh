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
    accessibilityActions,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    onLongPress?: () => void;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityActions?: { label?: string }[];
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        onClick: onPress,
        onContextMenu: onLongPress,
        'aria-label': accessibilityLabel,
        'data-hint': accessibilityHint,
        'data-actions': (accessibilityActions ?? []).map((action) => action.label).join('|'),
      },
      children,
    ),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#888' },
    brandColors: { warning: '#FBBF24', primary: '#6D28D9' },
  }),
}));
vi.mock('../../../hooks/use-differentiate-without-color', () => ({ useDifferentiateWithoutColor: () => 'off' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

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
  bulbTapAction: 'disconnect',
  bulbA11yHintKey: 'litHint',
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

  // #7113: a bulb draws no frost, so while driving it still says a tap disconnects.
  it('says a tap disconnects while driving, not that it stops', () => {
    const { getByRole } = renderBulb({
      ...LIT,
      driving: true,
      tapAction: 'stop_driving',
      labelKey: 'youAreDriving',
      a11yHintKey: 'stopDrivingHint',
    });
    expect(getByRole('button').getAttribute('data-hint')).toBe('playView.wallControl.litHint');
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
