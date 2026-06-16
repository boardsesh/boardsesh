import { Platform } from 'react-native';

/**
 * True on iPad. iPadOS lays out the system tab bar — and its Liquid Glass bottom
 * accessory — differently from iPhone: the accessory can land mis-placed and
 * undersized. A few surfaces opt out of the native accessory / edge-to-edge
 * chrome here and use the centered JS treatments instead.
 *
 * Resolved once at module load (the idiom is fixed for the app's lifetime).
 */
export const isIpad = Platform.OS === 'ios' && (Platform as { isPad?: boolean }).isPad === true;
