// @vitest-environment jsdom
//
// The owner's "Help train hold finding" switch on an existing wall (SW-20,
// #5471): read once, flipped optimistically, flipped back with an inline
// message when the server refuses.
import { createElement, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GET_SPRAY_WALL_TRAINING_CONSENT,
  SET_SPRAY_WALL_TRAINING_CONSENT,
} from '@boardsesh/graphql/operations/spray-training';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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

function renderRow(props: { wallUuid?: string; isOwner?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return render(createElement(SprayWallTrainingConsentRow, { wallUuid: 'wall-1', isOwner: true, ...props }), {
    wrapper,
  });
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

beforeEach(() => {
  request.mockReset();
});

describe('SprayWallTrainingConsentRow', () => {
  it("reads the owner's switch and shows it", async () => {
    request.mockResolvedValueOnce({ sprayWall: { uuid: 'wall-1', trainingConsent: true } });
    renderRow();
    const toggle = await screen.findByTestId('switch');
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect(request).toHaveBeenCalledWith(GET_SPRAY_WALL_TRAINING_CONSENT, { uuid: 'wall-1' });
  });

  it('never asks, and shows nothing, for somebody who does not own the wall', async () => {
    renderRow({ isOwner: false });
    await act(async () => {});
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByTestId('switch')).toBeNull();
  });

  it('shows nothing when the server withholds the value', async () => {
    request.mockResolvedValueOnce({ sprayWall: { uuid: 'wall-1', trainingConsent: null } });
    renderRow();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('switch')).toBeNull();
  });

  it('flips at once and saves through updateSprayWall', async () => {
    request.mockResolvedValueOnce({ sprayWall: { uuid: 'wall-1', trainingConsent: true } });
    const save = deferred<unknown>();
    request.mockReturnValueOnce(save.promise);
    renderRow();
    fireEvent.click(await screen.findByTestId('switch'));

    // Optimistic: off before the server answers.
    await waitFor(() => expect((screen.getByTestId('switch') as HTMLInputElement).checked).toBe(false));
    expect(request).toHaveBeenLastCalledWith(SET_SPRAY_WALL_TRAINING_CONSENT, {
      input: { uuid: 'wall-1', trainingConsent: false },
    });

    await act(async () => save.resolve({ updateSprayWall: { uuid: 'wall-1', trainingConsent: false } }));
    expect((screen.getByTestId('switch') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId('error')).toBeNull();
  });

  it('flips back and says so when the save is refused', async () => {
    request.mockResolvedValueOnce({ sprayWall: { uuid: 'wall-1', trainingConsent: true } });
    const save = deferred<unknown>();
    request.mockReturnValueOnce(save.promise);
    renderRow();
    fireEvent.click(await screen.findByTestId('switch'));
    await waitFor(() => expect((screen.getByTestId('switch') as HTMLInputElement).checked).toBe(false));

    await act(async () => save.reject(new Error('offline')));
    await waitFor(() => expect((screen.getByTestId('switch') as HTMLInputElement).checked).toBe(true));
    expect(screen.getByTestId('error').textContent).toBe('mobile.sprayTraining.updateError');
  });
});
