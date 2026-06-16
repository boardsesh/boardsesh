// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const ctrl = vi.hoisted(() => ({
  variant: 'material' as 'material' | 'liquidGlass',
  os: 'android' as 'ios' | 'android',
}));
type AlertButton = { text: string; style?: string; onPress?: () => void };
const alertMock = vi.hoisted(() => ({
  calls: [] as Array<{ title: string; message?: string; buttons: AlertButton[]; onDismiss?: () => void }>,
}));

// The provider needs Alert + Platform from react-native; mock both (Platform.OS is
// controllable because the Paper dialog is Android-Material-only — iOS uses Alert).
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return ctrl.os;
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

// Lightweight Paper stubs: Dialog renders its children inline (Portal is a
// pass-through), Buttons are real <button>s so we can click them.
vi.mock('react-native-paper', () => {
  const Dialog = ({ children }: { children?: ReactNode }) => createElement('div', { 'data-dialog': 'true' }, children);
  Dialog.Title = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  Dialog.Content = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  Dialog.Actions = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Portal: ({ children }: { children?: ReactNode }) => children,
    Dialog,
    Button: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
      createElement('button', { onClick: onPress }, children),
    Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  };
});

vi.mock('../theme-provider', () => ({
  useTheme: () => ({ variant: ctrl.variant, m3: { error: '#B00020' } }),
}));

import { DialogProvider, useConfirm } from '../dialog-provider';

let confirmFn: ReturnType<typeof useConfirm>;
function Consumer() {
  confirmFn = useConfirm();
  return null;
}

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
});

describe('useConfirm — Android Material (Paper Dialog)', () => {
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
