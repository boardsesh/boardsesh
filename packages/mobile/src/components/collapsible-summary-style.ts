import { createContext } from 'react';
import type { ViewStyle } from 'react-native';
import type { AnimatedStyle } from 'react-native-reanimated';

/**
 * An animated style for every `CollapsibleSection` summary under it, for a host
 * whose collapsed lines can go stale while the screen moves on: the play drawer
 * hides them while a swipe has changed the climb on screen but the sections
 * still describe the last one. Titles, chevrons and open bodies are untouched.
 * Its own module so a host can provide it without importing the section.
 */
export const CollapsibleSummaryStyleContext = createContext<AnimatedStyle<ViewStyle> | null>(null);
