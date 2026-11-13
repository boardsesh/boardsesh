// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { readSelectedBrowserProfile } from '../browser-profile-client';
import { BrowserProfileAuthorityError, ProfileNotFoundError } from '../browser-profile-response';

function session(userId = 'owner-a') {
  return {
    user: { id: userId },
    authSessionId: `${userId}-login`,
    authGeneration: 3,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: {
      userId,
      authSessionId: `${userId}-login`,
      generation: 3,
      cursor: { bindingId: 'a'.repeat(64), version: 2 },
    },
  };
}
const profile = {
  id: 'owner-a',
  email: 'PRIVATE_EMAIL',
  name: 'Climber',
  image: null,
  profile: null,
  credentials: [{ boardType: 'kilter', auroraUsername: 'PRIVATE_MAPPING' }],
  followerCount: 2,
  followingCount: 3,
  isFollowedByMe: false,
};
let client: ReturnType<typeof createBrowserBackendClient>;
let current: ReturnType<typeof session>;
let fetchProfile: ReturnType<typeof vi.fn<typeof fetch>>;
function envelope() {
  return { browserProfileVersion: 1, owner: current.browserSelection, profile };
}
const read = (actor: unknown = current, signal?: AbortSignal, onDenied?: () => void) =>
  readSelectedBrowserProfile({ userId: 'owner-a', session: actor, client, fetch: fetchProfile, signal, onDenied });
beforeEach(() => {
  client = createBrowserBackendClient({
    ready: () => true,
    fetch: vi.fn<typeof fetch>(),
    endpoint: '/owned-unused-lease',
    now: () => 0,
    schedule: () => () => {},
  });
  current = session();
  client.acceptSession(current);
  fetchProfile = vi.fn<typeof fetch>(async () => Response.json(envelope()));
});
afterEach(() => {
  client.dispose();
  vi.restoreAllMocks();
});

