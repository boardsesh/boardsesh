// @vitest-environment jsdom
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  privacy: { enabled: false } as { enabled: boolean } | undefined,
  subscribe: vi.fn((_operation: unknown, _callbacks: unknown) => vi.fn()),
  invalidate: vi.fn(async () => {}),
  queryClient: {},
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mocks.queryClient }));
vi.mock('../../../lib/graphql/hooks', () => ({ useProfile: () => ({ data: { id: 'viewer' } }) }));
vi.mock('../../../lib/graphql/hooks/use-privacy', () => ({ usePrivacySettings: () => ({ data: mocks.privacy }) }));
vi.mock('../../../lib/graphql/ws-client', () => ({ getWsClient: () => ({ subscribe: mocks.subscribe }) }));
vi.mock('../../../lib/privacy/privacy-cache', () => ({
  invalidatePrivacyQueries: mocks.invalidate,
  registerPrivacyRevalidation: vi.fn(() => vi.fn()),
}));
vi.mock('../../../lib/spray/spray-privacy-cleanup', () => ({ clearSprayWallPrivateCaches: vi.fn() }));
vi.mock('../../../lib/spray/spray-photo-store', () => ({ clearStoredSprayPhotos: vi.fn() }));
vi.mock('../../../offline/privacy-revalidation', () => ({ revalidatePrivateCatalog: vi.fn() }));
vi.mock('../../../db', () => ({ getDatabaseHandle: () => null }));
vi.mock('../../../settings', () => ({ getSetting: () => [] }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
import { PrivacySyncBridge } from '../PrivacySyncBridge';

describe('privacy revocation subscription', () => {
  it('stays subscribed when controls are disabled and capability cache is cleared', async () => {
    const view = render(<PrivacySyncBridge />);
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
    mocks.privacy = undefined;
    view.rerender(<PrivacySyncBridge />);
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    const callbacks = mocks.subscribe.mock.calls[0][1] as { next: () => void };
    callbacks.next();
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });
});
