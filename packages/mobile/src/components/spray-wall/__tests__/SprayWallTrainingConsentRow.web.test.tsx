// @vitest-environment jsdom
//
// The training switch row on the browser app, where `Alert.alert` does nothing:
// a refusal the owner is not looking at has to reach them as a toast. Metro
// swaps in the `.web` notice by suffix; here it is swapped in by hand. The
// native row's cases are in SprayWallTrainingConsentRow.test.tsx.
import { createElement, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readConsent = vi.hoisted(() => vi.fn());
const writeConsent = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());
/** Whether the row's screen is the one in front, as `useIsFocused` answers. */
const rowScreen = vi.hoisted(() => ({ isFocused: true }));

vi.mock('../../../lib/spray/use-training-consent-refusal-notice', async () => ({
  ...(await import('../../../lib/spray/use-training-consent-refusal-notice.web')),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));
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
vi.mock('expo-router', () => ({ useIsFocused: () => rowScreen.isFocused }));
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
  }) =>
    createElement('div', null, [
      createElement('input', {
        key: 'switch',
        type: 'checkbox',
        'data-testid': 'switch',
        checked: value,
        disabled,
        onChange: () => onValueChange(!value),
      }),
      errorMessage ? createElement('span', { key: 'error', 'data-testid': 'error' }, errorMessage) : null,
    ]),
}));

import { SprayWallTrainingConsentRow } from '../SprayWallTrainingConsentRow';

function renderRow() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const row = () => createElement(SprayWallTrainingConsentRow, { wallUuid: 'wall-1', isOwner: true });
  const view = render(row(), { wrapper });
  const setScreenInFront = (isFocused: boolean) => {
    rowScreen.isFocused = isFocused;
    view.rerender(row());
  };
  return { ...view, setScreenInFront };
}

function deferred<T>() {
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((_resolve, rej) => {
    reject = rej;
  });
  return { promise, reject };
}

const switchInput = () => screen.getByTestId('switch') as HTMLInputElement;
/** A flip is on the wire, from a row whose read has answered "on". */
async function startFlip() {
  readConsent.mockResolvedValue({ sprayWall: { uuid: 'wall-1', trainingConsent: true } });
  const save = deferred<unknown>();
  writeConsent.mockReturnValueOnce(save.promise);
  const view = renderRow();
  await waitFor(() => expect(switchInput().disabled).toBe(false));
  fireEvent.click(switchInput());
  await waitFor(() => expect(writeConsent).toHaveBeenCalledTimes(1));
  return { ...view, save };
}

beforeEach(() => {
  readConsent.mockReset();
  writeConsent.mockReset();
  showToast.mockReset();
  rowScreen.isFocused = true;
});

describe('SprayWallTrainingConsentRow on the browser app', () => {
  it('says a refusal in a toast once the row has left the screen', async () => {
    const { unmount, save } = await startFlip();
    unmount();
    await act(async () => save.reject(new Error('timeout')));
    await waitFor(() => expect(showToast).toHaveBeenCalledExactlyOnceWith('mobile.sprayTraining.updateError', 'error'));
  });

  it('says it in a toast when another screen has been pushed over the row', async () => {
    const { setScreenInFront, save } = await startFlip();
    setScreenInFront(false);
    await act(async () => save.reject(new Error('timeout')));
    await waitFor(() => expect(showToast).toHaveBeenCalledExactlyOnceWith('mobile.sprayTraining.updateError', 'error'));
    expect(screen.queryByTestId('error')).toBeNull();
  });

  it('still says it inline, with no toast, while the owner is looking at the row', async () => {
    const { save } = await startFlip();
    await act(async () => save.reject(new Error('offline')));
    expect((await screen.findByTestId('error')).textContent).toBe('mobile.sprayTraining.updateError');
    expect(showToast).not.toHaveBeenCalled();
  });
});
