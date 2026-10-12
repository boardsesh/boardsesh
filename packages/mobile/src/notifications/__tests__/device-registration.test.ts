import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  credentials: { generation: 1, bearer: 'account-one' as string | null },
  getAuthToken: vi.fn(),
  getPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  getExpoToken: vi.fn(),
  createChannel: vi.fn(),
  getStored: vi.fn(),
  setStored: vi.fn(),
  transport: vi.fn(),
}));

vi.mock('expo-notifications', () => ({
  getPermissionsAsync: mocks.getPermissions,
  requestPermissionsAsync: mocks.requestPermissions,
  getExpoPushTokenAsync: mocks.getExpoToken,
  setNotificationChannelAsync: mocks.createChannel,
  AndroidImportance: { DEFAULT: 3 },
}));
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { eas: { projectId: 'test-project' } } } } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: mocks.getStored, setItemAsync: mocks.setStored }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'installation-created' }));
vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => mocks.credentials.generation,
  getAuthToken: mocks.getAuthToken,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === mocks.credentials.generation,
}));
vi.mock('../../lib/graphql/client', () => ({ getGraphQLHttpUrl: () => 'https://backend.example/graphql' }));
vi.mock('../../lib/client-identity', () => ({
  clientIdentityHeaders: () => ({ 'x-boardsesh-client': 'boardsesh-mobile/2.6.0 (ios; build 45)' }),
}));
vi.mock('../../lib/i18n/config', () => ({ default: { language: 'fr' } }));

function sentRequest(index = 0) {
  const request = mocks.transport.mock.calls[index][1] as RequestInit;
  return {
    headers: request.headers,
    body: JSON.parse(request.body as string) as { query: string; variables: Record<string, unknown> },
  };
}

