// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const ctrl = vi.hoisted(() => ({
  variant: 'material' as 'material' | 'liquidGlass',
  os: 'android' as 'ios' | 'android' | 'web',
}));
type AlertButton = { text: string; style?: string; onPress?: () => void };
type ActionSheetCall = {
  options: {
    title?: string;
    message?: string;
    options: string[];
    destructiveButtonIndex?: number;
    cancelButtonIndex?: number;
    anchor?: number;
  };
  callback: (buttonIndex: number) => void;
};
const actionSheetMock = vi.hoisted(() => ({ calls: [] as ActionSheetCall[] }));
const alertMock = vi.hoisted(() => ({
  calls: [] as Array<{ title: string; message?: string; buttons: AlertButton[]; onDismiss?: () => void }>,
}));
const nativeModalMock = vi.hoisted(() => ({ onRequestClose: undefined as (() => void) | undefined }));

// The provider needs Alert + Platform + StyleSheet from react-native; mock them
// (Platform.OS controls the Android native host, web Portal, and iOS Alert).
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return ctrl.os;
    },
  },
  StyleSheet: { create: (sheet: Record<string, unknown>) => sheet },
  Modal: ({
    children,
    visible,
    transparent,
    onRequestClose,
  }: {
    children?: ReactNode;
    visible?: boolean;
    transparent?: boolean;
    onRequestClose?: () => void;
  }) => {
    nativeModalMock.onRequestClose = onRequestClose;
    return visible
      ? createElement('div', { 'data-native-modal': 'true', 'data-transparent': String(transparent) }, children)
      : null;
  },
  ActionSheetIOS: {
    showActionSheetWithOptions: (options: ActionSheetCall['options'], callback: ActionSheetCall['callback']) => {
      actionSheetMock.calls.push({ options, callback });
    },
  },
  Alert: {
    alert: (
      title: string,
      message: string | undefined,
      buttons: AlertButton[],
      options?: { onDismiss?: () => void },
    ) => {
      alertMock.calls.push({ title, message, buttons, onDismiss: options?.onDismiss });
    },
  },
}));

// Mark the two possible hosts separately: a root Portal cannot draw above an
// Android native sheet window. Buttons remain clickable for queue behavior.
vi.mock('react-native-paper', () => {
  const Dialog = ({ children }: { children?: ReactNode }) => createElement('div', { 'data-dialog': 'true' }, children);
  Dialog.Title = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  Dialog.Content = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  Dialog.Actions = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Portal: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-paper-portal': 'true' }, children),
    Dialog,
    Button: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
      createElement('button', { onClick: onPress }, children),
    Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  };
});

vi.mock('../theme-provider', () => ({
  useTheme: () => ({ variant: ctrl.variant, m3: { error: '#B00020' } }),
}));

import { DialogProvider, useChoose, useConfirm, type ChooseOptions } from '../dialog-provider';

let confirmFn: ReturnType<typeof useConfirm>;
let chooseFn: ReturnType<typeof useChoose>;
function Consumer() {
  confirmFn = useConfirm();
  chooseFn = useChoose();
  return null;
}

type CrossBoardValue = 'add' | 'switch' | 'cancel';
const CROSS_BOARD: ChooseOptions<CrossBoardValue> = {
  title: 'Climb from another board',
  message: 'This one is set on Tension.',
  options: [
    { value: 'add', label: 'Add anyway' },
    { value: 'switch', label: 'Switch board' },
    { value: 'cancel', label: 'Cancel', cancel: true },
  ],
  cancelValue: 'cancel',
};

function setup() {
  return render(createElement(DialogProvider, null, createElement(Consumer)));
}

function materialButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!button) throw new Error(`no dialog button labelled "${label}"`);
  return button as HTMLButtonElement;
}

const OPTS = { title: 'Delete?', message: 'This cannot be undone.', confirmLabel: 'Delete', cancelLabel: 'Cancel' };

