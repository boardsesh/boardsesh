import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import type { BrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';

const fixture = vi.hoisted(() => ({
  generation: 0,
  clock: 0,
  backend: null as ReturnType<typeof createBrowserBackendClient> | null,
  owner: null as BrowserBackendLeaseOwner | null,
}));
vi.mock('../env', () => ({ BACKEND_URL: 'https://owned-backend.test' }));
vi.mock('../upload-image', () => import('../upload-image.web'));
vi.mock('../authenticated-response-scope', () => import('../authenticated-response-scope.web'));
vi.mock('../auth-interceptor', () => import('../auth-interceptor.web'));
vi.mock('../auth-store.web', () => ({
  captureAuthCredentialGeneration: () => fixture.generation,
  isAuthCredentialGenerationCurrent: (expected: number) => expected === fixture.generation,
  isRequiredBrowserDispatch: () => true,
  hasConfirmedAnonymousWebSession: () => false,
  getAuthToken: async () => {
    const lease = await fixture.backend!.acquire(fixture.owner!);
    return lease.token;
  },
  synchronizeWebSession: () => {
    throw new Error('No legacy session fallback');
  },
}));
vi.mock('../browser-backend-client.web', () => ({
  expoBrowserBackendClient: new Proxy(
    {},
    {
      get(_target, property) {
        return Reflect.get(fixture.backend!, property);
      },
    },
  ),
}));
vi.mock('../auth.web', () => ({ signOutForGeneration: vi.fn() }));
vi.mock('../error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../client-identity.web', () => ({ getClientIdentityHeaderValue: () => 'owned-avatar-web' }));

import { uploadAvatarWithReceipt } from '../avatar-upload';

let requests: ReturnType<typeof vi.fn<typeof fetch>>;
let issueCount: number;
const originalFetch = globalThis.fetch;
const imageUris: string[] = [];
function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
function image() {
  const uri = URL.createObjectURL(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }));
  imageUris.push(uri);
  return { uri };
}
function accept(userId = 'owned-A') {
  const owner = {
    userId,
    authSessionId: `owned-SID-${userId}`,
    generation: 1,
    cursor: { bindingId: 'a'.repeat(64), version: 2 },
  };
  fixture.owner = owner;
  fixture.backend!.acceptSession({
    user: { id: owner.userId },
    authSessionId: owner.authSessionId,
    authGeneration: owner.generation,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: owner,
  });
}
function action() {
  const generation = fixture.generation;
  return {
    assertView() {
      if (fixture.generation !== generation) throw new Error('Original UI view retired');
    },
  };
}
function holdBody() {
  let close!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"avatarUrl":"/static/avatars/owned-A.jpg"}'));
        close = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, close: () => close() };
}

beforeEach(() => {
  fixture.generation = 0;
  fixture.clock = 0;
  issueCount = 0;
  fixture.backend = createBrowserBackendClient({
    ready: () => true,
    endpoint: '/owned-avatar-lease',
    now: () => fixture.clock,
    schedule: () => () => {},
    fetch: async () =>
      Response.json({
        status: 'admitted',
        token: `bsbd1_OWNED_AVATAR_${++issueCount}`,
        owner: fixture.owner,
        usableForMs: 120_000,
      }),
  });
  accept();
  requests = vi.fn<typeof fetch>(async (input, options) => {
    if (requestUrl(input).startsWith('blob:')) return originalFetch(input, options);
    return Response.json({ avatarUrl: '/static/avatars/owned-A.jpg' });
  });
  vi.stubGlobal('fetch', requests);
});
afterEach(() => {
  fixture.backend?.dispose();
  fixture.backend = null;
  imageUris.splice(0).forEach((uri) => URL.revokeObjectURL(uri));
  vi.unstubAllGlobals();
});
const uploads = () =>
  requests.mock.calls.filter(([input]) => requestUrl(input) === 'https://owned-backend.test/api/avatars');

describe('actual selected avatar uploader and original REST lease', () => {
  it('sends actual multipart bytes with an admitted lease and returns a caller-owned receipt', async () => {
    const receipt = await uploadAvatarWithReceipt(image(), 'owned-A', action());
    receipt.assertCurrent();
    expect(receipt.result).toMatch(/^https:\/\/owned-backend.test\/static\/avatars\/owned-A.jpg\?v=\d+$/);
    expect(uploads()).toHaveLength(1);
    const [, init] = uploads()[0];
    expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer bsbd1_OWNED_AVATAR_1');
    const form = await new Request('https://owned-backend.test/api/avatars', init).formData();
    expect(form.getAll('userId')[0]).toBe('owned-A');
    const uploadedImage = form.getAll('avatar')[0] as unknown as Blob;
    expect(new Uint8Array(await uploadedImage.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(issueCount).toBe(1);
  });

  it('refuses an already cancelled action before local image reads or lease issuance', async () => {
    const controller = new AbortController();
    const reason = new Error('Original form already unmounted');
    controller.abort(reason);
    await expect(uploadAvatarWithReceipt(image(), 'owned-A', { ...action(), signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(requests).not.toHaveBeenCalled();
    expect(issueCount).toBe(0);
  });

  it('cannot adopt B while reading abort-ignoring local image bytes before the backend send', async () => {
    let release!: (response: Response) => void;
    requests.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const pending = uploadAvatarWithReceipt(image(), 'owned-A', action());
    const refused = expect(pending).rejects.toThrow('Original UI view retired');
    await vi.waitFor(() => expect(requests).toHaveBeenCalledTimes(1));
    fixture.generation += 1;
    accept('owned-B');
    release(new Response(new Blob(['original A image'])));
    await refused;
    expect(uploads()).toHaveLength(0);
    expect(issueCount).toBe(0);
  });

  it('rejects an old abort-ignoring upload body after B without replay', async () => {
    const body = holdBody();
    requests.mockImplementation(async (input, options) =>
      requestUrl(input).startsWith('blob:') ? originalFetch(input, options) : body.response,
    );
    const pending = uploadAvatarWithReceipt(image(), 'owned-A', action());
    const refused = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(uploads()).toHaveLength(1));
    fixture.generation += 1;
    accept('owned-B');
    body.close();
    await refused;
    expect(uploads()).toHaveLength(1);
  });

  it('never extends an earlier derived avatar URL with a newer same-owner lease', async () => {
    const original = await uploadAvatarWithReceipt(image(), 'owned-A', action());
    fixture.clock = 90_000;
    const current = await uploadAvatarWithReceipt(image(), 'owned-A', action());
    fixture.clock = 120_001;
    expect(() => original.assertCurrent()).toThrow();
    current.assertCurrent();
    expect(issueCount).toBe(2);
  });

  it('refuses cancellation during actual JSON decoding even when the body ignores abort', async () => {
    const body = holdBody();
    const controller = new AbortController();
    requests.mockImplementation(async (input, options) =>
      requestUrl(input).startsWith('blob:') ? originalFetch(input, options) : body.response,
    );
    const pending = uploadAvatarWithReceipt(image(), 'owned-A', { ...action(), signal: controller.signal });
    const reason = new Error('Original form unmounted');
    const refused = expect(pending).rejects.toBe(reason);
    await vi.waitFor(() => expect(uploads()).toHaveLength(1));
    controller.abort(reason);
    body.close();
    await refused;
    expect(uploads()).toHaveLength(1);
  });
});
