import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpQueryScope } from '../http-query-scope';
import { createScopedHttpFixture } from './fixtures/scoped-http';

vi.mock('../../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));
const disposals: (() => void)[] = [];
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));
function fixture() {
  const http = createScopedHttpFixture();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  disposals.push(() => {
    cache.clear();
    http.dispose();
  });
  return { ...http, cache };
}
const document = '{ viewer { id } }';

describe('captured query identity and original-operation cache effects', () => {
  it('isolates actual cache keys and prefix-wide updates/removal from another account', () => {
    const current = fixture();
    const original = current.scope();
    original.cache(current.cache).setQueryData(['profile'], { id: 'owned-A' });
    original.cache(current.cache).setQueryData(['profile', 'extra'], { id: 'owned-A-extra' });
    current.switchAccount('owned-B');
    const newer = current.scope();
    newer.cache(current.cache).setQueryData(['profile'], { id: 'owned-B' });
    newer.cache(current.cache).setQueriesData({ queryKey: ['profile'] }, { id: 'updated-B' });
    expect(current.cache.getQueryData(original.key(['profile']))).toEqual({ id: 'owned-A' });
    expect(newer.cache(current.cache).getQueryData(['profile'])).toEqual({ id: 'updated-B' });
    expect(current.cache.getQueryData(['profile'])).toBeUndefined();
    expect(JSON.stringify(newer.key(['profile']))).not.toContain('bsbd1_');
    expect(() => original.cache(current.cache).removeQueries()).toThrow();
    newer.cache(current.cache).removeQueries();
    expect(current.cache.getQueryData(original.key(['profile']))).toEqual({ id: 'owned-A' });
    expect(current.cache.getQueryData(newer.key(['profile']))).toBeUndefined();
  });

  it.each(['B', 'ABA', 'generation'] as const)('refuses queued %s intent before a getter or packet', async (change) => {
    const current = fixture();
    const original = current.scope();
    if (change === 'generation') current.nextGeneration();
    else {
      current.switchAccount('owned-B');
      if (change === 'ABA') current.switchAccount('owned-A');
    }
    await expect(original.run((operation) => operation.request(document))).rejects.toMatchObject({
      status: 'superseded',
    });
    expect(current.issueLease).not.toHaveBeenCalled();
    expect(current.performFetch).not.toHaveBeenCalled();
  });

  it('checks the view after an updater before committing its returned data', () => {
    const current = fixture();
    const original = current.scope();
    const cache = original.cache(current.cache);
    cache.setQueryData(['profile'], { id: 'owned-A' });
    expect(() =>
      cache.setQueryData(['profile'], () => {
        current.switchAccount('owned-B');
        return { id: 'forbidden-after-switch' };
      }),
    ).toThrow();
    expect(current.cache.getQueryData(original.key(['profile']))).toEqual({ id: 'owned-A' });
  });

  it('guards a caller predicate before a scoped cache removal can proceed', () => {
    const current = fixture();
    const original = current.scope();
    original.cache(current.cache).setQueryData(['profile'], { id: 'owned-A' });
    expect(() =>
      original.cache(current.cache).removeQueries({
        predicate: () => {
          current.switchAccount('owned-B');
          return true;
        },
      }),
    ).toThrow();
    expect(current.cache.getQueryData(original.key(['profile']))).toEqual({ id: 'owned-A' });
  });

  it('refuses an original decoded delivery after a held cache refresh, despite a newer live lease', async () => {
    const current = fixture();
    const original = current.scope();
    const operation = original.create();
    await operation.request(document);
    let finish!: () => void;
    vi.spyOn(current.cache, 'invalidateQueries').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = operation.cache(current.cache).invalidateQueries({ queryKey: ['profile'] });
    const refused = expect(pending).rejects.toMatchObject({ status: 'superseded' });
    current.clock(90_000);
    await original.create().request(document);
    current.clock(120_001);
    finish();
    await refused;
    expect(() => operation.cache(current.cache).setQueryData(['profile'], 'forbidden')).toThrow();
    expect(current.cache.getQueryData(original.key(['profile']))).toBeUndefined();
  });

  it.each(['cancelQueries', 'invalidateQueries'] as const)(
    'checks after held %s before subsequent effects',
    async (method) => {
      const current = fixture();
      const original = current.scope();
      let finish!: () => void;
      vi.spyOn(current.cache, method).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const pending = original.cache(current.cache)[method]({ queryKey: ['profile'] });
      const refused = expect(pending).rejects.toMatchObject({ status: 'superseded' });
      current.switchAccount('owned-B');
      finish();
      await refused;
    },
  );

  it('returns a guard for the original primitive/derived result through the caller await', async () => {
    const current = fixture();
    const original = current.scope();
    const accepted = await original.run(async (operation) => {
      const response = await operation.request<{ viewer: { id: string } }>(document);
      return response.viewer.id;
    });
    expect(accepted.result).toBe('owned-A');
    accepted.assertCurrent();
    current.switchAccount('owned-B');
    current.switchAccount('owned-A');
    expect(() => accepted.assertCurrent()).toThrow();
  });

  it('keeps native/legacy query keys and cache shape unchanged', () => {
    const cache = new QueryClient();
    disposals.push(() => cache.clear());
    const key = ['profile'] as const;
    const original = createHttpQueryScope({
      scope: undefined,
      scoped: false,
      prefix: ['unused'],
      isCurrentView: () => true,
      createOperation: () => {
        throw new Error('No transport expected');
      },
    });
    expect(original.key(key)).toBe(key);
    original.cache(cache).setQueryData(key, { id: 'native-A' });
    expect(cache.getQueryData(key)).toEqual({ id: 'native-A' });
  });
});
