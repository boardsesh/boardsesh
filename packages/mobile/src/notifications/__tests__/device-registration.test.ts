import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  credentials: { generation: 1, bearer: 'account-one' as string | null },
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
  getAuthToken: async () => mocks.credentials.bearer,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === mocks.credentials.generation,
}));
vi.mock('../../lib/graphql/client', () => ({ getGraphQLHttpUrl: () => 'https://backend.example/graphql' }));
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
    await registerNotificationDevice();
    expect(mocks.getExpoToken).toHaveBeenCalledWith({ projectId: 'test-project' });
    expect(sentRequest()).toMatchObject({
      headers: { Authorization: 'Bearer account-one' },
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
    await expect(registerNotificationDevice()).resolves.toBeUndefined();
    expect(mocks.requestPermissions).not.toHaveBeenCalled();
    expect(mocks.getExpoToken).not.toHaveBeenCalled();
    expect(
      mocks.transport.mock.calls.some((call) => {
        const body = (call[1] as RequestInit).body;
        return typeof body === 'string' && body.includes('RegisterNotificationDevice(');
      }),
    ).toBe(false);
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
