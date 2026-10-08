// @vitest-environment jsdom
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { PRIVACY_REVOKED_EVENT, revokeWebPrivacySnapshots } from '../privacy-client';

describe('website privacy revocation', () => {
  it('withdraws SSR data and local drawers without resetting transport credentials', async () => {
    const client = new QueryClient();
    const listener = vi.fn();
    window.addEventListener(PRIVACY_REVOKED_EVENT, listener);
    client.setQueryData(['wsAuthToken', 'authenticated'], { token: 'current-token' });
    const observer = new QueryObserver(client, {
      queryKey: ['userProfile', 'private-user'],
      initialData: { name: 'Previously visible' },
      enabled: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    await revokeWebPrivacySnapshots(client);
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(client.getQueryData(['wsAuthToken', 'authenticated'])).toEqual({ token: 'current-token' });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    window.removeEventListener(PRIVACY_REVOKED_EVENT, listener);
    client.clear();
  });
  it('does not restore an old response after cancellation', async () => {
    const client = new QueryClient();
    let resolve!: (response: string[]) => void;
    const request = client
      .fetchQuery({
        queryKey: ['followers', 'private-user'],
        queryFn: () =>
          new Promise<string[]>((done) => {
            resolve = done;
          }),
      })
      .catch(() => undefined);
    await revokeWebPrivacySnapshots(client);
    resolve(['Withdrawn name']);
    await request;
    expect(client.getQueryData(['followers', 'private-user'])).toBeUndefined();
    client.clear();
  });
});