beforeEach(() => {
  ctrl.variant = 'material';
  ctrl.os = 'android';
  alertMock.calls = [];
  actionSheetMock.calls = [];
  nativeModalMock.onRequestClose = undefined;
});

describe('useConfirm — Android Material (Paper Dialog)', () => {
  it('hosts the Paper dialog directly in a transparent native window above sheets', () => {
    const { container } = setup();
    act(() => {
      void confirmFn(OPTS);
    });
    const host = container.querySelector('[data-native-modal]');
    expect(host).not.toBeNull();
    expect(host?.getAttribute('data-transparent')).toBe('true');
    expect(host?.querySelector('[data-dialog]')).not.toBeNull();
    expect(container.querySelector('[data-paper-portal]')).toBeNull();
    expect(alertMock.calls).toHaveLength(0);
  });

  it('cancels only the current prompt on Android back and presents the next', async () => {
    const { container } = setup();
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = confirmFn({ ...OPTS, confirmLabel: 'First' });
      second = confirmFn({ ...OPTS, confirmLabel: 'Second' });
    });
    const dismissFirst = nativeModalMock.onRequestClose;
    expect(dismissFirst).toBeDefined();
    act(() => {
      dismissFirst?.();
      dismissFirst?.();
    });
    await expect(first).resolves.toBe(false);
    expect(container.querySelector('[data-native-modal] [data-dialog]')).not.toBeNull();
    act(() => materialButton(container, 'Second').click());
    await expect(second).resolves.toBe(true);
    expect(container.querySelector('[data-native-modal]')).toBeNull();
  });

  it('resolves true when the confirm action is pressed', async () => {
    const { container } = setup();
    let promise!: Promise<boolean>;
    act(() => {
      promise = confirmFn({ ...OPTS, destructive: true });
    });
    act(() => materialButton(container, 'Delete').click());
    await expect(promise).resolves.toBe(true);
  });

  it('resolves false when cancelled', async () => {
    const { container } = setup();
    let promise!: Promise<boolean>;
    act(() => {
      promise = confirmFn(OPTS);
    });
    act(() => materialButton(container, 'Cancel').click());
    await expect(promise).resolves.toBe(false);
  });

  it('queues concurrent confirms and resolves each independently', async () => {
    const { container } = setup();
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = confirmFn({ ...OPTS, confirmLabel: 'First' });
      second = confirmFn({ ...OPTS, confirmLabel: 'Second' });
    });
    // Only the head of the queue shows.
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Second')).toBe(false);
    act(() => materialButton(container, 'First').click());
    await expect(first).resolves.toBe(true);
    // The second confirm now surfaces and resolves on its own.
    act(() => materialButton(container, 'Second').click());
    await expect(second).resolves.toBe(true);
  });

  it('settles each confirm once — a re-press / dismiss race cannot drop the next confirm', async () => {
    const { container } = setup();
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = confirmFn({ ...OPTS, confirmLabel: 'First' });
      second = confirmFn({ ...OPTS, confirmLabel: 'Second' });
    });
    // Double-tap the first confirm's action in the same tick (the race the
    // one-shot guard protects): it must resolve once and NOT pop the second.
    const firstButton = materialButton(container, 'First');
    act(() => {
      firstButton.click();
      firstButton.click();
    });
    await expect(first).resolves.toBe(true);
    // The second confirm survived and still resolves on its own.
    act(() => materialButton(container, 'Second').click());
    await expect(second).resolves.toBe(true);
  });
});

describe('useConfirm — web Material', () => {
  it('keeps the Paper dialog in the web Portal', async () => {
    ctrl.os = 'web';
    const { container } = setup();
    let promise!: Promise<boolean>;
    act(() => {
      promise = confirmFn(OPTS);
    });
    expect(container.querySelector('[data-paper-portal] [data-dialog]')).not.toBeNull();
    expect(container.querySelector('[data-native-modal]')).toBeNull();
    act(() => materialButton(container, 'Delete').click());
    await expect(promise).resolves.toBe(true);
  });
});