describe('selected profile reads require actual local and response ownership', () => {
  it('accepts the actual Session object and exact server owner with no bearer dispatch', async () => {
    expect(await read()).toEqual(profile);
    expect(fetchProfile).toHaveBeenCalledWith(
      '/api/internal/profile/owner-a',
      expect.objectContaining({ credentials: 'include', cache: 'no-store', signal: expect.any(AbortSignal) }),
    );
    expect(fetchProfile.mock.calls[0][1]?.headers).toBeUndefined();
  });
  it('rejects copied metadata before dispatch', async () => {
    await expect(read(structuredClone(current))).rejects.toMatchObject({ code: 'superseded' });
    expect(fetchProfile).not.toHaveBeenCalled();
  });
  it('rejects a retired owner while response headers are pending', async () => {
    let release!: (response: Response) => void;
    fetchProfile.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const pending = read();
    const refused = expect(pending).rejects.toMatchObject({ code: 'superseded' });
    client.retire();
    release(Response.json(envelope()));
    await refused;
  });
  it.each(['retired', 'same-tuple-ABA'] as const)('rejects an abort-ignoring %s body', async (transition) => {
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => (bodyStarted = resolve));
    let finish!: () => void;
    fetchProfile.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: null,
      json: async () => {
        bodyStarted();
        await new Promise<void>((resolve) => (finish = resolve));
        return envelope();
      },
    } as Response);
    const pending = read();
    const refused = expect(pending).rejects.toMatchObject({ code: 'superseded' });
    await started;
    if (transition === 'retired') client.retire();
    else {
      client.acceptSession(session('owner-b'));
      client.acceptSession(session());
    }
    finish();
    await refused;
  });
  it.each(['userId', 'authSessionId', 'generation', 'bindingId', 'version'] as const)(
    'rejects a response with mismatched %s despite an actual current local receipt',
    async (field) => {
      const reply = structuredClone(envelope());
      if (field === 'userId') reply.owner.userId = 'owner-b';
      if (field === 'authSessionId') reply.owner.authSessionId = 'new-login';
      if (field === 'generation') reply.owner.generation += 1;
      if (field === 'bindingId') reply.owner.cursor.bindingId = 'b'.repeat(64);
      if (field === 'version') reply.owner.cursor.version += 1;
      fetchProfile.mockResolvedValueOnce(Response.json(reply));
      await expect(read()).rejects.toMatchObject({ code: 'superseded' });
    },
  );
  it('rejects retirement during a real partially consumed response stream', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(envelope()));
    const split = Math.floor(bytes.length / 2);
    let resume!: () => void;
    let held!: () => void;
    const bodyHeld = new Promise<void>((resolve) => (held = resolve));
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (++pulls === 1) {
            controller.enqueue(bytes.slice(0, split));
            return;
          }
          return new Promise<void>((resolve) => {
            resume = () => {
              controller.enqueue(bytes.slice(split));
              controller.close();
              resolve();
            };
            held();
          });
        },
      },
      { highWaterMark: 0 },
    );
    fetchProfile.mockResolvedValueOnce(new Response(body));
    const pending = read();
    const refused = expect(pending).rejects.toMatchObject({ code: 'superseded' });
    await bodyHeld;
    client.retire();
    resume();
    await refused;
  });
  it('refuses flat legacy JSON instead of treating it as selected authority', async () => {
    fetchProfile.mockResolvedValueOnce(Response.json(profile));
    await expect(read()).rejects.toBeInstanceOf(BrowserProfileAuthorityError);
  });
  it('keeps a503 distinct from anonymity and preserves the same-owner receipt', async () => {
    fetchProfile.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
    await expect(read()).rejects.toMatchObject({ code: 'unavailable' });
    expect(client.isSessionCurrent(current)).toBe(true);
    expect(client.isAnonymous()).toBe(false);
  });
  it.each([401, 409])('retires a current %s response without manufacturing sign-out', async (status) => {
    const refresh = vi.fn();
    fetchProfile.mockResolvedValueOnce(Response.json({ error: 'identity_changed' }, { status }));
    await expect(read(current, undefined, refresh)).rejects.toMatchObject({ code: 'superseded' });
    expect(client.isSessionCurrent(current)).toBe(false);
    expect(client.getSnapshot().owner).toBeNull();
    expect(client.isAnonymous()).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('an old denial cannot retire a later actual accepted account', async () => {
    let release!: (response: Response) => void;
    fetchProfile.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const pending = read();
    const refused = expect(pending).rejects.toMatchObject({ code: 'superseded' });
    const later = session('owner-b');
    client.acceptSession(later);
    release(Response.json({ error: 'identity_changed' }, { status: 401 }));
    await refused;
    expect(client.isSessionCurrent(later)).toBe(true);
  });
  it('retains the meaningful not-found outcome only for a current request', async () => {
    fetchProfile.mockResolvedValueOnce(Response.json({ error: 'profile_not_found' }, { status: 404 }));
    await expect(read()).rejects.toBeInstanceOf(ProfileNotFoundError);
  });
  it('admits only an actual anonymous receipt and a public-only response', async () => {
    client.acceptSession(null);
    const publicProfile = { ...profile, email: undefined, credentials: [] };
    fetchProfile.mockResolvedValueOnce(
      Response.json({ browserProfileVersion: 1, owner: null, profile: publicProfile }),
    );
    expect(await read(null)).toEqual(publicProfile);
    client.retire();
    await expect(read(null)).rejects.toMatchObject({ code: 'superseded' });
    expect(fetchProfile).toHaveBeenCalledTimes(1);
  });
  it('refuses private email or mapping data labelled anonymous', async () => {
    client.acceptSession(null);
    fetchProfile.mockResolvedValueOnce(Response.json({ browserProfileVersion: 1, owner: null, profile }));
    await expect(read(null)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('caps actual UTF8 response bytes and returns a sanitized error', async () => {
    const reply = envelope();
    reply.profile = { ...profile, name: 'é'.repeat(40_000) };
    fetchProfile.mockResolvedValueOnce(Response.json(reply));
    await expect(read()).rejects.toMatchObject({ code: 'unavailable', message: 'Profile authority is unavailable' });
  });
  it('rejects a caller cancellation without parsing or returning private bytes', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(read(current, controller.signal)).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetchProfile).not.toHaveBeenCalled();
  });
  it.each(['caller', 'deadline'] as const)(
    'settles a %s cancellation while an abort-ignoring JSON fallback remains held',
    async (cancellation) => {
      const controller = new AbortController();
      const deadline =
        cancellation === 'deadline' ? vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal) : null;
      let bodyStarted!: () => void;
      const started = new Promise<void>((resolve) => (bodyStarted = resolve));
      let finish!: () => void;
      fetchProfile.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: null,
        json: async () => {
          bodyStarted();
          await new Promise<void>((resolve) => (finish = resolve));
          return envelope();
        },
      } as Response);
      const pending = read(current, cancellation === 'caller' ? controller.signal : undefined);
      const refused = expect(pending).rejects.toMatchObject({ code: 'unavailable' });
      await started;
      controller.abort();
      try {
        // Cancellation must settle without the non-cooperative body completing.
        await refused;
        expect(client.isSessionCurrent(current)).toBe(true);
        expect(client.isAnonymous()).toBe(false);
        if (deadline) expect(deadline).toHaveBeenCalledWith(15_000);
      } finally {
        finish();
      }
    },
  );
});
