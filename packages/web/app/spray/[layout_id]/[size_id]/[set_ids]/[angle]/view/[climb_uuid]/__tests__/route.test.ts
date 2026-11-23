// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/backend-url', () => ({ getGraphQLHttpUrl: () => 'https://backend.example/graphql' }));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: vi.fn(async () => 'en-US') }));

import { GET } from '../route';
import { getLocale } from '@/app/lib/i18n/get-locale';

const CLIMB_UUID = 'CEA229E4A8D84644B7DF7BC6F8A47222';
const WALL_UUID = '1bd0c0b6-de10-43fe-bd40-74a902658b8b';
const LEGACY_URL = `https://www.boardsesh.com/spray/229/229/1/40/view/${CLIMB_UUID}`;
const TARGET_URL = `https://www.boardsesh.com/b/ravenbird-s-spraywall/40/view/${CLIMB_UUID}`;
const PARAMS = { layout_id: '229', size_id: '229', set_ids: '1', angle: '40', climb_uuid: CLIMB_UUID };
const PUBLIC_WALL = {
  uuid: WALL_UUID,
  board: { slug: 'ravenbird-s-spraywall', isPublic: true, isUnlisted: false },
};
const fetchMock = vi.fn<typeof fetch>();

function answerWithWall(wall: typeof PUBLIC_WALL | null) {
  fetchMock.mockResolvedValue(Response.json({ data: { sprayWallByLayout: wall } }));
}

function openLegacyClimb(query = '', params = PARAMS) {
  return GET(new Request(`${LEGACY_URL}${query}`), { params: Promise.resolve(params) });
}

function requestedVariables(): unknown {
  const requestBody = fetchMock.mock.calls[0][1]?.body;
  if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body');
  return (JSON.parse(requestBody) as { variables: unknown }).variables;
}

function expectUncached(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store');
  expect(response.headers.get('X-Robots-Tag')).toBe('noindex, follow');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(getLocale).mockResolvedValue('en-US');
  answerWithWall(PUBLIC_WALL);
});

afterEach(() => vi.unstubAllGlobals());

describe('legacy spray climb links', () => {
  it('redirects the reported beta link to its public wall without catalogue lookups', async () => {
    const response = await openLegacyClimb();

    expect(response.status).toBe(307);
    expect(response.headers.get('Location')).toBe(TARGET_URL);
    expectUncached(response);
    const [backendUrl, options] = fetchMock.mock.calls[0];
    expect(backendUrl).toBe('https://backend.example/graphql');
    expect(options?.cache).toBe('no-store');
    expect(new Headers(options?.headers).has('Authorization')).toBe(false);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(requestedVariables()).toEqual({ layoutId: 229 });
  });

  it('preserves the locale, climb-name segment and query parameters', async () => {
    vi.mocked(getLocale).mockResolvedValue('fr');
    const climbSegment = `blue-traverse-${CLIMB_UUID}`;
    const response = await openLegacyClimb('?from=beta&utm_source=share', { ...PARAMS, climb_uuid: climbSegment });

    expect(response.headers.get('Location')).toBe(
      `https://www.boardsesh.com/fr/b/ravenbird-s-spraywall/40/view/${climbSegment}?from=beta&utm_source=share`,
    );
  });

  it('passes a matching unlisted-wall capability through the lookup and redirect', async () => {
    answerWithWall({ ...PUBLIC_WALL, board: { ...PUBLIC_WALL.board, isPublic: false, isUnlisted: true } });
    const response = await openLegacyClimb(`?wall=${WALL_UUID}`);

    expect(response.status).toBe(307);
    expect(response.headers.get('Location')).toBe(`${TARGET_URL}?wall=${WALL_UUID}`);
    expectUncached(response);
    expect(requestedVariables()).toEqual({
      layoutId: 229,
      sprayWallUuid: WALL_UUID,
    });
  });

  it('rechecks visibility on later visits after a public wall becomes private', async () => {
    expect((await openLegacyClimb()).status).toBe(307);
    answerWithWall(null);
    const response = await openLegacyClimb();

    expect(response.status).toBe(404);
    expect(response.headers.has('Location')).toBe(false);
    expectUncached(response);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: 'missing wall', wall: null, query: '' },
    { label: 'private wall', wall: { ...PUBLIC_WALL, board: { ...PUBLIC_WALL.board, isPublic: false } }, query: '' },
    {
      label: 'unlisted wall without a capability',
      wall: { ...PUBLIC_WALL, board: { ...PUBLIC_WALL.board, isPublic: false, isUnlisted: true } },
      query: '',
    },
    { label: 'mismatched capability', wall: PUBLIC_WALL, query: '?wall=94c9041f-dc32-4e36-af09-18a0bc49c1bb' },
  ])('keeps a $label inaccessible', async ({ wall, query }) => {
    answerWithWall(wall);
    const response = await openLegacyClimb(query);

    expect(response.status).toBe(404);
    expect(response.headers.has('Location')).toBe(false);
    expectUncached(response);
  });

  it.each(['?wall=', '?wall=another-wall', `?wall=${'a'.repeat(65)}`, `?wall=${WALL_UUID}&wall=${WALL_UUID}`])(
    'refuses malformed capabilities before asking the backend: %s',
    async (query) => {
      expect((await openLegacyClimb(query)).status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { layout_id: 'garage' },
    { layout_id: '0', size_id: '0' },
    { layout_id: '2147483648', size_id: '2147483648' },
    { size_id: '230' },
    { size_id: '229junk' },
    { set_ids: '2' },
    { set_ids: '1,2' },
    { angle: 'steep' },
    { angle: '91' },
  ])('refuses an invalid wall tuple before asking the backend: %j', async (invalidParams) => {
    expect((await openLegacyClimb('', { ...PARAMS, ...invalidParams })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'HTTP failure', response: () => new Response(null, { status: 502 }) },
    { label: 'GraphQL failure', response: () => Response.json({ data: null, errors: [{ message: 'unavailable' }] }) },
    { label: 'missing GraphQL data', response: () => Response.json({}) },
    { label: 'missing wall field', response: () => Response.json({ data: {} }) },
  ])('returns a retryable status on $label', async ({ response }) => {
    fetchMock.mockResolvedValue(response());
    const result = await openLegacyClimb();

    expect(result.status).toBe(503);
    expectUncached(result);
  });

  it('returns a retryable status when the backend times out', async () => {
    fetchMock.mockRejectedValue(new DOMException('deadline exceeded', 'TimeoutError'));
    const response = await openLegacyClimb();

    expect(response.status).toBe(503);
    expectUncached(response);
  });
});
