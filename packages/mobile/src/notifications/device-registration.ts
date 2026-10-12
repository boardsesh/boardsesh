import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import { Platform } from 'react-native';
import { isSupportedLocale } from '@boardsesh/i18n';
import { captureAuthCredentialGeneration, getAuthToken, isAuthCredentialGenerationCurrent } from '../lib/auth-store';
import { clientIdentityHeaders } from '../lib/client-identity';
import { getGraphQLHttpUrl } from '../lib/graphql/client';
import i18n from '../lib/i18n/config';

const INSTALLATION_KEY = 'boardsesh_notification_installation';
const REGISTER =
  'mutation RegisterNotificationDevice($input: RegisterNotificationDeviceInput!) { registerNotificationDevice(input: $input) }';
const UNREGISTER =
  'mutation UnregisterNotificationDevice($installationId: String!) { unregisterNotificationDevice(installationId: $installationId) }';
let operations: Promise<void> = Promise.resolve();
let registration: {
  bearer: string;
  installationId: string;
  locale: string;
  token: string;
  deviceToken?: string;
  registeredAt: number;
} | null = null;
const registrationRequests = new Map<string, Promise<boolean>>();
let lifecycleEpoch = 0;
let nativeTokenRevision = 0;
let latestNativeToken: { context: string; token: string } | null = null;

async function installationId(): Promise<string> {
  const stored = await SecureStore.getItemAsync(INSTALLATION_KEY);
  if (stored) return stored;
  const created = randomUUID();
  await SecureStore.setItemAsync(INSTALLATION_KEY, created);
  return created;
}

async function requestDevice(query: string, variables: Record<string, unknown>, bearer: string): Promise<void> {
  // Raw fetch, not authenticatedFetch, so the client identity header is added
  // by hand. Capture this account's bearer. The normal interceptor can switch accounts
  // while a permission prompt or token lookup is awaiting a native response.
  const response = await fetch(getGraphQLHttpUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, ...clientIdentityHeaders() },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8000),
  });
  const payload: unknown = await response.json();
  if (!response.ok || !payload || typeof payload !== 'object' || ('errors' in payload && payload.errors)) {
    throw new Error('NOTIFICATION_DEVICE_REGISTRATION_FAILED');
  }
}

/**
 * Permission is requested only when starting recognition, never on launch.
 * Resolves true when this device is registered for pushes to the signed-in
 * account (just now, or within the last five minutes).
 */
export async function registerNotificationDevice(
  requestPermission = false,
  force = false,
  devicePushToken?: Notifications.DevicePushToken,
): Promise<boolean> {
  if (!Device.isDevice || (Platform.OS !== 'ios' && Platform.OS !== 'android')) return false;
  const generation = captureAuthCredentialGeneration();
  const epoch = lifecycleEpoch;
  try {
    // Record native event order before credential storage can resolve out of order.
    let tokenRevision = nativeTokenRevision;
    if (devicePushToken) {
      const context = JSON.stringify([generation, epoch]);
      const token = JSON.stringify(devicePushToken);
      if (latestNativeToken?.context !== context || latestNativeToken.token !== token) {
        latestNativeToken = { context, token };
        nativeTokenRevision++;
      }
      tokenRevision = nativeTokenRevision;
    }
    const bearer = await getAuthToken();
    if (
      !bearer ||
      epoch !== lifecycleEpoch ||
      !isAuthCredentialGenerationCurrent(generation) ||
      (devicePushToken && tokenRevision !== nativeTokenRevision)
    )
      return false;
    const locale = isSupportedLocale(i18n.language) ? i18n.language : 'en-US';
    const requestKey = JSON.stringify([
      generation,
      epoch,
      bearer,
      locale,
      requestPermission,
      force,
      devicePushToken,
      devicePushToken ? tokenRevision : undefined,
    ]);
    const pending = registrationRequests.get(requestKey);
    if (pending) return await pending;
    const request = performRegistration(
      bearer,
      locale,
      generation,
      epoch,
      requestPermission,
      force,
      devicePushToken,
      tokenRevision,
    );
    registrationRequests.set(requestKey, request);
    try {
      return await request;
    } finally {
      if (registrationRequests.get(requestKey) === request) registrationRequests.delete(requestKey);
    }
  } catch {
    return false;
  }
}

