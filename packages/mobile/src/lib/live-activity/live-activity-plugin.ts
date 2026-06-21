import { Platform } from 'react-native';
import {
  liveActivityNative,
  sessionPresenceNative,
  type LiveActivityStartSessionOptions,
  type LiveActivityUpdateOptions,
  type LiveActivityClimbUpdateOptions,
  type WidgetQueueNavigateEvent,
  type BoardControlEvent,
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

export function addWidgetQueueNavigateListener(callback: (event: WidgetQueueNavigateEvent) => void): () => void {
  if (!sessionModule) {
    return () => {};
  }
  const subscription = sessionModule.addListener('queueNavigate', callback);
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

export type { WidgetQueueNavigateEvent, BoardControlEvent };
