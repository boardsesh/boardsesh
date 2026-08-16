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

const BoardSlugPage = (await import('../page')).default;

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

  it('404s an unknown board without redirecting anywhere', async () => {
    resolveBoardBySlug.mockResolvedValue(null);

    await BoardSlugPage({
      params: Promise.resolve({ board_slug: 'nope' }),
      searchParams: Promise.resolve({ src: 'qr', medium: 'kiosk' }),
    });

    expect(notFound).toHaveBeenCalled();
  });
});
