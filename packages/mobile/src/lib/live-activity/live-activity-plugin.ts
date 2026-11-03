import { Platform } from 'react-native';
import {
  liveActivityNative,
  sessionPresenceNative,
  type LiveActivityStartSessionOptions,
  type LiveActivityUpdateOptions,
  type LiveActivityClimbUpdateOptions,
  type LiveActivityRestTimerOptions,
  type LiveActivityLightingWindowOptions,
  type LiveActivityLightingWindowSnapshot,
  type LiveActivityKeepLightingConfig,
  type LiveActivityLockScreenPress,
  type WidgetQueueNavigateEvent,
  type WidgetMirrorEvent,
  type BoardControlEvent,
  type InterruptedLiveActivityIntentDiagnostic,
} from '../../../modules/live-activity/src/index';

// Platform-agnostic wrapper around the "session presence" native surface:
// iOS ActivityKit (LiveActivity module) or the Android foreground service
// (SessionPresence module). Both modules expose the SAME method names and the
// SAME queueNavigate event shape, so a single Platform-keyed selector routes
// every call. Each platform sees exactly one non-null module; the other is null
// (and so is everything in Expo Go / a preview build predating the modules), in
// which case every method is a safe no-op.
const sessionModule =
  Platform.OS === 'ios' ? liveActivityNative : Platform.OS === 'android' ? sessionPresenceNative : null;

// The on-device notification thumbnail (BoardRenderer overlay + bundled
// backgrounds) is consumed only by the Android foreground service; iOS fetches
// its own via ActivityKit. Exposed so the bridge can skip the render on iOS
// rather than do work whose result iOS discards.
export const isAndroidSessionPresence = Platform.OS === 'android';

export async function isLiveActivityAvailable(): Promise<boolean> {
  if (!sessionModule) return false;
  try {
    const result = await sessionModule.isAvailable();
    return result.available;
  } catch {
    return false;
  }
}

export async function startLiveActivitySession(options: LiveActivityStartSessionOptions): Promise<void> {
  if (!sessionModule) return;
  await sessionModule.startSession(options);
}

export async function endLiveActivitySession(): Promise<void> {
  if (!sessionModule) return;
  await sessionModule.endSession();
}

export async function updateLiveActivity(options: LiveActivityUpdateOptions): Promise<void> {
  if (!sessionModule) return;
  await sessionModule.updateActivity(options);
}

export async function updateLiveActivityClimb(options: LiveActivityClimbUpdateOptions): Promise<void> {
  if (!sessionModule) return;
  await sessionModule.updateActivityClimb(options);
}

/**
 * Whether this binary draws the rest timer outside the app (#6513). False on
 * an older binary running this JS over the air, where the switch for it would
 * do nothing.
 */
export const sessionPresenceSupportsRestTimer = sessionModule?.supportsRestTimer === true;

/**
 * Hands the rest timer (#6513) to the Lock Screen, the Dynamic Island and the
 * Android session notification; `null` takes it off. Optional on both modules,
 * so an OTA bundle on a binary that predates it is a silent no-op, and a
 * native failure never reaches the timer itself.
 */
export async function updateLiveActivityRestTimer(options: LiveActivityRestTimerOptions | null): Promise<void> {
  try {
    await sessionModule?.updateRestTimer?.(options);
  } catch (error) {
    console.warn('[LiveActivity] updateRestTimer failed:', error);
  }
}

/**
 * Whether this binary draws driving the wall (2.7) on the Lock Screen,
 * in the Dynamic Island and in the Android notification. False on an older
 * binary running this JS over the air, where nothing is sent.
 */
export const sessionPresenceSupportsLightingWindow =
  sessionModule?.supportsLightingWindow === true && typeof sessionModule.updateLightingWindow === 'function';

/**
 * Hands this phone's drive (timed, open-ended or none) to the Lock Screen, the Dynamic
 * Island and the Android notification; `null` takes it off. A silent no-op on
 * a binary that predates it, and a native failure never reaches the drive.
 */
export async function updateLiveActivityLightingWindow(
  options: LiveActivityLightingWindowOptions | null,
): Promise<void> {
  if (!sessionPresenceSupportsLightingWindow) return;
  try {
    await sessionModule?.updateLightingWindow?.(options);
  } catch (error) {
    console.warn('[LiveActivity] updateLightingWindow failed:', error);
  }
}

/**
 * Whether native starts or renews a drive itself on a
 * lock-screen Next / Previous, and so needs Settings › Board's Stop driving
 * after choices mirrored. iOS only: its intent lights the wall without JS.
 * Android's notification press reaches JS before anything lights, so JS starts the drive
 * there at the wall's lit confirm (`armNotificationPressDrive`).
 */
export const sessionPresenceMirrorsKeepLighting =
  Platform.OS === 'ios' &&
  sessionPresenceSupportsLightingWindow &&
  typeof liveActivityNative?.updateKeepLightingConfig === 'function';

/**
 * Whether the iOS Lock Screen bulb can stop a drive (`StopDrivingIntent`) on
 * this binary. JS says it adopts that stop through the mirrored settings
 * (`lockScreenStop`), so the bulb offers it only to a JS that will.
 */
export const sessionPresenceSupportsLockScreenDriveStop =
  sessionPresenceMirrorsKeepLighting && liveActivityNative?.supportsLockScreenDriveStop === true;

