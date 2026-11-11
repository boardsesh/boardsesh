// @vitest-environment node
import { webClientIdentityHeaders } from '../../client-identity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encode } from 'next-auth/jwt';

vi.mock('server-only', () => ({}));
vi.mock('../../backend-url', () => ({ getGraphQLHttpUrl: () => 'http://authority.invalid/graphql' }));

import { admitPresentedWebCredential, CredentialAuthorityUnavailable } from '../credential-admission.server';

const fixtureSecret = 'local-credential-admission-fixture-secret';
let credential: string;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(async () => {
  vi.stubEnv('NEXTAUTH_SECRET', fixtureSecret);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  credential = await encode({ secret: fixtureSecret, token: { sub: 'fixture-owner' }, maxAge: 60 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('presented web credential admission', () => {
  it('sends the exact public-codec JWE without accepting a caller-supplied UID', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: { authenticatedUserId: 'fixture-owner' } }));
    await expect(admitPresentedWebCredential(credential)).resolves.toBe('fixture-owner');
    const [endpoint, options] = fetchMock.mock.calls[0];
    expect(endpoint).toBe('http://authority.invalid/graphql');
    expect(options?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential}`,
      ...webClientIdentityHeaders(),
    });
    const requestBody = options?.body;
    if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(requestBody)).toEqual({
      query: expect.stringContaining('authenticatedUserId'),
    });
    expect(options).toMatchObject({ cache: 'no-store', redirect: 'error' });
  });

  it('does not cache a successful authority result across repeated reads', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: { authenticatedUserId: 'fixture-owner' } }));
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: null,
        errors: [{ message: 'Authentication required', extensions: { code: 'UNAUTHENTICATED' } }],
      }),
    );
    await expect(admitPresentedWebCredential(credential)).resolves.toBe('fixture-owner');
    await expect(admitPresentedWebCredential(credential)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { errors: [{ message: 'Cannot query field authenticatedUserId' }] },
    { data: { authenticatedUserId: 'another-owner' } },
    { data: { authenticatedUserId: null } },
    {},
    { data: null, errors: [{ extensions: { code: 'SERVICE_UNAVAILABLE' } }] },
    { data: { authenticatedUserId: 'fixture-owner' }, errors: [{ extensions: { code: 'UNAUTHENTICATED' } }] },
    {
      data: null,
      errors: [{ extensions: { code: 'UNAUTHENTICATED' } }, { extensions: { code: 'SERVICE_UNAVAILABLE' } }],
    },
  ])('keeps unknown or inconsistent backend responses unavailable: %j', async (result) => {
    fetchMock.mockResolvedValue(Response.json(result));
    await expect(admitPresentedWebCredential(credential)).rejects.toBeInstanceOf(CredentialAuthorityUnavailable);
  });

  it('reads the backend 401 for a refused cookie (deleted account, reset) as a denial', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { errors: [{ message: 'Authentication is required', extensions: { code: 'UNAUTHENTICATED' } }] },
        { status: 401 },
      ),
    );
    await expect(admitPresentedWebCredential(credential)).resolves.toBeNull();
  });

  it.each([
    { data: { authenticatedUserId: 'fixture-owner' } },
    { errors: [{ extensions: { code: 'SERVICE_UNAVAILABLE' } }] },
    { errors: [{ extensions: { code: 'UNAUTHENTICATED' } }, { extensions: { code: 'UNAUTHENTICATED' } }] },
    {},
  ])('never admits, and never reads anything but UNAUTHENTICATED as a denial, from a 401: %j', async (result) => {
    fetchMock.mockResolvedValue(Response.json(result, { status: 401 }));
    await expect(admitPresentedWebCredential(credential)).rejects.toBeInstanceOf(CredentialAuthorityUnavailable);
  });

  it.each([403, 429, 503])('does not mistake an HTTP %i for a known unauthenticated decision', async (status) => {
    fetchMock.mockResolvedValue(Response.json({ errors: [{ extensions: { code: 'UNAUTHENTICATED' } }] }, { status }));
    await expect(admitPresentedWebCredential(credential)).rejects.toBeInstanceOf(CredentialAuthorityUnavailable);
  });

  it('does not expose transport errors which could include the credential', async () => {
    fetchMock.mockRejectedValue(new Error(credential));
    const failure = await admitPresentedWebCredential(credential).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialAuthorityUnavailable);
    expect(failure).toHaveProperty('message', 'Credential authority is temporarily unavailable');
    expect(failure).not.toHaveProperty('cause');
  });

  it('rejects malformed or expired public-codec credentials before transport', async () => {
    await expect(admitPresentedWebCredential('invalid')).resolves.toBeNull();
    const expired = await encode({ secret: fixtureSecret, token: { sub: 'fixture-owner' }, maxAge: -120 });
    await expect(admitPresentedWebCredential(expired)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves uncertainty when the local secret is unavailable', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', '');
    await expect(admitPresentedWebCredential(credential)).rejects.toBeInstanceOf(CredentialAuthorityUnavailable);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects overdue results even before an overdue timer callback can run', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    fetchMock.mockImplementation(async () => {
      elapsed = 3_001;
      return Response.json({ data: { authenticatedUserId: 'fixture-owner' } });
    });
    await expect(admitPresentedWebCredential(credential)).rejects.toBeInstanceOf(CredentialAuthorityUnavailable);
  });

  it('keeps body consumption inside the deadline and discards late positives', async () => {
    vi.useFakeTimers();
    let resolveBody: ((result: unknown) => void) | undefined;
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        new Promise<unknown>((resolve) => {
          resolveBody = resolve;
        }),
    } as Response);
    const admission = admitPresentedWebCredential(credential);
    // Public JWE decryption uses asynchronous WebCrypto before transport.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(3_001);
    resolveBody?.({ data: { authenticatedUserId: 'fixture-owner' } });
    await expect(admission).rejects.toBeInstanceOf(CredentialAuthorityUnavailable);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
