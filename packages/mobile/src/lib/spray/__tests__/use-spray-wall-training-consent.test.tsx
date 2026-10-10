// @vitest-environment jsdom
//
// "Is a flip of this wall's training switch still on the wire" (SW-20, #5471),
// as a screen hosting the switch asks it: per wall, from the mutation cache,
// both as a hook that re-renders and as a read at the moment of a press.
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request }) }));

import {
  isSprayWallTrainingConsentSaving,
  useSetSprayWallTrainingConsent,
  useSprayWallTrainingConsentSaving,
} from '../use-spray-wall-training-consent';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One client, as the app has: every hook below reads the same mutation cache. */
function mountHooks() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return {
    client,
    wallOneSwitch: renderHook(() => useSetSprayWallTrainingConsent('wall-1', { onRefused: () => {} }), { wrapper }),
    wallOne: renderHook(() => useSprayWallTrainingConsentSaving('wall-1'), { wrapper }),
    wallTwo: renderHook(() => useSprayWallTrainingConsentSaving('wall-2'), { wrapper }),
    noWallYet: renderHook(() => useSprayWallTrainingConsentSaving(null), { wrapper }),
  };
}

beforeEach(() => {
  request.mockReset();
});

describe('a training switch flip, as its host sees it', () => {
  it('reads as saving for that wall alone, from the tap until the answer', async () => {
    const save = deferred<unknown>();
    request.mockReturnValueOnce(save.promise);
    const { client, wallOneSwitch, wallOne, wallTwo, noWallYet } = mountHooks();
    expect(wallOne.result.current).toBe(false);

    act(() => {
      wallOneSwitch.result.current.setConsent(false);
      // Already true here, before any render: what a press that queued up behind
      // the tap gets to read.
      expect(isSprayWallTrainingConsentSaving(client, 'wall-1')).toBe(true);
      expect(isSprayWallTrainingConsentSaving(client, 'wall-2')).toBe(false);
      expect(isSprayWallTrainingConsentSaving(client, null)).toBe(false);
    });
    await waitFor(() => expect(wallOne.result.current).toBe(true));
    expect(wallTwo.result.current).toBe(false);
    expect(noWallYet.result.current).toBe(false);

    await act(async () => save.resolve({ updateSprayWall: { uuid: 'wall-1', trainingConsent: false } }));
    await waitFor(() => expect(wallOne.result.current).toBe(false));
    expect(isSprayWallTrainingConsentSaving(client, 'wall-1')).toBe(false);
  });

  it('stops reading as saving once a flip has been refused, too', async () => {
    const save = deferred<unknown>();
    request.mockReturnValueOnce(save.promise);
    const { client, wallOneSwitch, wallOne } = mountHooks();

    act(() => {
      wallOneSwitch.result.current.setConsent(false);
    });
    await waitFor(() => expect(wallOne.result.current).toBe(true));

    await act(async () => save.reject(new Error('timeout')));
    await waitFor(() => expect(wallOne.result.current).toBe(false));
    expect(isSprayWallTrainingConsentSaving(client, 'wall-1')).toBe(false);
  });
});
