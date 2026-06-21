import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

/**
 * Fonts that must be available before the first visible Android Material frame.
 * Expo vector icons render an empty Text node until their font loads; gating the
 * splash avoids blank toolbar/search icons that only repaint after navigation.
 */
export async function loadRequiredFonts(): Promise<void> {
  await MaterialCommunityIcons.loadFont();
}
