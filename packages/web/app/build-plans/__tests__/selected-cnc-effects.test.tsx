import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import type { FinaliseCncOrderInput } from '@boardsesh/shared-schema';

const control = vi.hoisted(() => ({
  client: null as ReturnType<typeof createBrowserBackendClient> | null,
  readGraphQL: vi.fn<typeof fetch>(),
  afterBody: vi.fn<() => void>(),
  removePreference: vi.fn<() => Promise<void>>(),
}));
vi.mock('@/app/lib/auth/browser-backend-client', () => ({
  browserBackendClient: new Proxy(
    {},
    {
      get(_target, property) {
        return Reflect.get(control.client!, property);
      },
    },
  ),
}));
vi.mock('@/app/lib/user-preferences-db', () => ({ removePreference: control.removePreference }));
vi.mock('@/app/lib/graphql/client', async () => {
  const { GraphQLClient } = await import('graphql-request');
  const { browserBackendClient } = await import('@/app/lib/auth/browser-backend-client');
  const { captureBrowserBackendRequestScope, createBrowserBackendGraphQLTransport } =
    await import('@/app/lib/auth/browser-backend-graphql');
  return {
    getGraphQLHttpUrl: () => 'https://backend.example.test/graphql',
    createGraphQLHttpClient(authToken?: string | null) {
      const scope = captureBrowserBackendRequestScope(authToken, browserBackendClient);
      if (!scope) throw new Error('Owned selected scope required');
      const transport = createBrowserBackendGraphQLTransport({
        client: browserBackendClient,
        scope,
        fetch: control.readGraphQL,
      });
      return new GraphQLClient('https://backend.example.test/graphql', {
        ...transport,
        async responseMiddleware(...parameters) {
          await transport.responseMiddleware(...parameters);
          // The real body guard has succeeded. The hook's own await has not
          // resumed yet: exercise precisely that publication gap.
          control.afterBody();
        },
      });
    },
  };
});
import { useCncPreview } from '../configurator/use-cnc-preview';
import { useCncFinalise } from '../configurator/use-cnc-finalise';

function owner(userId = 'buyer-a') {
  return {
    userId,
    authSessionId: `${userId}-login`,
    generation: 1,
    cursor: { bindingId: 'a'.repeat(64), version: 1 },
  };
}
function session(userId = 'buyer-a') {
  const selection = owner(userId);
  return {
    user: { id: userId },
    authSessionId: selection.authSessionId,
    authGeneration: selection.generation,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: selection,
  };
}
const DOWNLOAD = 'https://backend.example.test/api/cnc/packs/BS-CNC-K7QM3T/download?token=owned';
const CHECKOUT = 'https://checkout.stripe.com/c/pay/owned';
const FINALISE: FinaliseCncOrderInput = {
  orderId: '41',
  tier: 'personal',
  licenseeName: 'Owned fixture',
  licenseeEmail: 'fixture@example.invalid',
  acceptLicence: true,
};
let milliseconds = 0;
let token: string;
let originalLocation: PropertyDescriptor | undefined;
const locationAssign = vi.fn();
const openDownload = vi.fn();

beforeEach(async () => {
  milliseconds = 0;
  let issued = 0;
  control.client = createBrowserBackendClient({
    ready: () => true,
    fetch: vi.fn<typeof fetch>(async () =>
      Response.json({ status: 'admitted', token: `bsbd1_OWNED${++issued}`, usableForMs: 120_000, owner: owner() }),
    ),
    endpoint: '/owned-lease',
    now: () => milliseconds,
    schedule: () => () => {},
  });
  control.client.acceptSession(session());
  token = (await control.client.acquire(owner())).token;
  control.readGraphQL
    .mockReset()
    .mockImplementation(async () => Response.json({ data: { createCncDownloadGrant: { url: DOWNLOAD } } }));
  control.afterBody.mockReset();
  control.removePreference.mockReset().mockResolvedValue(undefined);
  locationAssign.mockReset();
  openDownload.mockReset();
  vi.spyOn(window, 'open').mockImplementation(openDownload);
  originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: 'https://www.example.test/build-plans', origin: 'https://www.example.test', assign: locationAssign },
  });
});
afterEach(() => {
  cleanup();
  control.client?.dispose();
  control.client = null;
  if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
  vi.restoreAllMocks();
});

describe('selected CNC effects retain their original caller and delivery receipt', () => {
  it.each(['B', 'ABA'])('an old callback cannot start as a newer %s before its component remounts', async (change) => {
    const { result } = renderHook(() => useCncPreview(token));
    const oldDownload = result.current.downloadPreview;
    control.client!.acceptSession(session('buyer-b'));
    if (change === 'ABA') control.client!.acceptSession(session());
    await act(async () => oldDownload('BS-CNC-K7QM3T'));
    expect(control.readGraphQL).not.toHaveBeenCalled();
    expect(openDownload).not.toHaveBeenCalled();
  });
  it('rejects an owner change after the actual GraphQL body guard but before the hook resumes', async () => {
    const { result } = renderHook(() => useCncPreview(token));
    control.afterBody.mockImplementationOnce(() => control.client!.acceptSession(session('buyer-b')));
    await act(async () => result.current.downloadPreview('BS-CNC-K7QM3T'));
    expect(control.readGraphQL).toHaveBeenCalledOnce();
    expect(openDownload).not.toHaveBeenCalled();
  });
  it('drops an expired delivery without borrowing a live owner scope or replaying the mutation', async () => {
    const { result } = renderHook(() => useCncPreview(token));
    control.afterBody.mockImplementationOnce(() => {
      milliseconds += 120_000;
    });
    await act(async () => result.current.downloadPreview('BS-CNC-K7QM3T'));
    expect(openDownload).not.toHaveBeenCalled();
    expect(control.readGraphQL).toHaveBeenCalledOnce();
    expect(result.current.errorKey).toBe('generic');
    expect(result.current.isDownloading).toBe(false);
  });
  it('allows a valid actual renewed delivery after the starting token expires for the same owner', async () => {
    const { result } = renderHook(() => useCncPreview(token));
    milliseconds = 90_000;
    control.afterBody.mockImplementationOnce(() => {
      milliseconds += 40_000;
    });
    await act(async () => result.current.downloadPreview('BS-CNC-K7QM3T'));
    expect(new Headers(control.readGraphQL.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer bsbd1_OWNED2');
    expect(control.client!.capture(token)).toBeNull();
    expect(openDownload).toHaveBeenCalledExactlyOnceWith(DOWNLOAD, '_blank', 'noopener,noreferrer');
  });
  it('rechecks the original checkout delivery after awaited draft cleanup', async () => {
    let finishCleanup!: () => void;
    control.removePreference.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    control.readGraphQL.mockImplementationOnce(async () =>
      Response.json({
        data: { finaliseCncOrder: { orderId: '41', licenceId: 'BS-CNC-K7QM3T', checkoutUrl: CHECKOUT } },
      }),
    );
    const { result } = renderHook(() => useCncFinalise(token));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.finalise(FINALISE);
    });
    await waitFor(() => expect(finishCleanup).toBeTypeOf('function'));
    milliseconds += 120_000;
    await act(async () => {
      finishCleanup();
      await pending;
    });
    expect(locationAssign).not.toHaveBeenCalled();
    expect(control.readGraphQL).toHaveBeenCalledOnce();
    expect(result.current.errorKey).toBe('generic');
    expect(result.current.isFinalising).toBe(false);
  });
});