describe('account notification device registration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.platform.OS = 'ios';
    mocks.credentials.generation = 1;
    mocks.credentials.bearer = 'account-one';
    mocks.getAuthToken.mockImplementation(async () => mocks.credentials.bearer);
    mocks.getPermissions.mockResolvedValue({ status: 'granted' });
    mocks.requestPermissions.mockResolvedValue({ status: 'granted' });
    mocks.getExpoToken.mockResolvedValue({ data: 'ExpoPushToken[test]' });
    mocks.getStored.mockResolvedValue('installation-persisted');
    mocks.createChannel.mockResolvedValue(undefined);
    mocks.transport.mockResolvedValue({ ok: true, json: async () => ({ data: { registerNotificationDevice: true } }) });
    vi.stubGlobal('fetch', mocks.transport);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('registers an Expo token with the captured account, installation, and locale', async () => {
    const { registerNotificationDevice } = await import('../device-registration');
    await expect(registerNotificationDevice()).resolves.toBe(true);
    expect(mocks.getExpoToken).toHaveBeenCalledWith({ projectId: 'test-project' });
    expect(sentRequest()).toMatchObject({
      headers: { Authorization: 'Bearer account-one', 'x-boardsesh-client': 'boardsesh-mobile/2.6.0 (ios; build 45)' },
      body: {
        variables: {
          input: {
            installationId: 'installation-persisted',
            token: 'ExpoPushToken[test]',
            locale: 'fr',
            platform: 'ios',
          },
        },
      },
    });
    expect(mocks.requestPermissions).not.toHaveBeenCalled();
  });

  it('does not prompt at launch and denial does not reject importing', async () => {
    mocks.getPermissions.mockResolvedValue({ status: 'denied' });
    const { registerNotificationDevice } = await import('../device-registration');
    await expect(registerNotificationDevice()).resolves.toBe(false);
    expect(mocks.requestPermissions).not.toHaveBeenCalled();
    expect(mocks.getExpoToken).not.toHaveBeenCalled();
    expect(
      mocks.transport.mock.calls.some((call) => {
        const body = (call[1] as RequestInit).body;
        return typeof body === 'string' && body.includes('RegisterNotificationDevice(');
      }),
    ).toBe(false);
  });

  it('reports no push when the token lookup fails (a binary without push credentials)', async () => {
    mocks.getExpoToken.mockRejectedValue(new Error('no FCM config'));
    const { registerNotificationDevice } = await import('../device-registration');
    await expect(registerNotificationDevice(true)).resolves.toBe(false);
  });

  it('shares the five-minute throttle when permission is already granted', async () => {
    const { registerNotificationDevice } = await import('../device-registration');
    await expect(registerNotificationDevice(true)).resolves.toBe(true);
    await expect(registerNotificationDevice(true)).resolves.toBe(true);
    expect(mocks.getExpoToken).toHaveBeenCalledTimes(1);
    expect(mocks.requestPermissions).not.toHaveBeenCalled();
    await expect(registerNotificationDevice(true, true)).resolves.toBe(true);
    expect(mocks.getExpoToken).toHaveBeenCalledTimes(2);
  });

  it('coalesces simultaneous launch and foreground registration before native work', async () => {
    const { registerNotificationDevice } = await import('../device-registration');
    await expect(Promise.all([registerNotificationDevice(), registerNotificationDevice()])).resolves.toEqual([
      true,
      true,
    ]);
    expect(mocks.getPermissions).toHaveBeenCalledOnce();
    expect(mocks.getExpoToken).toHaveBeenCalledOnce();
    expect(mocks.transport).toHaveBeenCalledOnce();
  });

  it('breaks native token listener recursion and registers once during launch', async () => {
    const { registerNotificationDevice } = await import('../device-registration');
    const devicePushToken = { type: 'ios' as const, data: 'native-token' };
    const nativeLookup = vi.fn();
    const listenerRegistrations: Promise<boolean>[] = [];
    mocks.getExpoToken.mockImplementation(async (options: { devicePushToken?: typeof devicePushToken }) => {
      // Expo's default native lookup emits the same synchronous event on iOS.
      if (!options.devicePushToken) {
        nativeLookup();
        if (nativeLookup.mock.calls.length > 3) throw new Error('recursive native token lookup');
        listenerRegistrations.push(registerNotificationDevice(false, true, devicePushToken));
      }
      return { data: 'ExpoPushToken[test]' };
    });
    await expect(registerNotificationDevice()).resolves.toBe(true);
    await expect(Promise.all(listenerRegistrations)).resolves.toEqual([true]);
    expect(nativeLookup).toHaveBeenCalledOnce();
    expect(mocks.getExpoToken).toHaveBeenCalledTimes(2);
    expect(mocks.transport).toHaveBeenCalledOnce();
    await expect(registerNotificationDevice(false, true, devicePushToken)).resolves.toBe(true);
    expect(mocks.getExpoToken).toHaveBeenCalledTimes(2);
  });

  it('coalesces launch registration when the listener token exchange finishes first', async () => {
    const { registerNotificationDevice } = await import('../device-registration');
    const devicePushToken = { type: 'ios' as const, data: 'native-token' };
    let resolveLaunch!: (token: { data: string }) => void;
    mocks.getExpoToken.mockImplementation((options: { devicePushToken?: typeof devicePushToken }) => {
      if (options.devicePushToken) return Promise.resolve({ data: 'ExpoPushToken[test]' });
      return new Promise<{ data: string }>((resolve) => {
        resolveLaunch = resolve;
      });
    });
    const launching = registerNotificationDevice();
    await vi.waitFor(() => expect(mocks.getExpoToken).toHaveBeenCalledOnce());
    await expect(registerNotificationDevice(false, true, devicePushToken)).resolves.toBe(true);
    resolveLaunch({ data: 'ExpoPushToken[test]' });
    await expect(launching).resolves.toBe(true);
    expect(mocks.transport).toHaveBeenCalledOnce();
    await registerNotificationDevice(false, true, devicePushToken);
    expect(mocks.getExpoToken).toHaveBeenCalledTimes(2);
  });

  it('coalesces duplicate native events while preserving real token rotation', async () => {
    const { registerNotificationDevice } = await import('../device-registration');
    const originalToken = { type: 'ios' as const, data: 'original-native-token' };
    await Promise.all([
      registerNotificationDevice(false, true, originalToken),
      registerNotificationDevice(false, true, originalToken),
    ]);
    await registerNotificationDevice(false, true, originalToken);
    expect(mocks.getExpoToken).toHaveBeenCalledOnce();
    expect(mocks.transport).toHaveBeenCalledOnce();
    const rotatedToken = { type: 'ios' as const, data: 'rotated-native-token' };
    mocks.getExpoToken.mockResolvedValue({ data: 'ExpoPushToken[rotated]' });
    await expect(registerNotificationDevice(false, true, rotatedToken)).resolves.toBe(true);
    expect(mocks.getExpoToken).toHaveBeenLastCalledWith({ projectId: 'test-project', devicePushToken: rotatedToken });
    expect(mocks.transport).toHaveBeenCalledTimes(2);
    expect(sentRequest(1).body.variables).toMatchObject({ input: { token: 'ExpoPushToken[rotated]' } });
  });

  it('does not let a delayed launch lookup overwrite a newer listener registration', async () => {
    const { registerNotificationDevice } = await import('../device-registration');
    let resolveLaunch!: (token: { data: string }) => void;
    mocks.getExpoToken.mockImplementation((options: { devicePushToken?: { data: string } }) => {
      if (options.devicePushToken) return Promise.resolve({ data: 'ExpoPushToken[new]' });
      return new Promise<{ data: string }>((resolve) => {
        resolveLaunch = resolve;
      });
    });
    const launching = registerNotificationDevice();
    await vi.waitFor(() => expect(mocks.getExpoToken).toHaveBeenCalledOnce());
    const newerToken = { type: 'ios' as const, data: 'new-native-token' };
    await expect(registerNotificationDevice(false, true, newerToken)).resolves.toBe(true);
    resolveLaunch({ data: 'ExpoPushToken[old]' });
    await expect(launching).resolves.toBe(false);
    await expect(registerNotificationDevice(false, true, newerToken)).resolves.toBe(true);
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(sentRequest().body.variables).toMatchObject({ input: { token: 'ExpoPushToken[new]' } });
  });

  it('preserves native event order when the newer credential read resolves first', async () => {
    const { registerNotificationDevice } = await import('../device-registration');
    let resolveOlderCredentials!: (bearer: string) => void;
    mocks.getAuthToken.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveOlderCredentials = resolve;
        }),
    );
    const olderRegistration = registerNotificationDevice(false, true, { type: 'ios', data: 'old-native-token' });
    const newerToken = { type: 'ios' as const, data: 'new-native-token' };
    mocks.getExpoToken.mockResolvedValue({ data: 'ExpoPushToken[new]' });
    await expect(registerNotificationDevice(false, true, newerToken)).resolves.toBe(true);
    resolveOlderCredentials('account-one');
    await expect(olderRegistration).resolves.toBe(false);
    expect(mocks.getExpoToken).toHaveBeenCalledOnce();
    expect(mocks.getExpoToken).toHaveBeenCalledWith({ projectId: 'test-project', devicePushToken: newerToken });
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(sentRequest().body.variables).toMatchObject({ input: { token: 'ExpoPushToken[new]' } });
    await expect(registerNotificationDevice(false, true, newerToken)).resolves.toBe(true);
    expect(mocks.getExpoToken).toHaveBeenCalledOnce();
  });

  it('still deduplicates identical events when their credential reads resolve out of order', async () => {
    const { registerNotificationDevice } = await import('../device-registration');
    let resolveFirstCredentials!: (bearer: string) => void;
    mocks.getAuthToken.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFirstCredentials = resolve;
        }),
    );
    const devicePushToken = { type: 'ios' as const, data: 'same-native-token' };
    const firstRegistration = registerNotificationDevice(false, true, devicePushToken);
    await expect(registerNotificationDevice(false, true, devicePushToken)).resolves.toBe(true);
    resolveFirstCredentials('account-one');
    await expect(firstRegistration).resolves.toBe(true);
    expect(mocks.getExpoToken).toHaveBeenCalledOnce();
    expect(mocks.transport).toHaveBeenCalledOnce();
  });

  it('does not overwrite a newer native token with a delayed older exchange', async () => {
    const { registerNotificationDevice } = await import('../device-registration');
    let resolveOld!: (token: { data: string }) => void;
    mocks.getExpoToken.mockImplementation((options: { devicePushToken: { data: string } }) => {
      if (options.devicePushToken.data === 'old-native-token') {
        return new Promise<{ data: string }>((resolve) => {
          resolveOld = resolve;
        });
      }
      return Promise.resolve({ data: 'ExpoPushToken[new]' });
    });
    const olderRegistration = registerNotificationDevice(false, true, { type: 'ios', data: 'old-native-token' });
    await vi.waitFor(() => expect(mocks.getExpoToken).toHaveBeenCalledOnce());
    const newerToken = { type: 'ios' as const, data: 'new-native-token' };
    await expect(registerNotificationDevice(false, true, newerToken)).resolves.toBe(true);
    resolveOld({ data: 'ExpoPushToken[old]' });
    await expect(olderRegistration).resolves.toBe(false);
    await expect(registerNotificationDevice(false, true, newerToken)).resolves.toBe(true);
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(sentRequest().body.variables).toMatchObject({ input: { token: 'ExpoPushToken[new]' } });
  });

  it('retries a native token event after failed backend registration', async () => {
    const { registerNotificationDevice } = await import('../device-registration');
    const devicePushToken = { type: 'ios' as const, data: 'native-token' };
    mocks.transport.mockRejectedValueOnce(new Error('offline'));
    await expect(registerNotificationDevice(false, true, devicePushToken)).resolves.toBe(false);
    await expect(registerNotificationDevice(false, true, devicePushToken)).resolves.toBe(true);
    expect(mocks.getExpoToken).toHaveBeenCalledTimes(2);
    expect(mocks.transport).toHaveBeenCalledTimes(2);
  });

  it('creates the Android channel before explicitly requesting permission', async () => {
    mocks.platform.OS = 'android';
    mocks.getPermissions.mockResolvedValue({ status: 'undetermined' });
    const { registerNotificationDevice } = await import('../device-registration');
    await registerNotificationDevice(true);
    expect(mocks.requestPermissions).toHaveBeenCalledOnce();
    expect(mocks.createChannel.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.requestPermissions.mock.invocationCallOrder[0],
    );
    expect(mocks.transport).toHaveBeenCalledOnce();
  });

  it('retires a persisted device when permission was revoked while the app was closed', async () => {
    mocks.getPermissions.mockResolvedValue({ status: 'denied' });
    const { registerNotificationDevice } = await import('../device-registration');
    await registerNotificationDevice();
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(sentRequest().body.query).toContain('UnregisterNotificationDevice');
    expect(mocks.getExpoToken).not.toHaveBeenCalled();
  });

  it('fences a token response arriving after an account switch', async () => {
    let resolveToken!: (token: { data: string }) => void;
    mocks.getExpoToken.mockReturnValue(
      new Promise<{ data: string }>((resolve) => {
        resolveToken = resolve;
      }),
    );
    const { registerNotificationDevice } = await import('../device-registration');
    const registering = registerNotificationDevice(true);
    await vi.waitFor(() => expect(mocks.getExpoToken).toHaveBeenCalledOnce());
    mocks.credentials.generation = 2;
    mocks.credentials.bearer = 'account-two';
    resolveToken({ data: 'ExpoPushToken[old-account]' });
    await registering;
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it('unregisters a persisted installation after a cold launch before registration', async () => {
    const { deactivateNotificationDevice } = await import('../device-registration');
    await deactivateNotificationDevice();
    expect(sentRequest()).toMatchObject({
      headers: { Authorization: 'Bearer account-one' },
      body: { variables: { installationId: 'installation-persisted' } },
    });
    expect(sentRequest().body.query).toContain('UnregisterNotificationDevice');
  });

  it('does not unregister a newer account when cold-launch installation lookup is delayed', async () => {
    let resolveInstallation!: (installation: string) => void;
    mocks.getStored.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveInstallation = resolve;
      }),
    );
    const { deactivateNotificationDevice } = await import('../device-registration');
    const deactivating = deactivateNotificationDevice();
    await vi.waitFor(() => expect(mocks.getStored).toHaveBeenCalledOnce());
    mocks.credentials.generation = 2;
    mocks.credentials.bearer = 'account-two';
    resolveInstallation('installation-persisted');
    await deactivating;
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it('uses the old registration bearer during logout and contains network failures', async () => {
    const { registerNotificationDevice, deactivateNotificationDevice } = await import('../device-registration');
    await registerNotificationDevice();
    mocks.credentials.bearer = null;
    mocks.transport.mockRejectedValueOnce(new Error('offline'));
    await expect(deactivateNotificationDevice()).resolves.toBeUndefined();
    expect(sentRequest(1).headers).toMatchObject({ Authorization: 'Bearer account-one' });
  });
});
