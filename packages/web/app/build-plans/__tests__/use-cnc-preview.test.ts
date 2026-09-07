import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { CncBoardConfigInput, CncOrder } from '@boardsesh/shared-schema';

const graphqlRequest = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: graphqlRequest }),
  getGraphQLHttpUrl: () => 'https://api.boardsesh.test/graphql',
}));

const { useCncPreview, isBackendDownloadUrl } = await import('../configurator/use-cnc-preview');

const windowOpen = vi.fn();

const CONFIG: CncBoardConfigInput = {
  boardName: 'kilter',
  layoutId: 8,
  sizeId: 25,
  setIds: '26,27,28,29',
  options: { sheetStock: '2440x1220' },
};

function previewOrder(overrides: Partial<CncOrder> = {}): CncOrder {
  return {
    id: '41',
    licenceId: 'BS-CNC-K7QM3T',
    tier: null,
    status: 'preview_queued',
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    options: {},
    artwork: null,
    licenseeName: null,
    customerSiteName: null,
    amountCents: null,
    currency: null,
    createdAt: '2026-09-07T00:00:00.000Z',
    paidAt: null,
    generatedAt: null,
    zipSizeBytes: null,
    downloadCount: 0,
    lastDownloadedAt: null,
    errorMessage: null,
    hasPreview: false,
    previewGeneratedAt: null,
    previewImages: [],
    configHash: 'sha256-of-the-wall',
    ...overrides,
  };
}

/** A `graphql-request` ClientError, walked by shape rather than by `instanceof`. */
function graphqlError(code: string) {
  return { response: { errors: [{ message: 'nope', extensions: { code } }] } };
}

beforeEach(() => {
  graphqlRequest.mockReset();
  windowOpen.mockReset();
  Object.defineProperty(window, 'open', { configurable: true, writable: true, value: windowOpen });
});

describe('isBackendDownloadUrl', () => {
  it('accepts the backend this client already talks to, and nothing else', () => {
    expect(isBackendDownloadUrl('https://api.boardsesh.test/api/cnc/packs/BS-CNC-K7QM3T/download?token=abc')).toBe(
      true,
    );
    for (const url of ['https://evil.example/api/cnc/packs/BS-CNC-K7QM3T/download', 'not a url', '']) {
      expect({ url, allowed: isBackendDownloadUrl(url) }).toEqual({ url, allowed: false });
    }
  });
});

describe('useCncPreview', () => {
  it('hands back the order to watch, with the config it was asked for', async () => {
    graphqlRequest.mockResolvedValue({ createCncPreview: previewOrder() });

    const { result } = renderHook(() => useCncPreview('ws-token'));
    let order: CncOrder | null = null;
    await act(async () => {
      order = await result.current.requestPreview(CONFIG);
    });

    expect(graphqlRequest.mock.calls[0][1]).toEqual({ config: CONFIG });
    expect(order).toMatchObject({ id: '41', licenceId: 'BS-CNC-K7QM3T', status: 'preview_queued' });
    expect(result.current.errorKey).toBeNull();
    // Cleared on success, unlike finalise: the buyer stays on this page and the
    // button becomes "Update preview" the moment they change something.
    expect(result.current.isRequesting).toBe(false);
  });

  it('reports the hourly ceiling as its own thing, not as an outage', async () => {
    graphqlRequest.mockRejectedValue(graphqlError('RATE_LIMITED'));

    const { result } = renderHook(() => useCncPreview('ws-token'));
    let order: CncOrder | null = previewOrder();
    await act(async () => {
      order = await result.current.requestPreview(CONFIG);
    });

    expect(order).toBeNull();
    await waitFor(() => expect(result.current.isRateLimited).toBe(true));
    expect(result.current.errorKey).toBe('RATE_LIMITED');
  });

  it('maps a rejected configuration to the key that tells the buyer to change something', async () => {
    graphqlRequest.mockRejectedValue(graphqlError('CNC_INVALID_CONFIG'));

    const { result } = renderHook(() => useCncPreview('ws-token'));
    await act(async () => {
      await result.current.requestPreview(CONFIG);
    });

    await waitFor(() => expect(result.current.errorKey).toBe('CNC_INVALID_CONFIG'));
    expect(result.current.isRateLimited).toBe(false);
  });

  it('opens the watermarked preview in a new tab, asking for the PREVIEW kind', async () => {
    graphqlRequest.mockResolvedValue({
      createCncDownloadGrant: {
        url: 'https://api.boardsesh.test/api/cnc/packs/BS-CNC-K7QM3T/download?token=abc&kind=preview',
        expiresAt: '2026-09-07T01:00:00.000Z',
      },
    });

    const { result } = renderHook(() => useCncPreview('ws-token'));
    await act(async () => {
      await result.current.downloadPreview('BS-CNC-K7QM3T');
    });

    expect(graphqlRequest.mock.calls[0][1]).toEqual({ licenceId: 'BS-CNC-K7QM3T', kind: 'PREVIEW' });
    expect(windowOpen).toHaveBeenCalledWith(
      'https://api.boardsesh.test/api/cnc/packs/BS-CNC-K7QM3T/download?token=abc&kind=preview',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('refuses a grant URL on any other origin', async () => {
    graphqlRequest.mockResolvedValue({
      createCncDownloadGrant: { url: 'https://evil.example/steal', expiresAt: '2026-09-07T01:00:00.000Z' },
    });

    const { result } = renderHook(() => useCncPreview('ws-token'));
    await act(async () => {
      await result.current.downloadPreview('BS-CNC-K7QM3T');
    });

    expect(windowOpen).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.errorKey).toBe('generic'));
  });
});
