import { Platform } from 'react-native';

/**
 * How long the transparent `/play` modal takes to finish sliding away, matching
 * the native-sheet coordinator's conservative ceilings. Used where no reliable
 * transitionEnd arrives: the player can unmount before react-native-screens
 * reports one, and the covered tab screen never gets one of its own.
 */
export const PLAYER_DISMISS_CEILING_MS = Platform.OS === 'ios' ? 550 : 350;
