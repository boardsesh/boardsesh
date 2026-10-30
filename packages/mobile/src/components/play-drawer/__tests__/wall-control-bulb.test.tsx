// @vitest-environment jsdom
// The board control as the first row's bulb (#7000): it draws the model's look,
// words and face, and nothing it reads for itself, so the face goes with the link.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  View: ({ testID, children }: { testID?: string; children?: ReactNode }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}));
vi.mock('../../drawer-action-bar/DrawerActionBar', () => ({ SIZES: { lg: { dim: 48, icon: 28 } } }));
vi.mock('../../board-presence/BoardDriverAvatar', () => ({
  BoardDriverAvatar: ({ name }: { name?: string | null }) => createElement('i', { 'data-avatar': name ?? '?' }),
}));
vi.mock('../../ble/BleLightbulbButton', () => ({
  BleLightbulbButton: (props: {
    isConnected: boolean;
    ready?: boolean;
    accessibilityLabel: string;
    accessibilityValueText?: string;
    accessibilityTapHint?: string;
    accessibilitySelected?: boolean;
    longPressActionLabel?: string;
    longPressHaptic?: boolean;
    haptic?: string;
    writing?: boolean;
    isScanning?: boolean;
    onPress: () => void;
    onLongPress?: () => void;
  }) =>
    createElement('button', {
      type: 'button',
      onClick: props.onPress,
      onContextMenu: props.onLongPress,
      'aria-label': props.accessibilityLabel,
      'data-value': props.accessibilityValueText,
      'data-hint': props.accessibilityTapHint,
      'data-lit': String(props.isConnected),
      'data-ready': String(Boolean(props.ready)),
      'data-selected': String(Boolean(props.accessibilitySelected)),
      'data-hold': props.onLongPress ? props.longPressActionLabel : 'none',
      'data-own-haptics': `${props.haptic}/${String(props.longPressHaptic)}`,
      'data-writing': String(Boolean(props.writing)),
      'data-scanning': String(Boolean(props.isScanning)),
    }),
}));

import { WallControlBulb } from '../WallControlBulb';
import { EMPTY_WALL_CONTROL, type WallControlModel } from '../wall-control';

afterEach(() => cleanup());

const LIT: WallControlModel = {
  ...EMPTY_WALL_CONTROL,
  state: 'lit',
  holder: 'self',
  holderFace: { name: 'Me', avatarUrl: null },
  tapAction: 'disconnect',
  longPress: 'sheet',
  labelKey: 'disconnectBoard',
  a11yValueKey: 'youHaveBoardLit',
  a11yHintKey: 'litHint',
  bulbValueKey: 'youHaveBoardLit',
  look: 'lit',
  selected: true,
};

function renderBulb(model: WallControlModel, showFace?: boolean) {
  const onPress = vi.fn();
  const onLongPress = vi.fn();
  const view = render(createElement(WallControlBulb, { model, showFace, onPress, onLongPress }));
  return { ...view, onPress, onLongPress, bulb: view.getByRole('button') };
}

describe('WallControlBulb', () => {
  it('draws the model: filled when lit, its value, its hint, and "Board options" for the hold', () => {
    const { bulb } = renderBulb(LIT);
    expect(bulb.dataset).toMatchObject({
      lit: 'true',
      ready: 'false',
      selected: 'true',
      value: 'playView.wallControl.youHaveBoardLit',
      hint: 'playView.wallControl.litHint',
      hold: 'playView.wallControl.boardOptions',
    });
    expect(bulb.getAttribute('aria-label')).toBe('playView.wallControl.bulbAria');
  });

  it('wears the amber outline when linked but dark, and the grey one with no board', () => {
    expect(renderBulb({ ...LIT, state: 'dark', look: 'ready', selected: false }).bulb.dataset).toMatchObject({
      lit: 'false',
      ready: 'true',
    });
    cleanup();
    expect(renderBulb({ ...EMPTY_WALL_CONTROL, state: 'connect', look: 'off' }).bulb.dataset).toMatchObject({
      lit: 'false',
      ready: 'false',
      hold: 'none',
    });
  });

  it('shows the model’s face, none without a holder, and none while the back chip has it', () => {
    expect(renderBulb(LIT).container.querySelector('[data-avatar]')?.getAttribute('data-avatar')).toBe('Me');
    cleanup();
    expect(renderBulb({ ...LIT, holder: null, holderFace: null }).container.querySelector('[data-avatar]')).toBeNull();
    cleanup();
    expect(renderBulb(LIT, false).container.querySelector('[data-avatar]')).toBeNull();
  });

  it('leaves the buzz to the handler, and passes the tap and the hold through', () => {
    const { bulb, onPress, onLongPress } = renderBulb(LIT);
    expect(bulb.getAttribute('data-own-haptics')).toBe('none/false');
    fireEvent.click(bulb);
    fireEvent.contextMenu(bulb);
    expect(onPress).toHaveBeenCalledOnce();
    expect(onLongPress).toHaveBeenCalledOnce();
  });

  it('shows the scan and the write from the model', () => {
    const { bulb } = renderBulb({ ...LIT, pending: true, writing: true });
    expect(bulb.dataset).toMatchObject({ scanning: 'true', writing: 'true' });
  });
});
