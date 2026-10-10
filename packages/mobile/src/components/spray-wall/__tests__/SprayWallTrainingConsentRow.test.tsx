// @vitest-environment jsdom
//
// The owner's "Help train hold finding" switch on an existing wall (SW-20,
// #5471): its place held from the first render, read with the app's retry
// policy, flipped optimistically one flip at a time, re-read after every flip,
// and a refusal that reaches the owner whether or not they are still looking at
// the row.
import { createElement, Fragment, type ReactNode } from 'react';
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
/** The handler the field was last drawn with, for a tap that gets past `disabled`. */
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
// Not something the native row may reach for: the toast overlay draws behind the
// boards modal its owner is still inside after leaving Edit board. The browser
// app's own notice is in SprayWallTrainingConsentRow.web.test.tsx.
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
    return createElement('div', { 'data-testid': 'row' }, [
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

/**
 * The row with a control under it, as every screen that hosts it has. The
 * client carries the app's retry policy (`createQueryClient`) without its
 * backoff.
 */
function renderRow(props: { wallUuid?: string; isOwner?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryQuery, retryDelay: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const rowAndWhatIsUnderIt = () =>
    createElement(
      Fragment,
      null,
      createElement(SprayWallTrainingConsentRow, { wallUuid: 'wall-1', isOwner: true, ...props }),
      createElement('button', { 'data-testid': 'control-below' }),
    );
  const view = render(rowAndWhatIsUnderIt(), { wrapper });
  /** Another screen is pushed over the row's, or popped off it again. */
  const setScreenInFront = (isFocused: boolean) => {
    rowScreen.isFocused = isFocused;
    view.rerender(rowAndWhatIsUnderIt());
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
/** The switch once the server's answer is on it: until then it is held, disabled. */
async function answeredSwitch(): Promise<HTMLInputElement> {
  await waitFor(() => expect(switchInput().disabled).toBe(false));
  return switchInput();
}
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
    expect((await answeredSwitch()).checked).toBe(true);
    expect(readConsent).toHaveBeenCalledWith({ uuid: 'wall-1' });
  });

  it('never asks, and holds no place, for somebody who does not own the wall', async () => {
    renderRow({ isOwner: false });
    expect(screen.queryByTestId('row')).toBeNull();
    await settle();
    expect(readConsent).not.toHaveBeenCalled();
    expect(screen.queryByTestId('row')).toBeNull();
  });

  it('takes the row away when the server withholds the value', async () => {
    readConsent.mockResolvedValue(storedConsent(null));
    renderRow();
    await waitFor(() => expect(readConsent).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.queryByTestId('row')).toBeNull();
  });

  // The row used to draw only once its read had answered. Everything under it
  // then slid down by its height, and on Android a tap anywhere on the row flips
  // the switch and saves at once: a tap aimed at the control below could land on
  // the row as it arrived.
  describe('while its read is out', () => {
    it("holds the row's place: there from the first render, off, disabled, and deaf to a tap", async () => {
      readConsent.mockReturnValue(deferred<unknown>().promise);
      renderRow();

      expect(switchInput().disabled).toBe(true);
      expect(switchInput().checked).toBe(false);
      expect(screen.queryByTestId('error')).toBeNull();

      // `disabled` blocks the press on every platform. This is a press that got
      // past it anyway: it must not write a value nobody has read yet.
      fireEvent.click(switchInput());
      act(() => {
        field.onValueChange?.(true);
        field.onValueChange?.(false);
      });
      await settle();
      expect(writeConsent).not.toHaveBeenCalled();
      expect(switchInput().checked).toBe(false);
    });

    it('fills the answer in on the same row, moving nothing under it', async () => {
      const read = deferred<unknown>();
      readConsent.mockReturnValue(read.promise);
      renderRow();
      const heldRow = screen.getByTestId('row');
      const heldSwitch = switchInput();
      const controlBelow = screen.getByTestId('control-below');
      const drawnOrder = () =>
        [...document.querySelectorAll('[data-testid]')].map((node) => node.getAttribute('data-testid'));
      expect(drawnOrder()).toEqual(['row', 'switch', 'control-below']);

      await act(async () => read.resolve(storedConsent(true)));
      await waitFor(() => expect(switchInput().disabled).toBe(false));

      // The very same nodes, updated in place: nothing was unmounted or inserted.
      expect(screen.getByTestId('row')).toBe(heldRow);
      expect(switchInput()).toBe(heldSwitch);
      expect(screen.getByTestId('control-below')).toBe(controlBelow);
      expect(switchInput().checked).toBe(true);
      expect(drawnOrder()).toEqual(['row', 'switch', 'control-below']);
    });
  });

  describe('reading', () => {
    it('asks again after a dropped connection instead of losing the switch', async () => {
      readConsent.mockRejectedValueOnce(new TypeError('Network request failed'));
      readConsent.mockResolvedValue(storedConsent(true));
      renderRow();
      expect((await answeredSwitch()).checked).toBe(true);
      expect(readConsent).toHaveBeenCalledTimes(2);
    });

    it('keeps the row, disabled, once every attempt has failed', async () => {
      readConsent.mockRejectedValue(new TypeError('Network request failed'));
      renderRow();
      // The first attempt and the policy's two retries.
      await waitFor(() => expect(readConsent).toHaveBeenCalledTimes(3));
      await settle();

      // Not dropped.
      expect(switchInput().disabled).toBe(true);
      expect(switchInput().checked).toBe(false);
      act(() => field.onValueChange?.(true));
      await settle();
      expect(writeConsent).not.toHaveBeenCalled();
      expect(alertMock).not.toHaveBeenCalled();
    });

    it('asks once of a backend that predates the field, and takes the row away', async () => {
      readConsent.mockRejectedValue(fieldUnknownToBackend);
      renderRow();
      await waitFor(() => expect(readConsent).toHaveBeenCalledTimes(1));
      await settle();
      expect(readConsent).toHaveBeenCalledTimes(1);
      // That backend has no such switch: there is nothing to load, or to fail to.
      expect(screen.queryByTestId('row')).toBeNull();
    });
  });

  describe('flipping', () => {
    it('flips at once, saves through updateSprayWall, and locks the switch until it has', async () => {
      readConsent.mockResolvedValue(storedConsent(true));
      const save = deferred<unknown>();
      writeConsent.mockReturnValueOnce(save.promise);
      renderRow();
      fireEvent.click(await answeredSwitch());

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
      await answeredSwitch();

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
      fireEvent.click(await answeredSwitch());

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
      fireEvent.click(await answeredSwitch());

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
      fireEvent.click(await answeredSwitch());
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
      fireEvent.click(await answeredSwitch());
      await screen.findByTestId('error');

      writeConsent.mockReturnValue(deferred<unknown>().promise);
      fireEvent.click(await answeredSwitch());
      await waitFor(() => expect(screen.queryByTestId('error')).toBeNull());
    });

    it('says so in a native alert, never a toast, once the row has left the screen', async () => {
      readConsent.mockResolvedValue(storedConsent(true));
      const save = deferred<unknown>();
      writeConsent.mockReturnValueOnce(save.promise);
      const { unmount, client } = renderRow();
      fireEvent.click(await answeredSwitch());
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
      fireEvent.click(await answeredSwitch());
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
      await answeredSwitch();
      setScreenInFront(false);
      setScreenInFront(true);

      fireEvent.click(switchInput());
      expect((await screen.findByTestId('error')).textContent).toBe('mobile.sprayTraining.updateError');
      expect(alertMock).not.toHaveBeenCalled();
    });
  });
});