describe('useConfirm — iOS Material (native Alert, not the Paper Portal)', () => {
  beforeEach(() => {
    ctrl.variant = 'material';
    ctrl.os = 'ios';
  });

  it('uses Alert on iOS even on Material (the Paper Portal renders under FullWindowOverlay sheets)', async () => {
    const { container } = setup();
    let promise!: Promise<boolean>;
    act(() => {
      promise = confirmFn(OPTS);
    });
    // No Paper dialog rendered; routed to the native Alert instead.
    expect(container.querySelector('[data-dialog]')).toBeNull();
    expect(alertMock.calls).toHaveLength(1);
    act(() => alertMock.calls[0].buttons.find((b) => b.text === 'Delete')?.onPress?.());
    await expect(promise).resolves.toBe(true);
  });
});

describe('useConfirm — Liquid Glass (native Alert)', () => {
  beforeEach(() => {
    ctrl.variant = 'liquidGlass';
  });

  it('routes to Alert.alert and resolves true on the confirm button', async () => {
    setup();
    let promise!: Promise<boolean>;
    act(() => {
      promise = confirmFn({ ...OPTS, destructive: true });
    });
    expect(alertMock.calls).toHaveLength(1);
    const { buttons } = alertMock.calls[0];
    expect(buttons.find((b) => b.text === 'Delete')?.style).toBe('destructive');
    act(() => buttons.find((b) => b.text === 'Delete')?.onPress?.());
    await expect(promise).resolves.toBe(true);
  });

  it('resolves false on cancel and on scrim/back dismiss', async () => {
    setup();
    let cancelled!: Promise<boolean>;
    act(() => {
      cancelled = confirmFn(OPTS);
    });
    act(() => alertMock.calls[0].buttons.find((b) => b.text === 'Cancel')?.onPress?.());
    await expect(cancelled).resolves.toBe(false);

    let dismissed!: Promise<boolean>;
    act(() => {
      dismissed = confirmFn(OPTS);
    });
    act(() => alertMock.calls[1].onDismiss?.());
    await expect(dismissed).resolves.toBe(false);
  });
});

describe('useChoose — three actions on Android Material (Paper Dialog)', () => {
  it('resolves the picked action, not a boolean', async () => {
    const { container } = setup();
    let promise!: Promise<CrossBoardValue>;
    act(() => {
      promise = chooseFn(CROSS_BOARD);
    });
    // All three actions are rendered, in the order given.
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Add anyway',
      'Switch board',
      'Cancel',
    ]);
    act(() => materialButton(container, 'Switch board').click());
    await expect(promise).resolves.toBe('switch');
  });

  it('settles three concurrent prompts each with their OWN value', async () => {
    const { container } = setup();
    let first!: Promise<CrossBoardValue>;
    let second!: Promise<CrossBoardValue>;
    let third!: Promise<CrossBoardValue>;
    act(() => {
      first = chooseFn({ ...CROSS_BOARD, title: 'First' });
      second = chooseFn({ ...CROSS_BOARD, title: 'Second' });
      third = chooseFn({ ...CROSS_BOARD, title: 'Third' });
    });
    act(() => materialButton(container, 'Add anyway').click());
    await expect(first).resolves.toBe('add');
    act(() => materialButton(container, 'Switch board').click());
    await expect(second).resolves.toBe('switch');
    act(() => materialButton(container, 'Cancel').click());
    await expect(third).resolves.toBe('cancel');
  });

  it('settles once per prompt — a double-tap cannot answer the next one too', async () => {
    const { container } = setup();
    let first!: Promise<CrossBoardValue>;
    let second!: Promise<CrossBoardValue>;
    act(() => {
      first = chooseFn({ ...CROSS_BOARD, title: 'First' });
      second = chooseFn({ ...CROSS_BOARD, title: 'Second' });
    });
    const addButton = materialButton(container, 'Add anyway');
    act(() => {
      addButton.click();
      addButton.click();
    });
    await expect(first).resolves.toBe('add');
    // The second prompt survived the double-tap and answers independently.
    act(() => materialButton(container, 'Switch board').click());
    await expect(second).resolves.toBe('switch');
  });
});