/**
 * Mirrors Settings › Board's keep-lighting choices for the iOS lock-screen
 * Next / Previous, which open or renew the window natively. `null` clears
 * them. A silent no-op on Android and on a binary that predates it.
 */
export async function updateLiveActivityKeepLightingConfig(
  config: LiveActivityKeepLightingConfig | null,
): Promise<void> {
  if (!sessionPresenceMirrorsKeepLighting) return;
  try {
    await liveActivityNative?.updateKeepLightingConfig?.(config);
  } catch (error) {
    console.warn('[LiveActivity] updateKeepLightingConfig failed:', error);
  }
}

/**
 * The stored drive, read synchronously so the drive store can adopt a
 * lock-screen press before its own timed-drive end check runs. Null on an
 * older binary, when nothing is stored, or when the read fails.
 */
export function readLiveActivityLightingWindow(): LiveActivityLightingWindowSnapshot | null {
  if (!sessionPresenceSupportsLightingWindow) return null;
  try {
    return sessionModule?.getLightingWindow?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * The last iOS Lock Screen press (`getLockScreenPress`), read synchronously by
 * the timed-drive end check so it can wait for a press still on its way to the
 * wall. Null on Android (its press reaches JS before anything lights), on a
 * binary without the stamp, when nothing is stored, or when the read fails.
 */
export function readLiveActivityLockScreenPress(): LiveActivityLockScreenPress | null {
  if (Platform.OS !== 'ios') return null;
  try {
    return liveActivityNative?.getLockScreenPress?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Explicitly marks that the actual React root committed in this process. This
 * is iOS-only and optional so an OTA bundle stays safe on an older binary.
 * Diagnostics must never affect app startup, so native bridge failures no-op.
 */
export async function markLiveActivityIntentReactRootMounted(): Promise<void> {
  try {
    await liveActivityNative?.markIntentReactRootMounted?.();
  } catch {
    // Best-effort diagnostic marker only.
  }
}

/**
 * Atomically consumes eligible previous-process intent markers on iOS. Native
 * owns schema/build/TTL/grace validation and once-only dedupe; JS only reports
 * the already-sanitized records.
 */
export async function consumeInterruptedLiveActivityIntentRuns(): Promise<InterruptedLiveActivityIntentDiagnostic[]> {
  try {
    return (await liveActivityNative?.consumeInterruptedIntentRuns?.()) ?? [];
  } catch {
    return [];
  }
}

export function addWidgetQueueNavigateListener(callback: (event: WidgetQueueNavigateEvent) => void): () => void {
  if (!sessionModule) {
    return () => {};
  }
  const subscription = sessionModule.addListener('queueNavigate', callback);
  return () => subscription.remove();
}

/**
 * iOS: the Lock Screen or Dynamic Island bulb stopped this phone's drive and
 * stored the stop (`getLightingWindow`). The event carries nothing; the
 * listener adopts the stored stop. A no-op on Android and on a binary without
 * the stop.
 */
export function addLockScreenDriveStopListener(callback: () => void): () => void {
  if (!sessionPresenceSupportsLockScreenDriveStop || !liveActivityNative) return () => {};
  const subscription = liveActivityNative.addListener('lockScreenDriveStop', callback);
  return () => subscription.remove();
}

// Android-only: lightbulb taps on the foreground-service notification. Reads
// sessionPresenceNative directly (not the platform-keyed sessionModule) because
// only that module's typed addListener declares the 'boardControl' overload; it
// is null on iOS (where 'LiveActivity' is the live module, driving the
// equivalent through App Intents) and in Expo Go, so this is a safe no-op there.
export function addBoardControlListener(callback: (event: BoardControlEvent) => void): () => void {
  if (!sessionPresenceNative) {
    return () => {};
  }
  const subscription = sessionPresenceNative.addListener('boardControl', callback);
  return () => subscription.remove();
}

export type {
  WidgetQueueNavigateEvent,
  BoardControlEvent,
  InterruptedLiveActivityIntentDiagnostic,
  LiveActivityRestTimerOptions,
  LiveActivityLightingWindowOptions,
  LiveActivityLightingWindowSnapshot,
  LiveActivityKeepLightingConfig,
  LiveActivityLockScreenPress,
};

/** New native binaries only; older OTA hosts do not declare this event. */
export function addWidgetMirrorListener(callback: (event: WidgetMirrorEvent) => void): () => void {
  if (!sessionModule?.supportsMirrorControl) return () => {};
  const subscription = sessionModule.addListener('queueMirror', callback);
  return () => subscription.remove();
}

export async function getPendingWidgetMirror(): Promise<WidgetMirrorEvent | null> {
  return (await liveActivityNative?.getPendingMirror?.()) ?? null;
}

export async function acknowledgeWidgetMirror(sessionId: string, sequence: number): Promise<void> {
  await liveActivityNative?.acknowledgeMirror?.(sessionId, sequence);
}

/**
 * Retires a parked tap that never reached the server. Call it only once this
 * side has acted — replayed it, or judged the slot moved on. Leaving it unacked
 * is what keeps a tap alive across an outage or a cold launch, so never
 * acknowledge one that was merely not actionable yet.
 */
export async function acknowledgeWidgetMirrorRequest(sessionId: string): Promise<void> {
  await liveActivityNative?.acknowledgeMirrorRequest?.(sessionId);
}

export type { WidgetMirrorEvent };
