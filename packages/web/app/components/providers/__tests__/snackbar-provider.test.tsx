import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { browserSessionGuard } from '@/app/lib/auth/session-guard';
import { SnackbarProvider, useSnackbar } from '../snackbar-provider';

const GUARD_KEY = Symbol.for('boardsesh.web-session-guard.v1');
type ShowMessage = ReturnType<typeof useSnackbar>['showMessage'];

let latestShowMessage: ShowMessage | undefined;
let consumerRenders = 0;
const Consumer = React.memo(function Consumer() {
  latestShowMessage = useSnackbar().showMessage;
  consumerRenders += 1;
  return null;
});

function renderSnackbar() {
  render(
    <SnackbarProvider>
      <Consumer />
    </SnackbarProvider>,
  );
  if (!latestShowMessage) throw new Error('Consumer did not render');
  return latestShowMessage;
}

const alertTexts = () => screen.queryAllByRole('alert').map((alert) => alert.textContent);

beforeEach(() => {
  delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[GUARD_KEY];
  latestShowMessage = undefined;
  consumerRenders = 0;
});

afterEach(() => {
  cleanup();
});

describe('SnackbarProvider session generation', () => {
  it('drops a toast from a caller still holding showMessage from before an account change', () => {
    const guard = browserSessionGuard();
    guard.accept({ userId: 'user-a', authSessionId: 'login-a' });
    const heldAcrossSwitch = renderSnackbar();

    act(() => heldAcrossSwitch('Saved for A', 'success'));
    expect(alertTexts()).toEqual(['Saved for A']);

    act(() => {
      guard.accept({ userId: 'user-a', authSessionId: 'login-a2' });
    });
    act(() => heldAcrossSwitch('Failed for A', 'error'));
    expect(alertTexts()).toEqual(['Saved for A']);

    act(() => latestShowMessage?.('Fresh message', 'info'));
    expect(alertTexts()).toEqual(['Saved for A', 'Fresh message']);
  });

  it('keeps one context value across its own message updates', () => {
    const showMessage = renderSnackbar();

    act(() => showMessage('First', 'info'));
    act(() => showMessage('Second', 'info'));

    expect(alertTexts()).toEqual(['First', 'Second']);
    expect(consumerRenders).toBe(1);
    expect(latestShowMessage).toBe(showMessage);
  });
});