describe('useChoose — three actions on the native Alert', () => {
  beforeEach(() => {
    ctrl.variant = 'liquidGlass';
  });

  it('hands Alert all three buttons with cancel styled last', async () => {
    setup();
    let promise!: Promise<CrossBoardValue>;
    act(() => {
      promise = chooseFn(CROSS_BOARD);
    });
    expect(alertMock.calls).toHaveLength(1);
    const { buttons } = alertMock.calls[0];
    expect(buttons.map((button) => button.text)).toEqual(['Add anyway', 'Switch board', 'Cancel']);
    expect(buttons[0].style).toBeUndefined();
    expect(buttons[2].style).toBe('cancel');
    act(() => buttons[0].onPress?.());
    await expect(promise).resolves.toBe('add');
  });

  it('resolves cancelValue on scrim / back dismiss', async () => {
    setup();
    let promise!: Promise<CrossBoardValue>;
    act(() => {
      promise = chooseFn(CROSS_BOARD);
    });
    act(() => alertMock.calls[0].onDismiss?.());
    await expect(promise).resolves.toBe('cancel');
  });
});

describe('useConfirm — destructive confirms on iOS are a confirmation dialog (action sheet)', () => {
  beforeEach(() => {
    ctrl.os = 'ios';
  });

  it.each(['liquidGlass', 'material'] as const)('uses an action sheet, not an Alert, on %s', async (variant) => {
    ctrl.variant = variant;
    setup();
    let promise!: Promise<boolean>;
    act(() => {
      promise = confirmFn({ ...OPTS, destructive: true });
    });
    expect(alertMock.calls).toHaveLength(0);
    expect(actionSheetMock.calls).toHaveLength(1);
    const [{ options, callback }] = actionSheetMock.calls;
    expect(options.title).toBe('Delete?');
    expect(options.message).toBe('This cannot be undone.');
    expect(options.options[options.destructiveButtonIndex ?? -1]).toBe('Delete');
    expect(options.options[options.cancelButtonIndex ?? -1]).toBe('Cancel');
    expect(options).not.toHaveProperty('anchor');
    act(() => callback(options.destructiveButtonIndex ?? -1));
    await expect(promise).resolves.toBe(true);
  });

  it('resolves false on Cancel (also what a tap outside the sheet reports)', async () => {
    setup();
    let promise!: Promise<boolean>;
    act(() => {
      promise = confirmFn({ ...OPTS, destructive: true });
    });
    const [{ options, callback }] = actionSheetMock.calls;
    act(() => callback(options.cancelButtonIndex ?? -1));
    await expect(promise).resolves.toBe(false);
  });

  it('points the iPad popover at the source control when the caller knows it', () => {
    setup();
    act(() => {
      void confirmFn({ ...OPTS, destructive: true, anchor: 42 });
    });
    expect(actionSheetMock.calls[0].options.anchor).toBe(42);
  });

  it('keeps a non-destructive confirm as an Alert', () => {
    setup();
    act(() => {
      void confirmFn(OPTS);
    });
    expect(actionSheetMock.calls).toHaveLength(0);
    expect(alertMock.calls).toHaveLength(1);
  });

  it('keeps the M3 dialog for a destructive confirm on Android', () => {
    ctrl.os = 'android';
    const { container } = setup();
    act(() => {
      void confirmFn({ ...OPTS, destructive: true });
    });
    expect(actionSheetMock.calls).toHaveLength(0);
    expect(container.querySelector('[data-dialog]')).not.toBeNull();
  });
});
