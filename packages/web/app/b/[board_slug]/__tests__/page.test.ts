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
// permanentRedirect gets its own sentinel class so a test can assert WHICH
// redirect function fired — a plain string check couldn't distinguish a 307
// (redirect) from a 308 (permanentRedirect) hop to the same target.
class PermanentRedirectSignal extends Error {
  constructor(readonly target: string) {
    super(`permanentRedirect:${target}`);
  }
}
const notFound = vi.hoisted(() => vi.fn(() => undefined));
vi.mock('next/navigation', () => ({
  notFound,
  redirect: (target: string) => {
    throw new RedirectSignal(target);
  },
  permanentRedirect: (target: string) => {
    throw new PermanentRedirectSignal(target);
  },
}));

const resolveBoardBySlug = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/board-slug-utils', () => ({ resolveBoardBySlug }));

const BoardSlugPage = (await import('../page')).default;

type RedirectOutcome = { type: 'redirect' | 'permanentRedirect'; target: string };

async function runBoardSlugPage(
  boardSlug: string,
  searchParams: Record<string, string | string[] | undefined>,
): Promise<RedirectOutcome> {
  try {
    await BoardSlugPage({
      params: Promise.resolve({ board_slug: boardSlug }),
      searchParams: Promise.resolve(searchParams),
    });
  } catch (error) {
    if (error instanceof RedirectSignal) return { type: 'redirect', target: error.target };
    if (error instanceof PermanentRedirectSignal) return { type: 'permanentRedirect', target: error.target };
    throw error;
  }
  throw new Error('expected a redirect');
}

// QR-attributed hops still go through `redirect` (307) — kept for the
// existing attribution tests below, which only care about the target.
async function redirectTargetFor(
  boardSlug: string,
  searchParams: Record<string, string | string[] | undefined>,
): Promise<string> {
  const outcome = await runBoardSlugPage(boardSlug, searchParams);
  expect(outcome.type).toBe('redirect');
  return outcome.target;
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

  it('permanently redirects to a clean URL with no trailing "?" when there were no params', async () => {
    // No QR attribution to carry means this hop is a stable, deterministic
    // redirect to the same list page every time — cacheable as a 308.
    const outcome = await runBoardSlugPage('main-kilter', {});
    expect(outcome.type).toBe('permanentRedirect');
    expect(outcome.target).toBe('/b/main-kilter/40/list');
  });

  it('drops a crafted medium and still permanently redirects (no attribution to carry)', async () => {
    const outcome = await runBoardSlugPage('main-kilter', { src: 'qr', medium: 'evil' });
    expect(outcome.type).toBe('permanentRedirect');
    expect(outcome.target).toBe('/b/main-kilter/40/list');
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

  it('404s an unknown board without redirecting anywhere', async () => {
    resolveBoardBySlug.mockResolvedValue(null);

    await BoardSlugPage({
      params: Promise.resolve({ board_slug: 'nope' }),
      searchParams: Promise.resolve({ src: 'qr', medium: 'kiosk' }),
    });

    expect(notFound).toHaveBeenCalled();
  });
});
