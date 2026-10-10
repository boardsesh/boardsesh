// @vitest-environment jsdom
//
// The owner's "Help train hold finding" switch on an existing wall (SW-20,
// #5471): read with the app's retry policy, flipped optimistically one flip at a
// time, re-read after every flip, and a refusal that reaches the owner whether
// or not they are still looking at the row.
import { createElement, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shouldRetryQuery } from '../../../lib/graphql/query-retry';
import { sprayWallTrainingConsentQueryKey } from '../../../lib/spray/use-spray-wall-training-consent';

/** The two operations behind the switch, split so a test can answer each. */
const readConsent = vi.hoisted(() => vi.fn());
const writeConsent = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());
const alertMock = vi.hoisted(() => vi.fn());
/** Whether the row's screen is the one in front, as `useIsFocused` answers. */
const rowScreen = vi.hoisted(() => ({ isFocused: true }));
/** The handler the field was last drawn with, for a tap that beats the next render. */
const field = vi.hoisted(() => ({ onValueChange: null as null | ((next: boolean) => void) }));

vi.mock('../../../lib/graphql/client', async () => {
  const operations = await import('@boardsesh/graphql/operations/spray-training');
  return {
    getHttpClient: () => ({
      request: (document: unknown, variables: unknown) =>
        document === operations.GET_SPRAY_WALL_TRAINING_CONSENT ? readConsent(variables) : writeConsent(variables),
    }),
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({ Alert: { alert: alertMock } }));
vi.mock('expo-router', () => ({ useIsFocused: () => rowScreen.isFocused }));
// Not something the row may reach for: the toast overlay draws behind the boards
// modal its owner is still inside after leaving Edit board.
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../../board-discovery/BoardMetaFields', () => ({
  SprayTrainingConsentField: ({
    value,
    onValueChange,
    disabled,
    errorMessage,
  }: {
    value: boolean;
    onValueChange: (next: boolean) => void;
    disabled?: boolean;
    errorMessage?: string | null;
  }) => {
    field.onValueChange = onValueChange;
    return createElement('div', null, [
      createElement('input', {
        key: 'switch',
        type: 'checkbox',
        'data-testid': 'switch',
        checked: value,
        disabled,
        onChange: () => onValueChange(!value),
      }),
      errorMessage ? createElement('span', { key: 'error', 'data-testid': 'error' }, errorMessage) : null,
    ]);
  },
}));

import { SprayWallTrainingConsentRow } from '../SprayWallTrainingConsentRow';

