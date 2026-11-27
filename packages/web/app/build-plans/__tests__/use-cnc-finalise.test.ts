import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { FinaliseCncOrderInput } from '@boardsesh/shared-schema';

const graphqlRequest = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: graphqlRequest }),
}));

const removePreference = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/user-preferences-db', () => ({ removePreference }));

const { useCncFinalise, cncOrderPath } = await import('../configurator/use-cnc-finalise');
const { CNC_CONFIGURATOR_DRAFT_KEY } = await import('../configurator/configurator-state');

const documentLocale = vi.hoisted(() => vi.fn(() => 'en-US'));
const locationAssign = vi.fn();
vi.mock('@/app/lib/i18n/document-locale-context', () => ({ useDocumentLocale: documentLocale }));
const ORDER_PATH = '/build-plans/orders/BS-CNC-K7QM3T';
const ORDER_URL = `https://www.boardsesh.com${ORDER_PATH}`;

/** The only thing finalise sends: who the licence names. The wall is already on the order. */
const FINALISE_INPUT: FinaliseCncOrderInput = {
  orderId: '41',
  tier: 'personal',
  licenseeName: 'Sam Bouldering',
  licenseeEmail: 'sam@example.com',
  acceptLicence: true,
};

function checkoutUrlResponse(checkoutUrl: string) {
  return { finaliseCncOrder: { orderId: '41', licenceId: 'BS-CNC-K7QM3T', checkoutUrl } };
}

/** A `graphql-request` ClientError, walked by shape rather than by `instanceof`. */
function graphqlError(code: string) {
  return { response: { errors: [{ message: 'nope', extensions: { code } }] } };
}

beforeEach(() => {
  graphqlRequest.mockReset();
  removePreference.mockReset().mockResolvedValue(undefined);
  locationAssign.mockReset();
  documentLocale.mockReturnValue('en-US');
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { assign: locationAssign, origin: 'http://localhost:3000' },
  });
});

describe('cncOrderPath', () => {
  it('builds only a local order path from a complete licence id', () => {
    expect(cncOrderPath('BS-CNC-K7QM3T')).toBe(ORDER_PATH);
  });

  it.each([
    undefined,
    null,
    '',
    'BS-CNC-K7QM3',
    'BS-CNC-K7QM3TT',
    'BS-CNC-K7QM3T\n',
    'https://evil.example/orders',
    '../auth/logout',
    'BS-CNC-../../',
    'BS-CNC-k7qm3t',
  ])('refuses invalid identifier %j', (licenceId) => {
    expect(cncOrderPath(licenceId)).toBeNull();
  });
});

