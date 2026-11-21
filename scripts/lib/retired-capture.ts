/** Former screenshot deep links now select isolated view stories. */
const STORY_ALIASES: Readonly<Record<string, string>> = {
  'board-view': 'player--lit',
  'board-sheet': 'board-selector--populated',
  'session-detail': 'workout-server-data--detail',
  logbook: 'logbook--populated',
  progress: 'progress--overview',
};

export function migrateCaptureRoute(options: { to: string | null; story: string | null }): void {
  if (!options.to) return;
  const alias = STORY_ALIASES[options.to];
  if (alias && !options.story) {
    options.story = alias;
    options.to = null;
    return;
  }
  if (/[?&]screenshot[A-Z]/.test(options.to)) {
    throw new Error(
      'Screenshot query commands were retired. Use --story climbs--populated or --story player--lit; see docs/mobile/mobile-stories.md.',
    );
  }
}
