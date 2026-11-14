// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const control = vi.hoisted(() => ({
  ready: true,
  origin: 'https://www.coordinator-fixture.example.test',
  closed: false,
  renew: vi.fn<(signal?: AbortSignal) => Promise<unknown>>(),
  create: vi.fn(),
}));
vi.mock('../browser-consumer-readiness.web', () => ({ publicExpoBrowserConsumersReady: () => control.ready }));
vi.mock('../env', () => ({
  get WEB_BASE_URL() {
    return control.origin;
  },
}));
vi.mock('@boardsesh/auth-protocol/browser-coordinator-dom', () => ({
  createCanonicalBrowserCoordinatorFrame: control.create,
}));
let coordinate: (typeof import('../browser-coordinator-client.web'))['coordinateExpoBrowserSession'];
beforeEach(async () => {
  vi.resetModules();
  control.ready = true;
  control.closed = false;
  control.origin = 'https://www.coordinator-fixture.example.test';
  control.renew.mockReset().mockResolvedValue({ status: 'ready', cursor: { bindingId: 'a'.repeat(64), version: 3 } });
  control.create.mockReset().mockImplementation(() => ({ isClosed: () => control.closed, renew: control.renew }));
  coordinate = (await import('../browser-coordinator-client.web')).coordinateExpoBrowserSession;
});
afterEach(() => vi.unstubAllEnvs());
describe('Expo canonical frame coordination', () => {
  it('uses only configured HTTPS origin and returns no identity or credential from metadata', async () => {
    const signal = new AbortController().signal;
    expect(await coordinate(signal)).toBeUndefined();
    expect(await coordinate(signal)).toBeUndefined();
    expect(control.create).toHaveBeenCalledExactlyOnceWith({ window, canonicalOrigin: control.origin });
    expect(control.renew).toHaveBeenCalledTimes(2);
    expect(control.renew).toHaveBeenLastCalledWith(signal);
  });
  it.each([
    'http://www.coordinator-fixture.example.test',
    'https://www.coordinator-fixture.example.test/path',
    'https://name:secret@www.coordinator-fixture.example.test',
    'invalid',
  ])('refuses configuration %s without URL inference', async (origin) => {
    control.origin = origin;
    await expect(coordinate(new AbortController().signal)).rejects.toMatchObject({ status: 'unavailable' });
    expect(control.create).not.toHaveBeenCalled();
  });
  it('requires code-owned readiness before creating a frame', async () => {
    control.ready = false;
    await expect(coordinate(new AbortController().signal)).rejects.toMatchObject({ status: 'unavailable' });
    expect(control.create).not.toHaveBeenCalled();
  });
  it.each(['conflict', 'proof-required', 'unavailable'])(
    'retains %s as uncertainty without admitting an account',
    async (status) => {
      control.renew.mockResolvedValue({ status });
      await expect(coordinate(new AbortController().signal)).rejects.toMatchObject({ status: 'unavailable' });
    },
  );
  it.each(['abort', 'readiness'] as const)('refuses stale completion after %s', async (cause) => {
    let complete!: (result: unknown) => void;
    control.renew.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = coordinate(controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ status: 'unavailable' });
    if (cause === 'abort') controller.abort();
    else control.ready = false;
    complete({ status: 'ready', cursor: { bindingId: 'a'.repeat(64), version: 3 } });
    await rejected;
    expect(control.create).toHaveBeenCalledOnce();
  });
  it('rebuilds only a closed frame and refuses authority drift', async () => {
    await coordinate(new AbortController().signal);
    control.closed = true;
    await coordinate(new AbortController().signal);
    expect(control.create).toHaveBeenCalledTimes(2);
    control.origin = 'https://other.example.test';
    await expect(coordinate(new AbortController().signal)).rejects.toMatchObject({ status: 'unavailable' });
    expect(control.create).toHaveBeenCalledTimes(2);
  });
});
