import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

// Next's real `redirect` throws a NEXT_REDIRECT control-flow error rather than
// returning, and the route's code after it never runs. Mocking it as a plain
// spy would let execution fall off the end of the function; throwing a sentinel
// keeps the control flow honest AND makes the assertion a single catch.
class RedirectSignal extends Error {
  constructor(readonly target: string) {
    super(`redirect:${target}`);
  }
}
const notFound = vi.hoisted(() => vi.fn(() => undefined));
vi.mock('next/navigation', () => ({
  notFound,
  redirect: (target: string) => {
    throw new RedirectSignal(target);
  },
}));

const resolveBoardBySlug = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/board-slug-utils', () => ({ resolveBoardBySlug }));

const getServerAuthToken = vi.hoisted(() => vi.fn<() => Promise<string | undefined>>());
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken }));
const redeemBoardInvite = vi.hoisted(() => vi.fn());
const previewBoardInvite = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/board-invite.server', () => ({ redeemBoardInvite, previewBoardInvite }));
const BoardInviteSignIn = vi.hoisted(() => vi.fn(() => null));
vi.mock('../board-invite-sign-in', () => ({ default: BoardInviteSignIn }));
const BoardInviteJoin = vi.hoisted(() => vi.fn(() => null));
vi.mock('../board-invite-join', () => ({ default: BoardInviteJoin }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({ t: (key: string) => key, locale: 'en-US' }),
}));
const getLocale = vi.hoisted(() => vi.fn(async () => 'en-US'));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale }));

const pageModule = await import('../page');
const BoardSlugPage = pageModule.default;

async function redirectTargetFor(
  boardSlug: string,
  searchParams: Record<string, string | string[] | undefined>,
): Promise<string> {
  try {
    await BoardSlugPage({
      params: Promise.resolve({ board_slug: boardSlug }),
      searchParams: Promise.resolve(searchParams),
    });
  } catch (error) {
    if (error instanceof RedirectSignal) return error.target;
    throw error;
  }
  throw new Error('expected a redirect');
}

beforeEach(() => {
  resolveBoardBySlug.mockReset();
  notFound.mockReset();
  resolveBoardBySlug.mockResolvedValue({ slug: 'main-kilter', angle: 40 });
  getServerAuthToken.mockReset().mockResolvedValue(undefined);
  redeemBoardInvite.mockReset().mockResolvedValue(null);
  previewBoardInvite.mockReset().mockResolvedValue(null);
  BoardInviteSignIn.mockClear();
});

describe('/b/[board_slug] redirect', () => {
  it('carries the kiosk QR attribution params onto the board list', () => {
    // Before this change the target was a bare template string, so the whole
    // query was dropped and a kiosk scan arrived indistinguishable from someone
    // typing the URL.
    return expect(redirectTargetFor('main-kilter', { src: 'qr', medium: 'kiosk' })).resolves.toBe(
      '/b/main-kilter/40/list?src=qr&medium=kiosk',
    );
  });

  it('redirects to a clean URL with no trailing "?" when there were no params', () => {
    return expect(redirectTargetFor('main-kilter', {})).resolves.toBe('/b/main-kilter/40/list');
  });

  it('drops a crafted medium instead of echoing it into the redirect target', () => {
    return expect(redirectTargetFor('main-kilter', { src: 'qr', medium: 'evil' })).resolves.toBe(
      '/b/main-kilter/40/list',
    );
  });

  it('drops every other param a crafted link carries', () => {
    return expect(
      redirectTargetFor('main-kilter', {
        src: 'qr',
        medium: 'board',
        utm_campaign: 'someone-elses',
        next: 'https://evil.example.com',
      }),
    ).resolves.toBe('/b/main-kilter/40/list?src=qr&medium=board');
  });

  it('percent-encodes the slug so a "#" cannot swallow the params', async () => {
    // The printed URL already guards this (`gymQrUrl`, pinned by its own test);
    // the redirect that carries it has to agree, or the shape guarded on the
    // poster re-breaks on the hop.
    resolveBoardBySlug.mockResolvedValue({ slug: 'kilter#1', angle: 40 });

    await expect(redirectTargetFor('kilter#1', { src: 'qr', medium: 'kiosk' })).resolves.toBe(
      '/b/kilter%231/40/list?src=qr&medium=kiosk',
    );
  });

  it("opens the lookup with an unlisted wall's ?wall= and carries it onto the list", async () => {
    // Without the uuid the backend has no row for an unlisted wall, so this hop
    // would 404 the share link before the page that redeems it ever ran.
    resolveBoardBySlug.mockResolvedValue({ slug: 'garage-wall', angle: 40 });

    await expect(redirectTargetFor('garage-wall', { wall: 'wall-uuid-1' })).resolves.toBe(
      '/b/garage-wall/40/list?wall=wall-uuid-1',
    );
    expect(resolveBoardBySlug).toHaveBeenCalledWith('garage-wall', 'wall-uuid-1');
  });

  it('drops a repeated ?wall= rather than picking one', async () => {
    resolveBoardBySlug.mockResolvedValue({ slug: 'garage-wall', angle: 40 });

    await expect(redirectTargetFor('garage-wall', { wall: ['wall-uuid-1', 'wall-uuid-2'] })).resolves.toBe(
      '/b/garage-wall/40/list',
    );
    expect(resolveBoardBySlug).toHaveBeenCalledWith('garage-wall', undefined);
  });

  it('404s an unknown board without redirecting anywhere', async () => {
    resolveBoardBySlug.mockResolvedValue(null);

    await BoardSlugPage({
      params: Promise.resolve({ board_slug: 'nope' }),
      searchParams: Promise.resolve({ src: 'qr', medium: 'kiosk' }),
    });

    expect(notFound).toHaveBeenCalled();
  });

  it('stays a temporary (307) redirect even for the clean, no-attribution case', async () => {
    // The target embeds `board.angle`, a live DB field a board editor can change
    // via `updateBoard` (`isAngleAdjustable`). A permanent (308) redirect here
    // would be cached by browsers indefinitely, pinning a visitor to a stale
    // angle forever if the gym re-angled the board after they followed it — see
    // the rationale comment on the page component. `next/navigation` isn't
    // mocked with a `permanentRedirect` export at all, so this test also fails
    // loudly (a missing-export error) if a future change reaches for it here.
    await expect(redirectTargetFor('main-kilter', {})).resolves.toBe('/b/main-kilter/40/list');
  });
});

