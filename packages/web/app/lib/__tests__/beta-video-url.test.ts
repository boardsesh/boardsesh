import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

describe('mapBetaLinksResponse — thumbnail absolutization', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function commonRow(thumbnail: string | null) {
    return {
      climbUuid: 'climb-1',
      link: 'https://www.instagram.com/p/ABC/',
      foreignUsername: 'climber',
      angle: null,
      thumbnail,
      isListed: true,
      createdAt: '2026-04-26T00:00:00Z',
      attachedByUser: null,
    };
  }

  it('prepends the backend origin to a relative /static/... thumbnail', async () => {
    process.env.NEXT_PUBLIC_WS_URL = 'wss://ws.boardsesh.com/graphql';
    const { mapBetaLinksResponse } = await import('../beta-video-url');

    const [link] = mapBetaLinksResponse([commonRow('/static/beta-link-thumbnails/instagram/ABC.jpg')]);

    expect(link.thumbnail).toBe('https://ws.boardsesh.com/static/beta-link-thumbnails/instagram/ABC.jpg?size=280');
  });

  it('leaves an absolute http(s) thumbnail untouched (legacy direct-bucket URLs that have not been backfilled yet)', async () => {
    process.env.NEXT_PUBLIC_WS_URL = 'wss://ws.boardsesh.com/graphql';
    const { mapBetaLinksResponse } = await import('../beta-video-url');

    const legacy = 'https://t3.storageapi.dev/structured-parcel-ei3jl8g/beta-link-thumbnails/instagram/ABC.jpg';
    const [link] = mapBetaLinksResponse([commonRow(legacy)]);

    expect(link.thumbnail).toBe(legacy);
  });

  it('leaves a null thumbnail null', async () => {
    process.env.NEXT_PUBLIC_WS_URL = 'wss://ws.boardsesh.com/graphql';
    const { mapBetaLinksResponse } = await import('../beta-video-url');

    const [link] = mapBetaLinksResponse([commonRow(null)]);

    expect(link.thumbnail).toBeNull();
  });

  it('returns the relative path unchanged when no backend URL can be resolved', async () => {
    delete process.env.NEXT_PUBLIC_WS_URL;
    delete process.env.BACKEND_INTERNAL_URL;
    const { mapBetaLinksResponse } = await import('../beta-video-url');

    const [link] = mapBetaLinksResponse([commonRow('/static/beta-link-thumbnails/instagram/ABC.jpg')]);

    // Falls back to the relative path so same-origin deploys still render
    // the thumbnail; split-domain deploys without a configured backend URL
    // would just have to set NEXT_PUBLIC_WS_URL. The ?size= still rides
    // along so same-origin deploys also get the sized variant.
    expect(link.thumbnail).toBe('/static/beta-link-thumbnails/instagram/ABC.jpg?size=280');
  });

  it('does not produce double slashes if the backend URL ever ends with a slash', async () => {
    // getBackendHttpUrl strips trailing slashes today, but absolutize is
    // defensive against a future change to that contract — a doubled slash
    // would 404 against the static handler and silently break thumbnails.
    process.env.NEXT_PUBLIC_WS_URL = 'wss://ws.boardsesh.com/graphql';
    const backendUrl = await import('../backend-url');
    vi.spyOn(backendUrl, 'getBackendHttpUrl').mockReturnValue('https://ws.boardsesh.com/');
    const { mapBetaLinksResponse } = await import('../beta-video-url');

    const [link] = mapBetaLinksResponse([commonRow('/static/beta-link-thumbnails/instagram/ABC.jpg')]);

    expect(link.thumbnail).toBe('https://ws.boardsesh.com/static/beta-link-thumbnails/instagram/ABC.jpg?size=280');
  });
});
