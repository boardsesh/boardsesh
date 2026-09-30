import { SHOWCASE_FPS, type ShowcaseCalloutName, type ShowcaseTakeId } from './contract';

/**
 * The storyboard, in frames at 30 fps. Scenes are back to back with no gaps;
 * `showcase-video-timeline.test` holds that and the 36–42 s runtime.
 *
 * Backgrounds alternate from the boards scene on, so two busy layouts never
 * meet on the same background. The two dark→dark joins are deliberate: hook →
 * light is a match cut (the motif's rings land on the footage), and log →
 * outro hands a phone scene to the centred end card, which then loops into the
 * hook.
 */
export type ShowcaseSceneId =
  | 'hook'
  | 'light'
  | 'boards'
  | 'wall'
  | 'crew'
  | 'workouts'
  | 'lock-screen'
  | 'log'
  | 'outro';

export type ShowcaseScene = Readonly<{
  id: ShowcaseSceneId;
  startFrame: number;
  endFrame: number;
  background: 'dark' | 'light';
  /**
   * Takes whose footage the scene shows. For the boards pile-up this is the
   * arrival order: the first three rise together, the rest crowd in after.
   */
  takes: readonly ShowcaseTakeId[];
  /** Callouts, in climb-role order (start, hand, finish). Either background. */
  callouts: readonly ShowcaseCalloutName[];
}>;

export const SHOWCASE_SCENES: readonly ShowcaseScene[] = [
  { id: 'hook', startFrame: 0, endFrame: 72, background: 'dark', takes: [], callouts: [] },
  {
    id: 'light',
    startFrame: 72,
    endFrame: 204,
    background: 'dark',
    takes: ['light'],
    callouts: ['wall-pill', 'board-surface'],
  },
  {
    id: 'boards',
    startFrame: 204,
    endFrame: 342,
    background: 'light',
    takes: [
      'boards-kilter',
      'boards-tension',
      'boards-moonboard',
      'boards-woods',
      'boards-decoy',
      'boards-touchstone',
      'boards-grasshopper',
      'boards-soill',
    ],
    callouts: [],
  },
  {
    id: 'wall',
    startFrame: 342,
    endFrame: 507,
    background: 'dark',
    takes: ['wall'],
    callouts: ['board-history-button', 'now-on-wall', 'wall-history'],
  },
  {
    id: 'crew',
    startFrame: 507,
    endFrame: 681,
    background: 'light',
    takes: ['crew'],
    callouts: ['invite-qr', 'queue-row-avatar', 'play-next'],
  },
  { id: 'workouts', startFrame: 681, endFrame: 843, background: 'dark', takes: ['workouts'], callouts: [] },
  // The Dynamic Island scene. Id and take keep their lock-screen names so the
  // recorder and the anchors contract stay put.
  {
    id: 'lock-screen',
    startFrame: 843,
    endFrame: 969,
    background: 'light',
    takes: ['lock-screen'],
    callouts: ['lock-next', 'lock-relight', 'lock-mirror'],
  },
  {
    id: 'log',
    startFrame: 969,
    endFrame: 1119,
    background: 'dark',
    takes: ['log'],
    callouts: ['profile-board-filter', 'activity-calendar'],
  },
  { id: 'outro', startFrame: 1119, endFrame: 1248, background: 'dark', takes: [], callouts: [] },
];

export const SHOWCASE_TOTAL_FRAMES = SHOWCASE_SCENES[SHOWCASE_SCENES.length - 1].endFrame;

/** Frame 0 is the settled hook: the poster, baked in as the first frame. */
export const SHOWCASE_POSTER_FRAME = 0;

/**
 * Scenes the cut can do without. The island scene needs a Live Activity, which
 * the simulator may refuse to start; without its take the scene is dropped and
 * the rest close up.
 */
export const SHOWCASE_SKIPPABLE_SCENES: readonly ShowcaseSceneId[] = ['lock-screen'];

/**
 * Takes the render can do without: any board phone (the pile-up uses however
 * many arrived, at least one) and the takes of a skippable scene.
 */
export const SHOWCASE_OPTIONAL_TAKES: readonly ShowcaseTakeId[] = SHOWCASE_SCENES.filter(
  (scene) => scene.id === 'boards' || SHOWCASE_SKIPPABLE_SCENES.includes(scene.id),
).flatMap((scene) => scene.takes);

export type ShowcaseTimeline = Readonly<{
  scenes: readonly ShowcaseScene[];
  totalFrames: number;
  skipped: readonly ShowcaseSceneId[];
}>;

/**
 * The cut for the footage at hand: a skippable scene whose takes are missing is
 * dropped, the scenes after it move up, and backgrounds are re-alternated from
 * the boards scene on (hook and light stay dark for the match cut, the outro
 * stays dark for the loop), so dropping a scene never puts two busy scenes on
 * one background. With every take present this is `SHOWCASE_SCENES` exactly.
 */
export function resolveTimeline(available: ReadonlySet<ShowcaseTakeId>): ShowcaseTimeline {
  const skipped: ShowcaseSceneId[] = [];
  const kept = SHOWCASE_SCENES.filter((scene) => {
    const missing = SHOWCASE_SKIPPABLE_SCENES.includes(scene.id) && scene.takes.some((take) => !available.has(take));
    if (missing) skipped.push(scene.id);
    return !missing;
  });
  let frame = 0;
  const scenes = kept.map((scene, index): ShowcaseScene => {
    const length = scene.endFrame - scene.startFrame;
    const background =
      index < 2 || index === kept.length - 1 ? scene.background : (index - 2) % 2 === 0 ? 'light' : 'dark';
    const moved = { ...scene, startFrame: frame, endFrame: frame + length, background };
    frame += length;
    return moved;
  });
  return { scenes, totalFrames: frame, skipped };
}

/** Footage asked of a take no scene uses (every take has a scene in this cut). */
export const DEFAULT_TAKE_SECONDS = 6;

/**
 * Seconds of footage each take must supply: the scene's length plus a second of
 * slack either side, because the phone arrives before the scene's text and
 * leaves after it. The recorder's self-check fails a take shorter than this. A
 * take no scene uses gets `DEFAULT_TAKE_SECONDS`.
 */
export function requiredTakeSeconds(takeId: ShowcaseTakeId): number {
  const scene = SHOWCASE_SCENES.find((candidate) => candidate.takes.includes(takeId));
  if (!scene) return DEFAULT_TAKE_SECONDS;
  return (scene.endFrame - scene.startFrame) / SHOWCASE_FPS + 2;
}
