import { describe, expect, it, vi } from 'vitest';
import { createBrowserBackendHttpViewRegistry, type BrowserHttpView } from '../browser-backend-http-view';

function fixture() {
  let owner = 'A';
  let revision = 0;
  let kind: BrowserHttpView['kind'] = 'selected';
  const transports: { dispose: ReturnType<typeof vi.fn>; valid: boolean }[] = [];
  const capture = vi.fn(() => {
    const original = { owner, revision, kind };
    return {
      key: `${owner}:${revision}`,
      kind,
      isCurrent: () => original.owner === owner && original.revision === revision && original.kind === kind,
    };
  });
  const create = vi.fn((view: BrowserHttpView) => {
    const transport = { dispose: vi.fn(), valid: true };
    transports.push(transport);
    const client = { request: vi.fn(async () => view.key) };
    const result = Object.freeze({ original: view.key });
    return {
      client,
      isCurrent: () => transport.valid,
      isCurrentResult: (candidate: unknown) => candidate === result,
      dispose: transport.dispose,
      result,
    };
  });
  const registry = createBrowserBackendHttpViewRegistry({ namespace: 'owned-process', capture, create });
  return {
    registry,
    capture,
    create,
    transports,
    switch(ownerName: string) {
      owner = ownerName;
      revision++;
    },
    setKind(next: BrowserHttpView['kind']) {
      kind = next;
    },
  };
}
describe('opaque process-local HTTP view labels', () => {
  it('uses a stable noncredential handle without exposing the private view key or acquiring network credentials', () => {
    const current = fixture();
    const first = current.registry.capture();
    expect(first).toBe('bshv1_owned-process_1');
    expect(first).not.toContain('A:0');
    expect(current.registry.capture()).toBe(first);
    expect(current.create).toHaveBeenCalledTimes(1);
    const client = current.registry.resolve(first);
    expect(client.request).not.toHaveBeenCalled();
  });
  it.each(['bshv1_unknown', 'bshv1_owned-process_0', 'bsbd1_ACTUALLOOKINGTOKEN', 'legacy-token', ''])(
    'an unknown or invented %s never falls back to the current client or becomes a bearer',
    (handle) => {
      const current = fixture();
      current.registry.capture();
      expect(() => current.registry.resolve(handle)).toThrow();
      expect(current.registry.isCurrent(handle)).toBe(false);
      expect(current.create).toHaveBeenCalledTimes(1);
    },
  );
  it('account switches and A-to-B-to-A cannot resurrect the original label', () => {
    const current = fixture();
    const first = current.registry.capture();
    current.switch('B');
    const second = current.registry.capture();
    current.switch('A');
    const third = current.registry.capture();
    expect(new Set([first, second, third]).size).toBe(3);
    expect(() => current.registry.resolve(first)).toThrow();
    expect(() => current.registry.resolve(second)).toThrow();
    expect(current.registry.isCurrent(third)).toBe(true);
    expect(current.transports[0].dispose).toHaveBeenCalledTimes(1);
  });
  it('an independently retired transport cannot remain usable through a live-looking metadata key', () => {
    const current = fixture();
    const old = current.registry.capture();
    current.transports[0].valid = false;
    const replacement = current.registry.capture();
    expect(replacement).not.toBe(old);
    expect(() => current.registry.resolve(old)).toThrow();
    expect(current.registry.isCurrent(replacement)).toBe(true);
  });
  it('retirement clears all prior handles without pretending that they were anonymous', () => {
    const current = fixture();
    const old = current.registry.capture();
    current.registry.clear();
    expect(() => current.registry.kind(old)).toThrow();
    expect(current.registry.capture()).not.toBe(old);
  });
  it('closed registries never recover a prior handle or create another client', () => {
    const current = fixture();
    const old = current.registry.capture();
    current.registry.dispose();
    current.registry.dispose();
    expect(() => current.registry.resolve(old)).toThrow();
    expect(() => current.registry.capture()).toThrow();
    expect(current.create).toHaveBeenCalledTimes(1);
    expect(current.transports[0].dispose).toHaveBeenCalledTimes(1);
  });
  it('kind changes cannot make an authenticated view label anonymous', () => {
    const current = fixture();
    const old = current.registry.capture();
    current.setKind('anonymous');
    const anonymous = current.registry.capture();
    expect(current.registry.kind(anonymous)).toBe('anonymous');
    expect(() => current.registry.kind(old)).toThrow();
  });
  it('result checks require the original object and its original still-current view', () => {
    const current = fixture();
    const handle = current.registry.capture();
    const original = current.create.mock.results[0].value.result;
    expect(current.registry.isCurrentResult(handle, original)).toBe(true);
    // Older injected transports have no immutable-capture contract. Their
    // metadata-only positive cannot qualify the new operation API.
    expect(current.registry.captureResult(handle, original)).toBeNull();
    expect(current.registry.isCurrentResult(handle, { ...original })).toBe(false);
    current.switch('B');
    expect(current.registry.isCurrentResult(handle, original)).toBe(false);
  });
  it('a bounded registry prunes old labels without ever reusing them', () => {
    let key = 0;
    const dispose = vi.fn();
    const registry = createBrowserBackendHttpViewRegistry({
      namespace: 'bounded',
      capture: () => ({ key: String(++key), kind: 'selected', isCurrent: () => true }),
      create: () => ({ client: {}, isCurrent: () => true, isCurrentResult: () => true, dispose }),
    });
    const handles = Array.from({ length: 65 }, () => registry.capture());
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(() => registry.resolve(handles[0])).toThrow();
    expect(registry.isCurrent(handles[64])).toBe(true);
    expect(new Set(handles).size).toBe(65);
    registry.dispose();
  });
  it('capture drift while creating a transport refuses it instead of registering the new account', () => {
    const current = fixture();
    current.create.mockImplementationOnce(() => {
      current.switch('B');
      return {
        client: { request: vi.fn() },
        isCurrent: () => true,
        isCurrentResult: () => true,
        dispose: vi.fn(),
        result: { original: 'forged' },
      };
    });
    expect(() => current.registry.capture()).toThrow();
    expect(() => current.registry.resolve('bshv1_owned-process_1')).toThrow();
  });
});
