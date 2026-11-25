import { Platform } from 'react-native';
import type { NativeStackNavigationOptions } from 'expo-router';

/** The spray screens' iPad layout (the photo given the room, a capped form column). */
export function isIpadSprayFlow(): boolean {
  return Platform.OS === 'ios' && Platform.isPad === true;
}

/**
 * The spray screens' options on iPad: the home indicator fades while they edit.
 * No `presentation`: they are plain pushes inside the Boards sheet, as on a
 * phone. A `modal` here presented each one as a card on the Boards card (a
 * sheet on a sheet, docs/mobile/mobile-sheets-vs-routes.md), and a page sheet
 * never covered the screen anyway.
 */
export function sprayFlowScreenOptions(): Pick<NativeStackNavigationOptions, 'autoHideHomeIndicator'> {
  return isIpadSprayFlow() ? { autoHideHomeIndicator: true } : {};
}

/** Centre long form copy inside wide iPad cards. */
export const SPRAY_FORM_MAX_WIDTH = 640;