describe('useCncFinalise', () => {
  it('queues the previewed pack and opens its order page without payment', async () => {
    graphqlRequest.mockResolvedValue(checkoutUrlResponse(ORDER_URL));

    const { result } = renderHook(() => useCncFinalise('ws-token'));
    await act(async () => {
      await result.current.finalise(FINALISE_INPUT);
    });

    // The order id is the whole point: nothing about the wall is sent again,
    // because the order already carries the configuration that was previewed.
    expect(graphqlRequest.mock.calls[0][1]).toEqual({ input: FINALISE_INPUT });
    expect(locationAssign).toHaveBeenCalledWith(ORDER_PATH);
    expect(removePreference).toHaveBeenCalledWith(CNC_CONFIGURATOR_DRAFT_KEY);
    expect(result.current.errorKey).toBeNull();
    // Never cleared on the success path: the navigation is already in flight,
    // and a re-enabled button invites a duplicate generation request.
    expect(result.current.isFinalising).toBe(true);
  });

  it.each([
    'https://www.boardsesh.com/build-plans/orders/BS-CNC-K7QM3T',
    'https://preview.boardsesh.test/build-plans/orders/BS-CNC-K7QM3T',
    'https://evil.example/checkout',
    '',
  ])('uses a fresh local document regardless of compatibility URL %j', async (checkoutUrl) => {
    graphqlRequest.mockResolvedValue(checkoutUrlResponse(checkoutUrl));
    const { result } = renderHook(() => useCncFinalise('ws-token'));

    await act(async () => {
      await result.current.finalise(FINALISE_INPUT);
    });

    expect(locationAssign).toHaveBeenCalledWith(ORDER_PATH);
    expect(removePreference).toHaveBeenCalledWith(CNC_CONFIGURATOR_DRAFT_KEY);
    expect(result.current.errorKey).toBeNull();
  });

  it('preserves the active locale when starting a fresh order document', async () => {
    documentLocale.mockReturnValue('fr');
    graphqlRequest.mockResolvedValue(checkoutUrlResponse(ORDER_URL));
    const { result } = renderHook(() => useCncFinalise('ws-token'));

    await act(async () => {
      await result.current.finalise(FINALISE_INPUT);
    });

    expect(locationAssign).toHaveBeenCalledWith(`/fr${ORDER_PATH}`);
    expect(locationAssign).not.toHaveBeenCalledWith(ORDER_URL);
  });

  it('preserves the draft and refuses navigation when the licence id is malformed', async () => {
    graphqlRequest.mockResolvedValue({
      finaliseCncOrder: { ...checkoutUrlResponse(ORDER_URL).finaliseCncOrder, licenceId: '../auth/logout' },
    });
    const { result } = renderHook(() => useCncFinalise('ws-token'));

    await act(async () => {
      await expect(result.current.finalise(FINALISE_INPUT)).resolves.toBeUndefined();
    });

    expect(locationAssign).not.toHaveBeenCalled();
    expect(removePreference).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.errorKey).toBe('generic'));
    expect(result.current.isFinalising).toBe(false);
  });

  it('maps each backend error code to its own message key', async () => {
    for (const code of ['CNC_INVALID_CONFIG', 'CNC_WORKER_UNAVAILABLE', 'CNC_CHECKOUT_UNAVAILABLE']) {
      graphqlRequest.mockRejectedValueOnce(graphqlError(code));

      const { result } = renderHook(() => useCncFinalise('ws-token'));
      await act(async () => {
        await result.current.finalise(FINALISE_INPUT);
      });

      await waitFor(() => expect({ code, errorKey: result.current.errorKey }).toEqual({ code, errorKey: code }));
      expect(result.current.isFinalising).toBe(false);
    }
  });

  it('falls back to the generic key for a transport failure', async () => {
    graphqlRequest.mockRejectedValue(new Error('fetch failed'));

    const { result } = renderHook(() => useCncFinalise('ws-token'));
    await act(async () => {
      await result.current.finalise(FINALISE_INPUT);
    });

    await waitFor(() => expect(result.current.errorKey).toBe('generic'));
    expect(locationAssign).not.toHaveBeenCalled();
  });
});

it('preserves pending checkout and its successful response across same-login credentials refresh', async () => {
  let finish: ((response: ReturnType<typeof checkoutUrlResponse>) => void) | undefined;
  graphqlRequest.mockImplementation(
    () =>
      new Promise<ReturnType<typeof checkoutUrlResponse>>((resolve) => {
        finish = resolve;
      }),
  );
  const mounted = renderHook(({ token }) => useCncFinalise(token), { initialProps: { token: 'old-token' } });
  let pending: Promise<void> | undefined;
  act(() => {
    pending = mounted.result.current.finalise(FINALISE_INPUT);
  });
  expect(mounted.result.current.isFinalising).toBe(true);
  mounted.rerender({ token: 'new-token' });
  expect(mounted.result.current.isFinalising).toBe(true);
  await act(async () => {
    finish?.(checkoutUrlResponse(ORDER_URL));
    await pending;
  });
  expect(locationAssign).toHaveBeenCalledWith(ORDER_PATH);
  expect(removePreference).toHaveBeenCalledWith(CNC_CONFIGURATOR_DRAFT_KEY);
  expect(mounted.result.current.isFinalising).toBe(true);
});

it('ignores a checkout response after its owned component unmounts', async () => {
  let finish: ((response: ReturnType<typeof checkoutUrlResponse>) => void) | undefined;
  graphqlRequest.mockImplementation(
    () =>
      new Promise<ReturnType<typeof checkoutUrlResponse>>((resolve) => {
        finish = resolve;
      }),
  );
  const mounted = renderHook(() => useCncFinalise('ws-token'));
  let pending: Promise<void> | undefined;
  act(() => {
    pending = mounted.result.current.finalise(FINALISE_INPUT);
  });
  mounted.unmount();
  await act(async () => {
    finish?.(checkoutUrlResponse(ORDER_URL));
    await pending;
  });
  expect(locationAssign).not.toHaveBeenCalled();
  expect(removePreference).not.toHaveBeenCalled();
});
