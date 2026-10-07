// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SprayDetectionView } from '@boardsesh/shared-schema';

const runtime = vi.hoisted(() => ({ offline: false, request: vi.fn() }));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: vi.fn() }) },
}));
vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => runtime.offline }));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: runtime.request }) }));
const registration = vi.hoisted(() => ({ registered: false }));
vi.mock('../../../notifications/device-registration', () => ({
  registerNotificationDevice: vi.fn(async () => registration.registered),
}));
vi.mock('../../../lib/spray/spray-telemetry', () => ({ trackSprayEvent: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({ Button: ({ title }: { title: string }) => createElement('button', null, title) }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('i') }));
vi.mock('../SprayScanPhoto', () => ({
  SprayScanPhoto: ({ message, resumeHint }: { message: string; resumeHint: string }) =>
    createElement('div', null, createElement('span', null, message), createElement('span', null, resumeHint)),
}));

import { SprayDetectionStep } from '../SprayDetectionStep';

const savedDetection: SprayDetectionView = {
  id: 'saved-detection',
  wallUuid: 'wall-1',
  versionId: 'version-2',
  status: 'pending',
  modelVersion: 'test-model',
  result: null,
  error: null,
  createdAt: '2026-10-03T12:00:00Z',
  finishedAt: null,
  queuePosition: 4,
};
const queryKey = ['spray-wall-detection', savedDetection.wallUuid, savedDetection.versionId];

function mount(photo = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(queryKey, savedDetection);
  const onComplete = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <SprayDetectionStep
        wallUuid={savedDetection.wallUuid}
        versionId={savedDetection.versionId}
        photo={photo ? { uri: 'saved-photo', width: 800, height: 600 } : null}
        onComplete={onComplete}
      />
    </QueryClientProvider>,
  );
  return { client, onComplete };
}

beforeEach(() => {
  registration.registered = true;
  runtime.offline = false;
  runtime.request.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SprayDetectionStep saved recognition', () => {
  it.each([false, true])(
    'shows the connection banner offline without starting another job (photo: %s)',
    async (photo) => {
      vi.useFakeTimers();
      runtime.offline = true;
      const { client, onComplete } = mount(photo);
      expect(screen.getByText('sprayDetection.connection')).toBeTruthy();
      expect(screen.queryByText('sprayDetection.queuePosition')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(document.body.textContent).toContain('sprayDetection.notifyHint');
      expect(runtime.request).not.toHaveBeenCalled();
      expect(client.getQueryData(queryKey)).toEqual(savedDetection);
      expect(onComplete).not.toHaveBeenCalled();
    },
  );

  it('promises no push when this device could not register for one', async () => {
    registration.registered = false;
    runtime.offline = true;
    mount();
    await waitFor(() => expect(screen.getByText('sprayDetection.connection')).toBeTruthy());
    await act(async () => {});
    expect(document.body.textContent).not.toContain('sprayDetection.notifyHint');
  });

  it('retains the saved job and shows the connection banner when its status request fails', async () => {
    runtime.request.mockRejectedValue(new Error('backend unreachable'));
    const { client, onComplete } = mount();
    await waitFor(() => expect(screen.getByText('sprayDetection.connection')).toBeTruthy());
    expect(runtime.request).toHaveBeenCalledOnce();
    expect(client.getQueryData(queryKey)).toEqual(savedDetection);
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'sprayDetection.retry' })).toBeTruthy();
  });
});
