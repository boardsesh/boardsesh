import { Platform } from 'react-native';

/**
 * Conservative wait for the transparent `/play` modal to finish closing, matching
 * the native-sheet coordinator's conservative ceilings. Used where no reliable
 * transitionEnd arrives: the player can unmount before react-native-screens
 * reports one, and the covered tab screen never gets one of its own.
 */
export const PLAYER_DISMISS_CEILING_MS = Platform.OS === 'ios' ? 550 : 350;