async function performRegistration(
  bearer: string,
  locale: string,
  generation: ReturnType<typeof captureAuthCredentialGeneration>,
  epoch: number,
  requestPermission: boolean,
  force: boolean,
  devicePushToken?: Notifications.DevicePushToken,
  tokenRevision: number = nativeTokenRevision,
): Promise<boolean> {
  try {
    const deviceToken = devicePushToken ? JSON.stringify(devicePushToken) : undefined;
    // Permission is granted by now, so asking again (each detection step mount)
    // shares the throttle instead of re-registering and re-running catch-up.
    if (
      (!force || (deviceToken !== undefined && registration?.deviceToken === deviceToken)) &&
      registration?.bearer === bearer &&
      registration.locale === locale &&
      registration.registeredAt > 0 &&
      Date.now() - registration.registeredAt < 300_000
    )
      return true;
    if (Platform.OS === 'android')
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Boardsesh',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    const permission = await Notifications.getPermissionsAsync();
    const status =
      permission.status === 'granted' || !requestPermission
        ? permission.status
        : (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') {
      if (epoch === lifecycleEpoch && isAuthCredentialGenerationCurrent(generation))
        await deactivateNotificationDevice();
      return false;
    }
    // Permission is granted by now, so asking again (each detection step mount)
    // shares the throttle instead of re-registering and re-running catch-up.
    if (
      (!force || (deviceToken !== undefined && registration?.deviceToken === deviceToken)) &&
      registration?.bearer === bearer &&
      registration.locale === locale &&
      registration.registeredAt > 0 &&
      Date.now() - registration.registeredAt < 300_000
    )
      return true;
    if (epoch !== lifecycleEpoch || !isAuthCredentialGenerationCurrent(generation)) return false;
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (typeof projectId !== 'string') return false;
    // Supplying the listener's native token avoids another native lookup, which
    // emits another token event on iOS and recursively triggers registration.
    const token = (
      await Notifications.getExpoPushTokenAsync({ projectId, ...(devicePushToken ? { devicePushToken } : {}) })
    ).data;
    // Native events can rotate while an older Expo exchange is in flight.
    // A launch lookup may complete alongside its own event; allow matching tokens.
    const isCurrentRegistration = () =>
      !(
        epoch !== lifecycleEpoch ||
        !isAuthCredentialGenerationCurrent(generation) ||
        (devicePushToken && tokenRevision !== nativeTokenRevision) ||
        (!devicePushToken &&
          tokenRevision !== nativeTokenRevision &&
          registration?.bearer === bearer &&
          registration.registeredAt > 0 &&
          registration.token !== token)
      );
    let registered = false;
    operations = operations
      .catch(() => {})
      .then(async () => {
        if (!isCurrentRegistration()) return;
        const deviceId = await installationId();
        if (!isCurrentRegistration()) return;
        if (
          (!force || devicePushToken) &&
          registration?.bearer === bearer &&
          registration.locale === locale &&
          registration.token === token &&
          registration.registeredAt > 0 &&
          Date.now() - registration.registeredAt < 300_000
        ) {
          registration.deviceToken = deviceToken ?? registration.deviceToken;
          registered = true;
          return;
        }
        const previousDeviceToken = registration?.token === token ? registration.deviceToken : undefined;
        registration = {
          bearer,
          installationId: deviceId,
          locale,
          token,
          deviceToken: deviceToken ?? previousDeviceToken,
          registeredAt: 0,
        };
        await requestDevice(
          REGISTER,
          { input: { installationId: deviceId, token, platform: Platform.OS, locale } },
          bearer,
        );
        if (!isCurrentRegistration()) return;
        if (registration?.bearer === bearer) registration.registeredAt = Date.now();
        registered = true;
      });
    await operations;
    return registered;
  } catch {
    // Importing and the in-app notification remain available without push.
    return false;
  }
}

/** Deactivate the old account before its credential is cleared or replaced. */
export async function deactivateNotificationDevice(): Promise<void> {
  lifecycleEpoch++;
  const previous = registration;
  registration = null;
  const generation = captureAuthCredentialGeneration();
  const bearer = previous?.bearer ?? (await getAuthToken().catch(() => null));
  const deviceId = previous?.installationId ?? (await SecureStore.getItemAsync(INSTALLATION_KEY).catch(() => null));
  if (!previous && !isAuthCredentialGenerationCurrent(generation)) return;
  operations = operations
    .catch(() => {})
    .then(async () => {
      try {
        if (bearer && deviceId) await requestDevice(UNREGISTER, { installationId: deviceId }, bearer);
      } catch {}
    });
  await operations;
}
