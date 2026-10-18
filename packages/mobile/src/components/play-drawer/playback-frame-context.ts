import { createContext } from 'react';

/**
 * The frame the board paints on an animated climb, or `null` for a static one.
 * PlayCore provides it around the sections below the climb, and only Active
 * holds reads it, so a playback frame re-renders that one section rather than
 * every section through the memoised DeferredSections.
 */
export const PlaybackFrameContext = createContext<string | null>(null);
