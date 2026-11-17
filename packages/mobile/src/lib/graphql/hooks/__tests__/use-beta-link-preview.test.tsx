// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const requestMock = vi.fn();
vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

import { useBetaLinkPreview } from '../use-beta-link-preview';

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useBetaLinkPreview', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('does not fetch when there is no link (enabled gating)', () => {
    const { result } = renderHook(() => useBetaLinkPreview(undefined), { wrapper: wrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('unwraps betaLinkPreview from the response', async () => {
    const preview = {
      link: 'https://www.instagram.com/reel/abc/',
      thumbnail: 'https://cdn.example.com/x.jpg',
      username: 'climber',
      caption: 'Sent it 🧗',
    };
    requestMock.mockResolvedValueOnce({ betaLinkPreview: preview });

    const { result } = renderHook(() => useBetaLinkPreview('https://www.instagram.com/reel/abc/'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toEqual(preview);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
