import { Platform } from 'react-native';
import type { NativeStackNavigationOptions } from 'expo-router';

/** iPad editing cards keep the native tab sidebar live behind them. */
export function isIpadSprayFlow(): boolean {
  return Platform.OS === 'ios' && Platform.isPad === true;
}

export function sprayFlowScreenOptions(): Pick<NativeStackNavigationOptions, 'presentation' | 'autoHideHomeIndicator'> {
  return isIpadSprayFlow() ? { presentation: 'modal', autoHideHomeIndicator: true } : {};
}

/** Centre long form copy inside wide iPad cards. */
export const SPRAY_FORM_MAX_WIDTH = 640;
