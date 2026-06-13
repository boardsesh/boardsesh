import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTheme } from '../providers/theme-provider';

export type NativeAccessoryPlacement = 'regular' | 'inline';

const DEFAULT_NATIVE_ACCESSORY_PLACEMENT: NativeAccessoryPlacement = 'regular';
let nativeAccessoryPlacement: NativeAccessoryPlacement = DEFAULT_NATIVE_ACCESSORY_PLACEMENT;
const nativeAccessoryPlacementListeners = new Set<() => void>();

function setNativeAccessoryPlacement(nextPlacement: NativeAccessoryPlacement): void {
  if (nativeAccessoryPlacement === nextPlacement) return;
  nativeAccessoryPlacement = nextPlacement;
  for (const listener of nativeAccessoryPlacementListeners) listener();
}

function subscribeNativeAccessoryPlacement(onStoreChange: () => void): () => void {
  nativeAccessoryPlacementListeners.add(onStoreChange);
  return () => {
    nativeAccessoryPlacementListeners.delete(onStoreChange);
  };
}

function getNativeAccessoryPlacementSnapshot(): NativeAccessoryPlacement {
  return nativeAccessoryPlacement;
}

function getNativeAccessoryPlacementServerSnapshot(): NativeAccessoryPlacement {
  return DEFAULT_NATIVE_ACCESSORY_PLACEMENT;
}

/**
 * Whether the device *can* host `NativeTabs.BottomAccessory` — the pure
 * capability check. The native accessory is tied to the system Liquid Glass tab
 * bar, so it only exists on that path.
 */
export function isBottomAccessoryAvailable(): boolean {
  return Platform.OS === 'ios' && NativeTabs?.BottomAccessory != null && isLiquidGlassAvailable();
}

/**
 * Whether the native bottom accessory is actually in use right now: the device
 * supports it AND the user is on the Liquid Glass variant. On the Material
 * variant the JS tab bar replaces `NativeTabs`, so the current climb + tick ride
 * the floating `PersistentQueueBar` instead and this returns false.
 */
export function useNativeAccessoryActive(): boolean {
  const { variant } = useTheme();
  return variant === 'liquidGlass' && isBottomAccessoryAvailable();
}

export function useNativeAccessoryPlacement(): NativeAccessoryPlacement {
  return useSyncExternalStore(
    subscribeNativeAccessoryPlacement,
    getNativeAccessoryPlacementSnapshot,
    getNativeAccessoryPlacementServerSnapshot,
  );
}

export function useReportNativeAccessoryPlacement(placement: NativeAccessoryPlacement): void {
  useEffect(() => {
    setNativeAccessoryPlacement(placement);
    return () => setNativeAccessoryPlacement(DEFAULT_NATIVE_ACCESSORY_PLACEMENT);
  }, [placement]);
}
