import { SHOWCASE_FPS, type ShowcaseCalloutName, type ShowcaseTakeId } from './contract';

/**
 * The storyboard, in frames at 30 fps. Scenes are back to back with no gaps;
 * `timeline.test` holds that and the 18–22 s runtime the brag format asks for.
 * Background alternates so two busy layouts never crossfade.
 */
export type ShowcaseSceneId = 'hook' | 'light' | 'boards' | 'crew' | 'log' | 'outro';

export type ShowcaseScene = Readonly<{
  id: ShowcaseSceneId;
  startFrame: number;
  endFrame: number;
  background: 'dark' | 'light';
  /** Takes whose footage the scene shows, in on-screen order. */
  takes: readonly ShowcaseTakeId[];
  /**
   * Callouts, in climb-role order (start, hand, finish). Allowed on any
   * background: lavender (light) scenes may carry callouts as of the ~40 s cut,
   * which lifted the old dark-scenes-only rule.
   */
  callouts: readonly ShowcaseCalloutName[];
}>;

export const SHOWCASE_SCENES: readonly ShowcaseScene[] = [
  { id: 'hook', startFrame: 0, endFrame: 72, background: 'dark', takes: [], callouts: [] },
  {
    id: 'light',
    startFrame: 72,
    endFrame: 192,
    background: 'dark',
    takes: ['light'],
    callouts: ['wall-pill', 'board-surface'],
  },
  {
    id: 'boards',
    startFrame: 192,
    endFrame: 282,
    background: 'light',
    takes: ['boards-kilter', 'boards-tension', 'boards-moonboard'],
    callouts: [],
  },
  {
    id: 'crew',
    startFrame: 282,
    endFrame: 410,
    background: 'dark',
    takes: ['crew'],
    callouts: ['invite-qr', 'queue-row-avatar', 'play-next'],
  },
  { id: 'log', startFrame: 410, endFrame: 528, background: 'light', takes: ['log'], callouts: [] },
  { id: 'outro', startFrame: 528, endFrame: 657, background: 'dark', takes: [], callouts: [] },
];

export const SHOWCASE_TOTAL_FRAMES = SHOWCASE_SCENES[SHOWCASE_SCENES.length - 1].endFrame;

/** Frame 0 is the settled hook: the poster, baked in as the first frame. */
export const SHOWCASE_POSTER_FRAME = 0;

/** Footage asked of a take no scene uses yet (the storyboard is being rebuilt around the new takes). */
export const DEFAULT_TAKE_SECONDS = 6;

/**
 * Seconds of footage each take must supply: the scene's length plus a second of
 * slack either side, because the phone arrives before the scene's text and
 * leaves after it. The recorder's self-check fails a take shorter than this. A
 * take no scene uses yet gets `DEFAULT_TAKE_SECONDS`.
 */
export function requiredTakeSeconds(takeId: ShowcaseTakeId): number {
  const scene = SHOWCASE_SCENES.find((candidate) => candidate.takes.includes(takeId));
  if (!scene) return DEFAULT_TAKE_SECONDS;
  return (scene.endFrame - scene.startFrame) / SHOWCASE_FPS + 2;
}