/** The app's retry policy (`createQueryClient`), without its backoff. */
function renderRow(props: { wallUuid?: string; isOwner?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryQuery, retryDelay: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const row = () => createElement(SprayWallTrainingConsentRow, { wallUuid: 'wall-1', isOwner: true, ...props });
  const view = render(row(), { wrapper });
  /** Another screen is pushed over the row's, or popped off it again. */
  const setScreenInFront = (isFocused: boolean) => {
    rowScreen.isFocused = isFocused;
    view.rerender(row());
  };
  return { ...view, client, setScreenInFront };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const storedConsent = (trainingConsent: boolean | null) => ({ sprayWall: { uuid: 'wall-1', trainingConsent } });
const savedConsent = (trainingConsent: boolean) => ({ updateSprayWall: { uuid: 'wall-1', trainingConsent } });
const switchInput = () => screen.getByTestId('switch') as HTMLInputElement;
/** Past every queued microtask and zero-delay timer, so "never happened" is a real claim. */
const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** What Yoga answers when the running schema has no `trainingConsent` field. */
const fieldUnknownToBackend = Object.assign(new Error('Cannot query field "trainingConsent" on type "SprayWall".'), {
  response: {
    status: 400,
    errors: [
      {
        message: 'Cannot query field "trainingConsent" on type "SprayWall".',
        extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
      },
    ],
  },
});

beforeEach(() => {
  readConsent.mockReset();
  writeConsent.mockReset();
  showToast.mockReset();
  alertMock.mockReset();
  rowScreen.isFocused = true;
  field.onValueChange = null;
});

describe('SprayWallTrainingConsentRow', () => {
  it("reads the owner's switch and shows it", async () => {
    readConsent.mockResolvedValue(storedConsent(true));
    renderRow();
    expect((await screen.findByTestId('switch')) as HTMLInputElement).toHaveProperty('checked', true);
    expect(readConsent).toHaveBeenCalledWith({ uuid: 'wall-1' });
  });

  it('never asks, and shows nothing, for somebody who does not own the wall', async () => {
    renderRow({ isOwner: false });
    await settle();
    expect(readConsent).not.toHaveBeenCalled();
    expect(screen.queryByTestId('switch')).toBeNull();
  });

  it('shows nothing when the server withholds the value', async () => {
    readConsent.mockResolvedValue(storedConsent(null));
    renderRow();
    await waitFor(() => expect(readConsent).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.queryByTestId('switch')).toBeNull();
  });

  describe('reading', () => {
    it('asks again after a dropped connection instead of losing the switch', async () => {
      readConsent.mockRejectedValueOnce(new TypeError('Network request failed'));
      readConsent.mockResolvedValue(storedConsent(true));
      renderRow();
      expect((await screen.findByTestId('switch')) as HTMLInputElement).toHaveProperty('checked', true);
      expect(readConsent).toHaveBeenCalledTimes(2);
    });

    it('asks once of a backend that predates the field, and leaves the switch out', async () => {
      readConsent.mockRejectedValue(fieldUnknownToBackend);
      renderRow();
      await waitFor(() => expect(readConsent).toHaveBeenCalledTimes(1));
      await settle();
      expect(readConsent).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('switch')).toBeNull();
    });

    it('draws no switch while the read is out, nor after every attempt has failed', async () => {
      const firstRead = deferred<unknown>();
      readConsent.mockReturnValueOnce(firstRead.promise);
      readConsent.mockRejectedValue(new TypeError('Network request failed'));
      renderRow();
      await settle();
      expect(screen.queryByTestId('switch')).toBeNull();

      await act(async () => firstRead.reject(new TypeError('Network request failed')));
      // The first attempt and the policy's two retries.
      await waitFor(() => expect(readConsent).toHaveBeenCalledTimes(3));
      await settle();
      expect(screen.queryByTestId('switch')).toBeNull();
    });
  });

  describe('flipping', () => {
    it('flips at once, saves through updateSprayWall, and locks the switch until it has', async () => {
      readConsent.mockResolvedValue(storedConsent(true));
      const save = deferred<unknown>();
      writeConsent.mockReturnValueOnce(save.promise);
      renderRow();
      fireEvent.click(await screen.findByTestId('switch'));

      // Optimistic: off before the server answers.
      await waitFor(() => expect(switchInput().checked).toBe(false));
      await waitFor(() =>
        expect(writeConsent).toHaveBeenCalledExactlyOnceWith({ input: { uuid: 'wall-1', trainingConsent: false } }),
      );
      await waitFor(() => expect(switchInput().disabled).toBe(true));

      readConsent.mockResolvedValue(storedConsent(false));
      await act(async () => save.resolve(savedConsent(false)));
      await waitFor(() => expect(switchInput().disabled).toBe(false));
      expect(switchInput().checked).toBe(false);
      expect(screen.queryByTestId('error')).toBeNull();
      expect(showToast).not.toHaveBeenCalled();
    });

    it('sends one flip when a second tap lands before the first has saved', async () => {
      readConsent.mockResolvedValue(storedConsent(true));
      writeConsent.mockReturnValue(deferred<unknown>().promise);
      renderRow();
      await screen.findByTestId('switch');

      // Both in one tick: no render has had the chance to disable the switch.
      act(() => {
        field.onValueChange?.(false);
        field.onValueChange?.(true);
      });
      await waitFor(() => expect(writeConsent).toHaveBeenCalledTimes(1));
      await settle();

      expect(writeConsent).toHaveBeenCalledExactlyOnceWith({ input: { uuid: 'wall-1', trainingConsent: false } });
      expect(switchInput().checked).toBe(false);
    });

    it('reads the wall again once a flip has saved', async () => {
      readConsent.mockResolvedValue(storedConsent(true));
      writeConsent.mockResolvedValueOnce(savedConsent(false));
      renderRow();
      fireEvent.click(await screen.findByTestId('switch'));

      readConsent.mockResolvedValue(storedConsent(false));
      await waitFor(() => expect(readConsent).toHaveBeenCalledTimes(2));
      await settle();
      expect(switchInput().checked).toBe(false);
    });

    it('ends on what the server holds after a flip whose answer never arrived', async () => {
      // The request timed out on the phone, but the server had already saved it.
      readConsent.mockResolvedValueOnce(storedConsent(true));
      readConsent.mockResolvedValue(storedConsent(false));
      writeConsent.mockRejectedValueOnce(new Error('timeout'));
      renderRow();
      fireEvent.click(await screen.findByTestId('switch'));

      await waitFor(() => expect(readConsent).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(switchInput().checked).toBe(false));
    });
  });

  describe('a refused flip', () => {
    it('flips back and says so inline, and only inline, while the owner is looking at the row', async () => {
      readConsent.mockResolvedValue(storedConsent(true));
      const save = deferred<unknown>();
      writeConsent.mockReturnValueOnce(save.promise);
      renderRow();
      fireEvent.click(await screen.findByTestId('switch'));
      await waitFor(() => expect(switchInput().checked).toBe(false));

      await act(async () => save.reject(new Error('offline')));
      await waitFor(() => expect(switchInput().checked).toBe(true));
      expect(screen.getByTestId('error').textContent).toBe('mobile.sprayTraining.updateError');
      expect(alertMock).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
    });

    it('clears the inline message on the next flip', async () => {
      readConsent.mockResolvedValue(storedConsent(true));
      writeConsent.mockRejectedValueOnce(new Error('offline'));
      renderRow();
      fireEvent.click(await screen.findByTestId('switch'));
      await screen.findByTestId('error');
      await waitFor(() => expect(switchInput().disabled).toBe(false));

      writeConsent.mockReturnValue(deferred<unknown>().promise);
      fireEvent.click(switchInput());
      await waitFor(() => expect(screen.queryByTestId('error')).toBeNull());
    });

    it('says so in a native alert, never a toast, once the row has left the screen', async () => {
      readConsent.mockResolvedValue(storedConsent(true));
      const save = deferred<unknown>();
      writeConsent.mockReturnValueOnce(save.promise);
      const { unmount, client } = renderRow();
      fireEvent.click(await screen.findByTestId('switch'));
      await waitFor(() => expect(writeConsent).toHaveBeenCalledTimes(1));

      // Save or Back tapped on Edit board, with the flip still on the wire. The
      // owner is on the boards picker now, still inside the boards modal.
      unmount();
      await act(async () => save.reject(new Error('timeout')));

      await waitFor(() => expect(alertMock).toHaveBeenCalledExactlyOnceWith('mobile.sprayTraining.updateError'));
      expect(showToast).not.toHaveBeenCalled();
      // And the cache is back on the value the wall still has.
      expect(client.getQueryData(sprayWallTrainingConsentQueryKey('wall-1'))).toBe(true);
    });

    it('says so in a native alert when another screen has been pushed over the row', async () => {
      readConsent.mockResolvedValue(storedConsent(true));
      const save = deferred<unknown>();
      writeConsent.mockReturnValueOnce(save.promise);
      const { setScreenInFront } = renderRow();
      fireEvent.click(await screen.findByTestId('switch'));
      await waitFor(() => expect(writeConsent).toHaveBeenCalledTimes(1));

      // "Reset wall" on Edit board opens the wizard on top: the row is still
      // mounted, on a screen nobody is looking at.
      setScreenInFront(false);
      await act(async () => save.reject(new Error('timeout')));

      await waitFor(() => expect(alertMock).toHaveBeenCalledExactlyOnceWith('mobile.sprayTraining.updateError'));
      await waitFor(() => expect(switchInput().checked).toBe(true));
      expect(screen.queryByTestId('error')).toBeNull();
      expect(showToast).not.toHaveBeenCalled();
    });

    it('says the next one inline again once its screen is back in front', async () => {
      readConsent.mockResolvedValue(storedConsent(true));
      writeConsent.mockRejectedValue(new Error('offline'));
      const { setScreenInFront } = renderRow();
      await screen.findByTestId('switch');
      setScreenInFront(false);
      setScreenInFront(true);

      fireEvent.click(switchInput());
      expect((await screen.findByTestId('error')).textContent).toBe('mobile.sprayTraining.updateError');
      expect(alertMock).not.toHaveBeenCalled();
    });
  });
});
