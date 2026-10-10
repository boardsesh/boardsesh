import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  configure: vi.fn(),
  dispatchEvents: vi.fn(async () => undefined),
  reportError: vi.fn(),
}));
const manifest = vi.hoisted(() => ({ endpointUrl: undefined as unknown }));
vi.mock('expo-observe', () => ({ Observe: sdk }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { eas: { observe: manifest } } } } }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  manifest.endpointUrl = undefined;
});

describe('Observe public SDK bootstrap', () => {
  it('initializes stable router metrics before dispatch flags are known', async () => {
    manifest.endpointUrl = 'https://ota.boardsesh.com/observe/app-id';
    await import('../observe-bootstrap');
    expect(sdk.configure).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchingEnabled: false, sampleRate: 1, dispatchInDebug: false }),
    );
    const { configureObserve, dispatchObserveEvents, captureToObserve } = await import('../observe-runtime');
    configureObserve({ dispatchingEnabled: true, sampleRate: 0.25 });
    await dispatchObserveEvents();
    const error = new Error('diagnostic');
    captureToObserve(error);
    expect(sdk.configure).toHaveBeenLastCalledWith(
      expect.objectContaining({ dispatchingEnabled: true, sampleRate: 0.25 }),
    );
    expect(sdk.dispatchEvents).toHaveBeenCalledOnce();
    expect(sdk.reportError).toHaveBeenCalledWith(error);
  });

  it.each([undefined, 'invalid', 'https://o.expo.dev/observe/app-id'])(
    'prevents Expo fallback for endpoint %s',
    async (endpointUrl) => {
      manifest.endpointUrl = endpointUrl;
      await import('../observe-bootstrap');
      const { configureObserve, dispatchObserveEvents, captureToObserve } = await import('../observe-runtime');
      configureObserve({ dispatchingEnabled: true, sampleRate: 1 });
      await dispatchObserveEvents();
      captureToObserve(new Error('not first-party'));
      expect(sdk.configure).toHaveBeenLastCalledWith(
        expect.objectContaining({ dispatchingEnabled: false, sampleRate: 1 }),
      );
      expect(sdk.dispatchEvents).not.toHaveBeenCalled();
      expect(sdk.reportError).not.toHaveBeenCalled();
    },
  );
});
