// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react';

// The header owns the ⋯ menu, and the menu reports a POSITION. The row set
// changes with editor state — Woods drops the route rows, a one-frame route has
// no frame to delete — so a stale index-to-action assumption would quietly fire
// the wrong command. These pin that the header resolves a tap through the rows
// it actually rendered.

type ViewMockProps = { children?: ReactNode; testID?: string };
vi.mock('react-native', () => ({
  View: ({ children, testID }: ViewMockProps) => createElement('div', { 'data-testid': testID }, children),
  TextInput: forwardRef(function TextInputMock(_props: unknown, ref) {
    useImperativeHandle(ref, () => ({ focus: () => undefined }));
    return createElement('input');
  }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, number | string>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name?: string }) => createElement('span', { 'data-icon': name }) }));
// One button per row, in the order the header handed them over — enough to fire
// a specific POSITION, which is the thing under test.
vi.mock('../../AppMenu', () => ({
  AppMenu: ({
    actions,
    onSelectIndex,
    accessibilityLabel,
  }: {
    actions: { label: string; disabled?: boolean }[];
    onSelectIndex: (index: number) => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'div',
      { 'data-node': 'overflow', 'data-label': accessibilityLabel },
      actions.map((action, index) =>
        createElement('button', {
          key: action.label,
          'data-row': action.label,
          'data-disabled': action.disabled ? 'true' : 'false',
          onClick: () => onSelectIndex(index),
        }),
      ),
    ),
}));
// The trailing Save, drawn as a plain button carrying what the header handed it.
vi.mock('../../SheetTopBar', () => ({
  // The X, drawn as a plain button carrying what the header handed it.
  SheetTopBarLeadingButton: ({
    kind,
    onPress,
    accessibilityLabel,
    accessibilityHint,
  }: {
    kind: string;
    onPress: () => void;
    accessibilityLabel?: string;
    accessibilityHint?: string;
  }) =>
    createElement('button', {
      'data-node': 'close',
      'data-kind': kind,
      'data-label': accessibilityLabel,
      'data-hint': accessibilityHint,
      onClick: onPress,
    }),
  SheetTopBarTrailingButton: ({
    label,
    accessibilityLabel,
    onPress,
    disabled,
    loading,
    prominent,
    icon,
    accessibilityHint,
  }: {
    label: string;
    accessibilityLabel?: string;
    onPress: () => void;
    disabled?: boolean;
    loading?: boolean;
    prominent?: boolean;
    icon?: string;
    accessibilityHint?: string;
  }) =>
    createElement('button', {
      'data-node': 'save',
      'data-label': accessibilityLabel,
      'data-loading': loading ? 'true' : 'false',
      'data-prominent': prominent ? 'true' : 'false',
      'data-icon': icon,
      'data-hint': accessibilityHint,
      disabled: disabled || loading,
      onClick: onPress,
      children: label,
    }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#000', secondaryLabel: '#666', fill: '#EEE' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));

import { CreateDrawerHeader } from '../CreateDrawerHeader';
import type { SaveButtonState } from '../use-create-climb-screen';

function renderHeader(
  overflow: Partial<Parameters<typeof CreateDrawerHeader>[0]['overflow']> = {},
  { saveState = 'ready', climbReady = true }: { saveState?: SaveButtonState; climbReady?: boolean } = {},
) {
  const onSelectOverflowAction = vi.fn();
  const onSave = vi.fn();
  const onClose = vi.fn();
  const { container } = render(
    createElement(CreateDrawerHeader, {
      name: 'Test climb',
      onChangeName: vi.fn(),
      startingCount: 0,
      finishCount: 0,
      focusSignal: 0,
      onClose,
      overflow: { supportsMultiFrame: true, routeMode: false, frameCount: 1, ...overflow },
      onSelectOverflowAction,
      saveState,
      onSave,
      climbReady,
    }),
  );
  // Looked up by scanning rather than a CSS selector: a label may carry
  // interpolated JSON, whose quotes and braces are not selector-safe.
  const row = (label: string) =>
    (Array.from(container.querySelectorAll('[data-row]')).find((node) => node.getAttribute('data-row') === label) ??
      null) as HTMLButtonElement | null;
  const save = container.querySelector('[data-node="save"]') as HTMLButtonElement;
  const close = container.querySelector('[data-node="close"]') as HTMLButtonElement;
  return { container, onSelectOverflowAction, onSave, onClose, row, save, close };
}

describe('CreateDrawerHeader overflow menu', () => {
  it('labels the anchor, which is the only text a glyph trigger has', () => {
    const { container } = renderHeader();
    expect(container.querySelector('[data-node="overflow"]')?.getAttribute('data-label')).toBe(
      'mobile.create.routeMenu.open',
    );
  });

  it('fires Make it a route from a boulder', () => {
    const { onSelectOverflowAction, row } = renderHeader();
    row('mobile.create.routeMenu.makeRoute')?.click();
    expect(onSelectOverflowAction).toHaveBeenCalledWith('makeRoute');
  });

  it('resolves a tap through the rows the CURRENT state rendered', () => {
    // A boulder's first row is Make it a route; a route's is Make it a boulder.
    // Resolving by position against a stale row set would fire the wrong one.
    const { onSelectOverflowAction, row } = renderHeader({ routeMode: true, frameCount: 4 });

    expect(row('mobile.create.routeMenu.makeRoute')).toBeNull();

    row('mobile.create.actions.newClimb')?.click();
    expect(onSelectOverflowAction).toHaveBeenLastCalledWith('newClimb');
  });

  it('resolves the FIRST row on a board that renders fewer of them', () => {
    // With the frame commands gone, Woods is the only state whose menu is a
    // different LENGTH — one row where every other state has two. Index 0 there
    // is newClimb, not the makeRoute that sits at 0 everywhere else, so this is
    // what guards the header's index-to-action mapping against a stale row set.
    const { onSelectOverflowAction, container } = renderHeader({ supportsMultiFrame: false });
    const rows = Array.from(container.querySelectorAll('[data-row]')) as HTMLButtonElement[];

    expect(rows).toHaveLength(1);
    rows[0]?.click();
    expect(onSelectOverflowAction).toHaveBeenLastCalledWith('newClimb');
  });

  it('marks the blocked route-to-boulder row disabled rather than dropping it', () => {
    const { row } = renderHeader({ routeMode: true, frameCount: 4 });
    expect(row('mobile.create.routeMenu.makeBoulderBlocked')?.getAttribute('data-disabled')).toBe('true');
  });

  it('offers no route rows on a board that can only hold one frame', () => {
    const { row } = renderHeader({ supportsMultiFrame: false });
    expect(row('mobile.create.routeMenu.makeRoute')).toBeNull();
    expect(row('mobile.create.actions.newClimb')).not.toBeNull();
  });
});

// Every extra 44pt in this bar comes out of the name field, which a French or
// German Save already narrows. The lightbulb moved to the tool row for that.
describe('CreateDrawerHeader contents', () => {
  it('holds only close, the name, the overflow menu and Save', () => {
    const { container } = renderHeader();
    const bar = container.firstElementChild as HTMLElement;
    const parts = Array.from(bar.children).map((child) => {
      if (child.getAttribute('data-node')) return child.getAttribute('data-node');
      if (child.querySelector('input')) return 'name';
      return child.tagName;
    });
    expect(parts).toEqual(['close', 'name', 'overflow', 'save']);
    expect(container.querySelector('[data-ble]')).toBeNull();
  });
});

// A modal task's way out is an X on the leading edge (HIG): leaving loses
// nothing, because the draft stays on this phone. There is no minimise any more.
describe('CreateDrawerHeader X', () => {
  it('is the top bar close X, not a collapse chevron, and says the draft is kept', () => {
    const { close } = renderHeader();
    expect(close.getAttribute('data-kind')).toBe('close');
    expect(close.getAttribute('data-label')).toBe('mobile.create.actions.close');
    expect(close.getAttribute('data-hint')).toBe('mobile.create.actions.closeHint');
  });

  it('leaves through onClose', () => {
    const { close, onClose } = renderHeader();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('CreateDrawerHeader Save', () => {
  it('puts Save last in the header, prominent, and fires it', () => {
    const { container, save, onSave } = renderHeader();
    expect(save).toBeTruthy();
    expect(save.getAttribute('data-prominent')).toBe('true');
    expect(save.textContent).toBe('mobile.create.save.idle');
    // Trailing: nothing follows it in the bar.
    const buttons = Array.from(container.querySelectorAll('button, [data-ble]'));
    expect(buttons[buttons.length - 1]).toBe(save);
    save.click();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('stays disabled until the climb is ready, with the counts showing what is missing', () => {
    const notReady = renderHeader({}, { climbReady: false });
    expect(notReady.save.disabled).toBe(true);
    expect(notReady.container.textContent).toContain('mobile.create.counts.start');
    notReady.save.click();
    expect(notReady.onSave).not.toHaveBeenCalled();

    const ready = renderHeader({}, { climbReady: true });
    expect(ready.save.disabled).toBe(false);
  });

  it('shows the spinner while saving, and refuses a second press', () => {
    const { save, onSave } = renderHeader({}, { saveState: 'saving' });
    expect(save.getAttribute('data-loading')).toBe('true');
    expect(save.getAttribute('data-label')).toBe('mobile.create.save.saving');
    save.click();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps the signed-out Save live, so the tap can go to sign-in', () => {
    const { save } = renderHeader({}, { saveState: 'login', climbReady: false });
    expect(save.disabled).toBe(false);
    expect(save.getAttribute('data-label')).toBe('mobile.create.save.login');
  });

  it('marks a climb past its edit window with a lock and says why', () => {
    const { save } = renderHeader({}, { saveState: 'editLocked' });
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('data-icon')).toBe('lock');
    expect(save.getAttribute('data-hint')).toBe('createClimbForm.alerts.editWindowExpired');

    // Not ready is plain: no lock, so the two never look alike.
    const notReady = renderHeader({}, { climbReady: false });
    expect(notReady.save.getAttribute('data-icon')).toBeNull();
  });
});
