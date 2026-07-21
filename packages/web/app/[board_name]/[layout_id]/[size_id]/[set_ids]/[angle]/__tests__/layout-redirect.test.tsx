import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PATHNAME_HEADER } from '@/app/lib/request-pathname-header';

// Regression for the numeric-URL redirect race: this layout owns the
// numeric→slug redirect for list-family child routes, but must defer for
// /view/ and /play/ so those pages' climb-preserving redirects run instead.

const { permanentRedirect, notFound, requestHeaders } = vi.hoisted(() => {
  const hoistedRedirect = vi.fn((url: string) => {
    const redirectError = new Error('NEXT_REDIRECT') as Error & { digest: string };
    redirectError.digest = `NEXT_REDIRECT;replace;${url};308;`;
    throw redirectError;
  });
  const hoistedNotFound = vi.fn(() => {
    throw new Error('NOT_FOUND');
  });
  return { permanentRedirect: hoistedRedirect, notFound: hoistedNotFound, requestHeaders: new Map<string, string>() };
});
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ permanentRedirect, notFound }));

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => ({ get: (name: string) => requestHeaders.get(name) ?? null })),
}));

vi.mock('@/app/lib/url-utils.server', () => ({
  parseRouteParams: vi.fn(async () => ({
    parsedParams: { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20], angle: 40 },
    isNumericFormat: true,
  })),
}));

vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: vi.fn(() => ({
    board_name: 'kilter',
    layout_name: 'Kilter Board Original',
    size_name: '12 x 12',
    size_description: 'Commercial',
    set_names: ['Bolt Ons', 'Screw Ons'],
  })),
  generateBoardTitle: vi.fn(() => 'Kilter Board'),
}));

// The layout's JSX pulls in client providers; none render in this test — the
// layout function only constructs the element tree — but the modules must load.
vi.mock('@/app/components/board-page/header', () => ({ default: () => null }));
vi.mock('@/app/components/graphql-queue', () => ({ GraphQLQueueProvider: () => null }));
vi.mock('@/app/components/connection-manager/connection-settings-context', () => ({
  ConnectionSettingsProvider: () => null,
}));
vi.mock('@/app/components/connection-manager/websocket-connection-provider', () => ({
  WebSocketConnectionProvider: () => null,
}));
vi.mock('@/app/components/persistent-session', () => ({ BoardSessionBridge: () => null }));
vi.mock('@/app/components/queue-control/ui-searchparams-provider', () => ({ UISearchParamsProvider: () => null }));
vi.mock('@/app/components/queue-control/queue-bridge-context', () => ({ QueueBridgeInjector: () => null }));
vi.mock('@/app/components/board-page/last-used-board-tracker', () => ({ default: () => null }));
vi.mock('@/app/components/providers/i18n-provider', () => ({ default: () => null }));

import BoardLayout from '../layout';

const layoutProps = {
  params: Promise.resolve({
    board_name: 'kilter',
    layout_id: '1',
    size_id: '10',
    set_ids: '1,20',
    angle: '40',
  }),
  children: null,
};

describe('legacy board layout numeric redirect gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestHeaders.clear();
  });

  it('redirects numeric list-family URLs to the slug list URL', async () => {
    requestHeaders.set(PATHNAME_HEADER, '/kilter/1/10/1,20/40/list');
    await expect(BoardLayout(layoutProps)).rejects.toMatchObject({ message: 'NEXT_REDIRECT' });
    expect(permanentRedirect).toHaveBeenCalledTimes(1);
    expect(permanentRedirect.mock.calls[0][0]).toContain('/list');
  });

  it('defers for numeric /view/ URLs so the view page can preserve the climb', async () => {
    requestHeaders.set(PATHNAME_HEADER, '/kilter/1/10/1,20/40/view/abcdef1234567890abcdef1234567890');
    const rendered = await BoardLayout(layoutProps);
    expect(permanentRedirect).not.toHaveBeenCalled();
    expect(rendered).toBeTruthy();
  });

  it('defers for numeric /play/ URLs', async () => {
    requestHeaders.set(PATHNAME_HEADER, '/kilter/1/10/1,20/40/play/abcdef1234567890abcdef1234567890');
    await BoardLayout(layoutProps);
    expect(permanentRedirect).not.toHaveBeenCalled();
  });
});