const TOKEN = 'Ab3_dE-fGhIjKlMnOpQrSt';

describe('/b/[board_slug] with a home board share link (?invite=)', () => {
  it('only previews a signed-in GET and requires a Join action before granting access', async () => {
    getServerAuthToken.mockResolvedValue('session-token');
    previewBoardInvite.mockResolvedValue({ name: 'Friends Garage' });
    const rendered = (await BoardSlugPage({
      params: Promise.resolve({ board_slug: 'stale-slug' }),
      searchParams: Promise.resolve({ invite: TOKEN }),
    })) as { type: unknown; props: { boardName: string; inviteToken: string } };
    expect(rendered.type).toBe(BoardInviteJoin);
    expect(rendered.props).toEqual({ boardName: 'Friends Garage', inviteToken: TOKEN });
    expect(redeemBoardInvite).not.toHaveBeenCalled();
    expect(resolveBoardBySlug).not.toHaveBeenCalled();
  });

  it('serves a refused link as the plain board link, never carrying the token on', async () => {
    getServerAuthToken.mockResolvedValue('session-token');
    redeemBoardInvite.mockResolvedValue(null);

    await expect(redirectTargetFor('main-kilter', { invite: TOKEN })).resolves.toBe('/b/main-kilter/40/list');
  });

  it('names the board for a signed-out visitor and returns them to this exact link after sign-in', async () => {
    previewBoardInvite.mockResolvedValue({ name: 'Friends Garage' });

    const rendered = (await BoardSlugPage({
      params: Promise.resolve({ board_slug: 'friends-garage' }),
      searchParams: Promise.resolve({ invite: TOKEN }),
    })) as { type: unknown; props: { boardName: string; returnPath: string } };

    expect(rendered.type).toBe(BoardInviteSignIn);
    expect(rendered.props).toEqual({
      boardName: 'Friends Garage',
      returnPath: `/b/friends-garage?invite=${TOKEN}`,
    });
    expect(redeemBoardInvite).not.toHaveBeenCalled();
    expect(resolveBoardBySlug).not.toHaveBeenCalled();
  });

  it('brings a visitor back in their own language after sign-in', async () => {
    previewBoardInvite.mockResolvedValue({ name: 'Plafón de Ana' });
    getLocale.mockResolvedValueOnce('es');

    const rendered = (await BoardSlugPage({
      params: Promise.resolve({ board_slug: 'friends-garage' }),
      searchParams: Promise.resolve({ invite: TOKEN }),
    })) as { props: { returnPath: string } };

    expect(rendered.props.returnPath).toBe(`/es/b/friends-garage?invite=${TOKEN}`);
  });

  it('falls through to the plain link when a signed-out visitor holds a dead link', async () => {
    previewBoardInvite.mockResolvedValue(null);

    await expect(redirectTargetFor('main-kilter', { invite: TOKEN })).resolves.toBe('/b/main-kilter/40/list');
  });

  it('never sends a malformed or repeated token to the backend', async () => {
    getServerAuthToken.mockResolvedValue('session-token');
    for (const invite of ['short', [TOKEN, TOKEN]]) {
      await expect(redirectTargetFor('main-kilter', { invite })).resolves.toBe('/b/main-kilter/40/list');
    }
    expect(redeemBoardInvite).not.toHaveBeenCalled();
    expect(previewBoardInvite).not.toHaveBeenCalled();
  });

  it('keeps the share-link page out of the index and its title free of the board name', async () => {
    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({ board_slug: 'friends-garage' }),
      searchParams: Promise.resolve({ invite: TOKEN }),
    });
    expect(metadata.robots).toMatchObject({ index: false });
    expect(metadata.referrer).toBe('no-referrer');
    expect(JSON.stringify(metadata)).not.toContain(TOKEN);
    expect(JSON.stringify(metadata.title)).toContain('boardShareLink.metadataTitle');
  });
});
